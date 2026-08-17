import { describe, expect, it } from "vitest";
import { SsoAuthService } from "../src/auth.service.js";
import { SsoHttpClient } from "../src/http.js";
import { seal } from "../src/session/seal.js";
import { SsoSessionService } from "../src/session/session.service.js";
import { API_BASE, SESSION_PASSWORD, aSession, anAccount, stubHmac, stubJar, stubProvider } from "./support.js";

const SESSION_PATH = "/api/v1/sso/consumer/session";
const ME_PATH = "/api/v1/sso/me";

const serviceFor = (provider: ReturnType<typeof stubProvider>) => {
  const http = new SsoHttpClient({ apiBase: API_BASE, clientId: "oauth-test", hmac: stubHmac(), fetch: provider.fetch });
  const auth = new SsoAuthService({ http, resource: "infrastructure" });
  return new SsoSessionService({ auth, password: SESSION_PASSWORD });
};

const sealedSession = (suffix = "1") =>
  seal(SESSION_PASSWORD, {
    userId: "user-1",
    tokens: {
      accessToken: `access-${suffix}`,
      accessTokenExpiresAt: "",
      refreshToken: `refresh-${suffix}`,
      refreshTokenExpiresAt: "",
    },
  });

describe("starting a sign-in", () => {
  it("mints a state, writes it and hands back where to send the browser", () => {
    const jar = stubJar();
    const url = serviceFor(stubProvider()).start(jar, {
      authorizeUrl: (state) => `https://sso.example.com/authorize?s=${state}`,
    });

    const [written] = jar.writes;
    expect(written.name).toBe("sso_state");
    expect(url).toContain(written.value);
    expect(written.options.httpOnly).toBe(true);
    // `lax` and not `strict`: the cookie has to survive the redirect back from the
    // login window, which is a cross-site navigation.
    expect(written.options.sameSite).toBe("lax");
  });
});

describe("coming back from the login window", () => {
  it("trades the code and seals the pair", async () => {
    const provider = stubProvider().on("POST", SESSION_PATH, { body: { data: aSession() } });
    const jar = stubJar({ sso_state: "the-state" });

    const opened = await serviceFor(provider).complete(jar, { code: "the-code", state: "the-state" });

    expect(opened?.accessToken).toBe("access-1");
    expect(jar.held.get("sso_session")).toBeDefined();
    // Consumed whatever happens: a state read twice is a state replayed.
    expect(jar.cleared).toContain("sso_state");
  });

  it("refuses when the state did not come back with the browser", async () => {
    const provider = stubProvider();
    const jar = stubJar({ sso_state: "the-state" });

    expect(await serviceFor(provider).complete(jar, { code: "the-code", state: "another-state" })).toBeNull();
    expect(provider.seen).toHaveLength(0);
  });

  it("refuses when there is no state at all", async () => {
    expect(await serviceFor(stubProvider()).complete(stubJar(), { code: "the-code", state: "the-state" })).toBeNull();
  });

  it("answers null on a code already spent, which is what refreshing the callback does", async () => {
    const provider = stubProvider().on("POST", SESSION_PATH, { status: 401 });
    const jar = stubJar({ sso_state: "the-state" });

    expect(await serviceFor(provider).complete(jar, { code: "the-code", state: "the-state" })).toBeNull();
  });

  it("raises when the provider is unreachable, which is not a sign-in to start again", async () => {
    const provider = stubProvider().on("POST", SESSION_PATH, { fail: true });
    const jar = stubJar({ sso_state: "the-state" });

    await expect(serviceFor(provider).complete(jar, { code: "the-code", state: "the-state" })).rejects.toMatchObject({
      code: "UNREACHABLE",
    });
  });
});

describe("resolving a request", () => {
  it("answers null with no cookie, without asking anybody", async () => {
    const provider = stubProvider();
    expect(await serviceFor(provider).resolve(stubJar())).toBeNull();
    expect(provider.seen).toHaveLength(0);
  });

  it("answers null on a cookie sealed with another password", async () => {
    const jar = stubJar({ sso_session: seal("another-password-of-32-characters!", { userId: "user-1" }) });
    expect(await serviceFor(stubProvider()).resolve(jar)).toBeNull();
  });

  it("re-seals the cookie when the pair was rotated", async () => {
    const provider = stubProvider()
      .on("GET", ME_PATH, { status: 401 })
      .on("PUT", SESSION_PATH, { body: { data: aSession("2") } })
      .on("GET", ME_PATH, { body: { data: anAccount() } });
    const jar = stubJar({ sso_session: sealedSession() });

    const resolved = await serviceFor(provider).resolve(jar);

    // Rotation spends the token that was presented: without the re-seal, the
    // session dies on the very next call.
    expect(resolved?.tokens.accessToken).toBe("access-2");
    expect(jar.writes.some((entry) => entry.name === "sso_session")).toBe(true);
  });

  it("clears the cookie when the session is over", async () => {
    const provider = stubProvider().on("GET", ME_PATH, { status: 401 }).on("PUT", SESSION_PATH, { status: 401 });
    const jar = stubJar({ sso_session: sealedSession() });

    expect(await serviceFor(provider).resolve(jar)).toBeNull();
    expect(jar.cleared).toContain("sso_session");
  });

  it("leaves the cookie alone when the provider is unreachable", async () => {
    const provider = stubProvider().on("GET", ME_PATH, { fail: true });
    const jar = stubJar({ sso_session: sealedSession() });

    await expect(serviceFor(provider).resolve(jar)).rejects.toMatchObject({ code: "UNREACHABLE" });
    expect(jar.cleared).not.toContain("sso_session");
  });

  it("keeps nothing personal in the cookie", async () => {
    const provider = stubProvider().on("POST", SESSION_PATH, { body: { data: aSession() } });
    const jar = stubJar({ sso_state: "the-state" });

    await serviceFor(provider).complete(jar, { code: "the-code", state: "the-state" });
    const held = serviceFor(provider).read(jar);

    expect(Object.keys(held ?? {})).toEqual(["userId", "tokens"]);
  });
});

describe("ending a session", () => {
  it("closes this application's session and clears its cookie", async () => {
    const provider = stubProvider().on("DELETE", SESSION_PATH, { status: 204 });
    const jar = stubJar({ sso_session: sealedSession() });

    await serviceFor(provider).end(jar);

    expect(provider.calls("DELETE", SESSION_PATH)).toHaveLength(1);
    expect(jar.cleared).toContain("sso_session");
  });

  it("clears the cookie even when the provider refuses the call", async () => {
    const provider = stubProvider().on("DELETE", SESSION_PATH, { status: 500 });
    const jar = stubJar({ sso_session: sealedSession() });

    // A reader who asked to sign out must be signed out here whatever the far side
    // answers: the alternative is a browser still holding a session it was told
    // was closed.
    await serviceFor(provider).end(jar);
    expect(jar.cleared).toContain("sso_session");
  });
});
