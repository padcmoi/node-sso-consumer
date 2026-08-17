import { describe, expect, it } from "vitest";
import { SsoAuthService } from "../src/auth.service.js";
import { SsoHttpClient } from "../src/http.js";
import { API_BASE, aSession, anAccount, stubHmac, stubProvider } from "./support.js";

const SESSION_PATH = "/api/v1/sso/consumer/session";
const ME_PATH = "/api/v1/sso/me";

const authFor = (provider: ReturnType<typeof stubProvider>) => {
  const http = new SsoHttpClient({ apiBase: API_BASE, clientId: "oauth-test", hmac: stubHmac(), fetch: provider.fetch });
  return new SsoAuthService({ http, resource: "infrastructure" });
};

const tokens = { accessToken: "access-1", accessTokenExpiresAt: "", refreshToken: "refresh-1", refreshTokenExpiresAt: "" };

describe("opening a session", () => {
  it("forwards the browser's address, which this call cannot observe for itself", async () => {
    const provider = stubProvider().on("POST", SESSION_PATH, { body: { data: aSession() } });

    await authFor(provider).openSession({ code: "code", clientIp: "203.0.113.7", clientUserAgent: "Firefox" });

    expect(JSON.parse(provider.last()?.body ?? "{}")).toMatchObject({
      code: "code",
      clientIp: "203.0.113.7",
      clientUserAgent: "Firefox",
    });
  });
});

describe("rotating the pair", () => {
  it("spends one refresh token once, however many callers ask at the same time", async () => {
    const provider = stubProvider().on("PUT", SESSION_PATH, { body: { data: aSession("2") } });

    const auth = authFor(provider);
    // A page load fires several requests together, each wanting to spend the same
    // single-use token. Without the dedup, the last answer decides what the
    // session keeps - which is how a session dies under load and nowhere else.
    const [first, second, third] = await Promise.all([
      auth.rotateSession({ refreshToken: "refresh-1" }),
      auth.rotateSession({ refreshToken: "refresh-1" }),
      auth.rotateSession({ refreshToken: "refresh-1" }),
    ]);

    expect(provider.calls("PUT", SESSION_PATH)).toHaveLength(1);
    expect(first.accessToken).toBe("access-2");
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("lets the next caller rotate again once the first one has landed", async () => {
    const provider = stubProvider()
      .on("PUT", SESSION_PATH, { body: { data: aSession("2") } })
      .on("PUT", SESSION_PATH, { body: { data: aSession("3") } });

    const auth = authFor(provider);
    await auth.rotateSession({ refreshToken: "refresh-1" });
    const again = await auth.rotateSession({ refreshToken: "refresh-1" });

    expect(again.accessToken).toBe("access-3");
  });
});

describe("resolving who is calling", () => {
  it("reads the account and leaves the pair alone when it is still good", async () => {
    const provider = stubProvider().on("GET", ME_PATH, { body: { data: anAccount() } });

    const resolved = await authFor(provider).resolve({ tokens });

    expect(resolved?.rotated).toBe(false);
    expect(resolved?.me.user.email).toBe("reader@example.com");
    expect(provider.calls("PUT", SESSION_PATH)).toHaveLength(0);
  });

  it("rotates once on a refusal, then reads again with what came back", async () => {
    const provider = stubProvider()
      .on("GET", ME_PATH, { status: 401 })
      .on("PUT", SESSION_PATH, { body: { data: aSession("2") } })
      .on("GET", ME_PATH, { body: { data: anAccount() } });

    const resolved = await authFor(provider).resolve({ tokens });

    expect(resolved?.rotated).toBe(true);
    expect(resolved?.tokens.accessToken).toBe("access-2");
  });

  it("answers null when the rotation is refused: the session is genuinely over", async () => {
    const provider = stubProvider().on("GET", ME_PATH, { status: 401 }).on("PUT", SESSION_PATH, { status: 401 });

    expect(await authFor(provider).resolve({ tokens })).toBeNull();
  });

  it("answers null when a pair just minted is already refused, which is a revocation", async () => {
    const provider = stubProvider()
      .on("GET", ME_PATH, { status: 401 })
      .on("PUT", SESSION_PATH, { body: { data: aSession("2") } })
      .on("GET", ME_PATH, { status: 403 });

    expect(await authFor(provider).resolve({ tokens })).toBeNull();
  });

  it("raises rather than signing anyone out when the provider cannot be reached", async () => {
    const provider = stubProvider().on("GET", ME_PATH, { fail: true });

    // Swallowing this would sign every reader out on a network hiccup, which looks
    // exactly like a mass revocation.
    await expect(authFor(provider).resolve({ tokens })).rejects.toMatchObject({ code: "UNREACHABLE" });
  });

  it("does not rotate on a refusal that is not about the session", async () => {
    const provider = stubProvider().on("GET", ME_PATH, { status: 500 });

    await expect(authFor(provider).resolve({ tokens })).rejects.toMatchObject({ code: "REFUSED" });
    expect(provider.calls("PUT", SESSION_PATH)).toHaveLength(0);
  });
});

describe("the realtime credentials", () => {
  it("signs the handshake, which is what says WHICH APP is dialling", async () => {
    const headers = await authFor(stubProvider()).realtimeHandshake({ url: "wss://x-core.example.com:13002/realtime" });

    expect(headers["x-client-id"]).toBe("oauth-test");
    expect(headers["x-signature"]).toBeDefined();
  });

  it("puts the account in the first frame, which is what says WHICH USER", () => {
    expect(authFor(stubProvider()).realtimeAuthFrame({ accessToken: "access-1" })).toEqual({
      event: "auth",
      data: { accessToken: "access-1" },
    });
  });
});
