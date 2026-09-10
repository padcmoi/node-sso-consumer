import { describe, expect, it, vi } from "vitest";
import { createXcoreBridge } from "../src/xcore-bridge.js";
import { seal } from "../src/session/seal.js";
import { API_BASE, SESSION_PASSWORD, aSession, anAccount, paired, stubHmac, stubProvider } from "./support.js";

// The credential queue is a broker connection, and a test may not open one.
vi.mock("../src/propagation.js", () => ({ startPropagation: vi.fn(() => Promise.resolve(null)) }));

const ACTIVITY_PATH = "/api/v1/sso/consumer/activity";
const ME_PATH = "/api/v1/sso/me";

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** What was said about a publication, apart from whatever the boot says on its own. */
const aboutActivity = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.filter(([message]) => typeof message === "string" && message.includes("activity"));

const bridgeFor = (provider: ReturnType<typeof stubProvider>, overrides: Partial<Parameters<typeof createXcoreBridge>[0]> = {}) =>
  createXcoreBridge({
    mode: "sso",
    provider: { baseUrl: API_BASE },
    live: { enabled: false },
    retry: { attempts: 1, delayMs: 0 },
    di: { hmac: stubHmac(provider), environment: paired() },
    ...overrides,
  });

const loaded = async (
  provider: ReturnType<typeof stubProvider>,
  overrides: Partial<Parameters<typeof createXcoreBridge>[0]> = {}
) => {
  const bridge = bridgeFor(provider, overrides);
  await bridge.load();
  return bridge;
};

/** A request from a browser, as the relay in front hands it over. */
const fromBrowser = (extra: Record<string, unknown> = {}) => ({
  method: "POST",
  url: "/api/invoices/42/pay",
  headers: { "x-forwarded-for": "90.116.244.74, 10.0.0.2", "user-agent": "Mozilla/5.0 (X11; Linux x86_64)" },
  ...extra,
});

/** The same request, behind a guard that has just proven the session. */
const guarded = () => fromBrowser({ ssoTokens: aSession("guarded") });

/** The same request, carrying only the sealed cookie: nothing has resolved it yet. */
const cookieOnly = () =>
  fromBrowser({
    headers: {
      "x-forwarded-for": "90.116.244.74",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64)",
      cookie: `sso_oauth_test=${encodeURIComponent(
        seal(SESSION_PASSWORD, {
          userId: "user-1",
          tokens: { accessToken: "access-1", accessTokenExpiresAt: "", refreshToken: "refresh-1", refreshTokenExpiresAt: "" },
        })
      )}`,
    },
  });

const response = () => {
  const headers = new Map<string, number | string | readonly string[]>();
  return {
    statusCode: 200,
    getHeader: (name: string) => {
      const held = headers.get(name);
      return typeof held === "object" ? [...held] : held;
    },
    setHeader: (name: string, value: number | string | readonly string[]) => headers.set(name, value),
    end: () => undefined,
  };
};

const PAID = {
  action: "invoice.paid",
  label: "Paid invoice F-2026-042",
  entity: { type: "invoice", id: 42, label: "F-2026-042" },
  details: { amount: 1200 },
};

const bodyOf = (provider: ReturnType<typeof stubProvider>) => {
  const [call] = provider.calls("POST", ACTIVITY_PATH);
  const parsed: unknown = JSON.parse(call?.body ?? "{}");
  return parsed;
};

describe("publishing what a reader did", () => {
  it("sends the activity with the guard's token and the browser's address, signed as this application", async () => {
    const provider = stubProvider().on("POST", ACTIVITY_PATH, { status: 201, body: { data: { published: true } } });
    const bridge = await loaded(provider);

    const result = await bridge.activity.publish(guarded(), response(), PAID);

    expect(result).toEqual({ published: true });
    expect(bodyOf(provider)).toEqual({
      accessToken: "access-guarded",
      ...PAID,
      clientIp: "90.116.244.74",
      clientUserAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    });
    expect(provider.calls("POST", ACTIVITY_PATH)[0]?.clientId).toBe("oauth-test");
  });

  // Behind a guard the pair was proven a moment ago, in this very request: asking
  // the provider again would only cost a round trip.
  it("does not ask the provider who the reader is when the guard already did", async () => {
    const provider = stubProvider().on("POST", ACTIVITY_PATH, { status: 201 });
    const bridge = await loaded(provider);

    await bridge.activity.publish(guarded(), response(), PAID);

    expect(provider.calls("GET", ME_PATH)).toHaveLength(0);
  });

  it("resolves the session itself when nothing has, and publishes under it", async () => {
    const provider = stubProvider()
      .on("GET", ME_PATH, { body: { data: anAccount() } })
      .on("POST", ACTIVITY_PATH, { status: 201 });
    const bridge = await loaded(provider);

    const result = await bridge.activity.publish(cookieOnly(), response(), { action: "note.shared" });

    expect(result).toEqual({ published: true });
    expect(provider.calls("GET", ME_PATH)).toHaveLength(1);
    expect(bodyOf(provider)).toMatchObject({ accessToken: "access-1", action: "note.shared" });
  });

  it("publishes nothing, and asks nothing, without a session", async () => {
    const provider = stubProvider();
    const bridge = await loaded(provider);

    expect(await bridge.activity.publish(fromBrowser(), response(), PAID)).toEqual({ published: false });
    expect(provider.seen).toHaveLength(0);
  });

  it("carries the other account an activity concerns", async () => {
    const provider = stubProvider().on("POST", ACTIVITY_PATH, { status: 201 });
    const bridge = await loaded(provider);

    await bridge.activity.publish(guarded(), response(), { action: "member.removed", subjectId: "user-2" });

    expect(bodyOf(provider)).toMatchObject({ action: "member.removed", subjectId: "user-2" });
  });
});

// A journal must not fail the gesture it describes: the invoice was paid whether
// or not the line was written.
describe("never a throw into the application", () => {
  it("answers false when x-core refuses, leaving the log line to the transport", async () => {
    const provider = stubProvider().on("POST", ACTIVITY_PATH, { status: 400, body: { message: "reserved prefix" } });
    const log = logger();
    const bridge = await loaded(provider, { logger: log });

    expect(await bridge.activity.publish(guarded(), response(), { action: "auth.login" })).toEqual({ published: false });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining(`POST ${ACTIVITY_PATH} answered 400`));
    expect(aboutActivity(log.warn)).toHaveLength(0);
  });

  it("answers false on a token x-core no longer honours", async () => {
    const provider = stubProvider().on("POST", ACTIVITY_PATH, { status: 401 });
    const bridge = await loaded(provider);

    expect(await bridge.activity.publish(guarded(), response(), PAID)).toEqual({ published: false });
  });

  it("answers false, and says why, when x-core cannot be reached", async () => {
    const provider = stubProvider().on("POST", ACTIVITY_PATH, { fail: true });
    const log = logger();
    const bridge = await loaded(provider, { logger: log });

    expect(await bridge.activity.publish(guarded(), response(), PAID)).toEqual({ published: false });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('activity "invoice.paid" was not published'));
  });

  it("answers false when the session cannot even be resolved", async () => {
    const provider = stubProvider();
    const log = logger();
    // Never loaded: nothing is paired, so asking who the reader is throws.
    const bridge = bridgeFor(provider, { logger: log });

    expect(await bridge.activity.publish(cookieOnly(), response(), PAID)).toEqual({ published: false });
    expect(provider.seen).toHaveLength(0);
    expect(aboutActivity(log.warn)).toHaveLength(1);
  });
});

describe("local", () => {
  // Only the provider keeps a journal, and standing in there is no provider.
  it("publishes nothing and calls nothing", async () => {
    const provider = stubProvider();
    const bridge = bridgeFor(provider, { mode: "local" });

    expect(await bridge.activity.publish(guarded(), response(), PAID)).toEqual({ published: false });
    expect(provider.seen).toHaveLength(0);
  });
});
