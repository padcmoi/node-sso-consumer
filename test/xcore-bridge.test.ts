import { accountIdOf, type StandInAccount } from "../src/session/local-accounts.js";
import { describe, expect, it, vi } from "vitest";
import { ENV } from "../src/environment.js";
import { createXcoreBridge } from "../src/xcore-bridge.js";
import { seal } from "../src/session/seal.js";
import {
  API_BASE,
  SESSION_PASSWORD,
  aPairing,
  anAccount,
  paired,
  readOnlyHmac,
  stubEnvironment,
  stubHmac,
  stubProvider,
} from "./support.js";

// The credential queue is a broker connection, and a test may not open one. What it
// stands in for is covered where it belongs: `startPropagation` decides on the nine
// values the pairing wrote, and those are asserted below as store contents.
vi.mock("../src/propagation.js", () => ({ startPropagation: vi.fn(() => Promise.resolve(null)) }));

const CONFIG_PATH = "/api/v1/sso/consumer/config";
const INSTALL_PATH = "/api/v1/portal/install";

/**
 * A bridge on a store that already holds a paired application, which is what every
 * boot after the first one looks like.
 */
const bridgeFor = (provider: ReturnType<typeof stubProvider>, overrides: Partial<Parameters<typeof createXcoreBridge>[0]> = {}) =>
  createXcoreBridge({
    mode: "sso",
    provider: { baseUrl: API_BASE },
    // Nothing may open a socket in a test: the accounts are followed on demand.
    live: { enabled: false },
    retry: { attempts: 1, delayMs: 0 },
    di: { hmac: stubHmac(provider), environment: paired() },
    ...overrides,
  });

/** A bridge on an EMPTY store, which is what a first boot looks like. */
const freshBridge = (provider: ReturnType<typeof stubProvider>, overrides: Record<string, unknown> = {}) => {
  const store = stubEnvironment();
  const hmac = stubHmac(provider);
  const bridge = createXcoreBridge({
    mode: "sso",
    provider: { baseUrl: API_BASE },
    installToken: "ycsvtsa_the-token",
    live: { enabled: false },
    retry: { attempts: 1, delayMs: 0 },
    di: { hmac, environment: store },
    ...overrides,
  });
  return { bridge, store, hmac };
};

/** The probe's refusal, then the declaration's `204`. In that order, always. */
const answering = () =>
  stubProvider()
    .on("POST", INSTALL_PATH, { status: 201, body: { data: aPairing() } })
    .on("PUT", CONFIG_PATH, { status: 401 })
    .on("PUT", CONFIG_PATH, { status: 204 })
    .global();

// The hash of "julien", written out rather than computed at import: `hashPassword`
// is scrypt, so computing one here would spend its cost in every run of this file
// for a value that never changes.
const LOCAL: StandInAccount[] = [
  {
    email: "julien@julien.fr",
    passwordHash: "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg$YtynpqNQ8WfUAfUFJ0NsdjFpDxAiDx2VZHa4oO5LRFw",
    firstName: "Julien",
    lastName: "Julien",
    permissions: ["read:user"],
  },
];

/**
 * A directory over an array, which is what a test wants: the library asks for two
 * reads and this answers them without a database.
 *
 * The point of the change it stands for is that the library no longer knows there IS
 * an array. It calls, and something answers - here a closure, in an application a
 * table.
 */
const directory = (accounts: StandInAccount[] = LOCAL) => ({
  findByEmail: (email: string) => accounts.find((held) => held.email.toLowerCase() === email) ?? null,
  findById: (id: string) => accounts.find((held) => accountIdOf(held) === id) ?? null,
});

describe("local, with a directory or without one", () => {
  // Local and lending NOTHING is not a stand-aside: there is no provider to ask and no
  // directory to read, so nobody can ever sign in. Serving what sits behind a guard
  // in that state would hand every protected page to whoever asked.
  it("refuses to serve when it is local and nothing was lent", async () => {
    const provider = stubProvider();
    const bridge = createXcoreBridge({
      mode: "local",
      provider: { baseUrl: API_BASE },
      installToken: "ycsvtsa_the-token",
      di: { hmac: stubHmac(provider), environment: stubEnvironment() },
    });

    const result = await bridge.start();

    // No pairing, no declaration, no probe: nothing is asked of anybody.
    expect(provider.seen).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, status: "not-paired", paired: false, declared: false });
    expect(bridge.serving).toBe(false);
  });

  it("shuts every door when it is local and nothing was lent", async () => {
    const bridge = createXcoreBridge({
      mode: "local",
      provider: { baseUrl: API_BASE },
      di: { hmac: stubHmac(stubProvider()), environment: stubEnvironment() },
    });
    await bridge.start();

    const req = { headers: {} };
    const res = { statusCode: 200, getHeader: () => undefined, setHeader: () => undefined, end: () => undefined };

    const passed: string[] = [];
    await bridge.middleware.requireSession()(req, res, () => passed.push("session"));

    expect(passed).toEqual([]);
    // No portal either - that address arrives with a pairing that never happened.
    expect(res.statusCode).toBe(500);
  });

  // Local WITH a directory is not a degraded mode: real sessions, real guards, and a
  // session shaped exactly as the provider answers one.
  it("stands in for the provider when a directory is lent", async () => {
    const provider = stubProvider();
    const bridge = createXcoreBridge({
      mode: "local",
      provider: { baseUrl: API_BASE },
      di: { hmac: stubHmac(provider), environment: stubEnvironment(), accounts: directory() },
    });

    const result = await bridge.start();

    expect(result).toMatchObject({ ok: true, status: "ready" });
    expect(bridge.serving).toBe(true);
    // Still nothing asked of the provider: there is nothing on the other side.
    expect(provider.seen).toHaveLength(0);
  });

  it("signs a local reader in, and answers the shape the provider answers", async () => {
    const bridge = createXcoreBridge({
      mode: "local",
      provider: { baseUrl: API_BASE },
      di: { hmac: stubHmac(stubProvider()), environment: stubEnvironment(), accounts: directory() },
    });
    await bridge.start();

    const req = { headers: {} };
    const res = { statusCode: 200, getHeader: () => undefined, setHeader: () => undefined, end: () => undefined };

    const me = await bridge.signInLocally(req, res, { email: "JULIEN@julien.fr", password: "julien" });

    // The address folds its case, the password does not.
    expect(me?.user.email).toBe("julien@julien.fr");
    expect(me?.user.displayName).toBe("JULIEN JULIEN");
    // Every field of the real profile is there, `null` where nothing is known: a
    // component reading one renders instead of throwing.
    expect(me?.profile).toMatchObject({ firstname: "Julien", lastname: "Julien", city: null, phone1: null });
    expect(me?.permissions.isRoot).toBe(false);
    expect(me?.permissions.groups[0]?.name).toBe("_sso_user_julien@julien.fr");
    expect(await bridge.signInLocally(req, res, { email: "julien@julien.fr", password: "wrong" })).toBeNull();
  });
});

describe("the addresses, from the one that was written", () => {
  it("derives the login window and the socket from the API base", () => {
    const bridge = bridgeFor(stubProvider(), { provider: { baseUrl: "https://x-core.example.ovh:13001" } });

    expect(bridge.provider.apiBase).toBe("https://x-core.example.ovh:13001");
    // The login window lives on the same names WITHOUT the port - which is exactly
    // the mistake `baseUrl` invites, and why the boot probes the address.
    expect(bridge.provider.frontUrl).toBe("https://x-core.example.ovh");
    // One port further, which is x-core's own layout: `3002` beside `3001`.
    expect(bridge.provider.realtimeUrl).toBe("wss://x-core.example.ovh:13002/realtime");
  });

  it("lets a deployment name any of them, for a stack laid out differently", () => {
    const bridge = bridgeFor(stubProvider(), {
      provider: { baseUrl: API_BASE, frontUrl: "https://login.example", realtimeUrl: "wss://rt.example/realtime" },
    });

    expect(bridge.provider.frontUrl).toBe("https://login.example");
    expect(bridge.provider.realtimeUrl).toBe("wss://rt.example/realtime");
  });

  // Carried, it fails inside a signature as a `401` that reads like a credential
  // problem, three files from the value that caused it.
  it("refuses a base that is not an address", () => {
    expect(() =>
      createXcoreBridge({
        mode: "sso",
        provider: { baseUrl: "x-core.example.ovh" },
        di: { hmac: stubHmac(stubProvider()), environment: paired() },
      })
    ).toThrow(/is not an address/);
  });

  // The portal is x-core's own front and x-core is what knows where it is served, so
  // it is read THROUGH the store rather than captured when the bridge is built.
  it("takes the portal from what the pairing wrote", async () => {
    const store = paired({ [ENV.SSO_PORTAL_URL]: "https://portal.example/" });
    const bridge = bridgeFor(stubProvider(), {
      provider: { baseUrl: API_BASE, portalUrl: "https://written-down.example/" },
      di: { hmac: stubHmac(stubProvider()), environment: store },
    });

    expect(bridge.portalUrl).toBe("https://written-down.example/");
    await bridge.load();
    expect(bridge.portalUrl).toBe("https://portal.example/");
  });
});

describe("the boot: read, pair if it must, open the queue, declare", () => {
  it("exchanges the token when INSTALLED is absent, and records the whole of it", async () => {
    const provider = answering();
    const { bridge, store, hmac } = freshBridge(provider);

    const result = await bridge.start();

    expect(result).toMatchObject({ ok: true, status: "ready", paired: true, declared: true });
    // NOTHING is written into the credential store here, and that is not an
    // omission. x-core keeps `hashClientSecret(secret, pepper)` and verifies against
    // that; the pepper never travels, so an application that hashed the secret this
    // answer carries would store something else and collect a `401` on every call
    // while holding the right secret. What signs is the hash x-core computed, and it
    // only ever arrives on the propagation queue.
    expect(hmac.written).toEqual([]);
    expect(provider.calls("POST", INSTALL_PATH)).toHaveLength(1);

    expect(store.held[ENV.INSTALLED]).toBe(true);
    expect(store.held[ENV.SSO_CLIENT_ID]).toBe("oauth-test");
    expect(store.held[ENV.SSO_SESSION_COOKIE_NAME]).toBe("sso_oauth_test");
    expect(store.held[ENV.RABBITMQ_PASSWORD]).toBe("broker-password");
    expect(store.held[ENV.RABBITMQ_PORT]).toBe(5671);
    // Minted here and never received: two applications sharing it could open each
    // other's cookies.
    expect(String(store.held[ENV.SSO_SESSION_PASSWORD]).length).toBeGreaterThanOrEqual(32);
  });

  it("presents the token unsigned, in a header, with no body", async () => {
    const provider = answering();
    const { bridge } = freshBridge(provider);

    await bridge.start();

    const [install] = provider.calls("POST", INSTALL_PATH);
    // The one unsigned call of this whole library: what it collects is the very
    // credential a signature would be built from.
    expect(install.clientId).toBeUndefined();
    expect(install.headers["x-install-token"]).toBe("ycsvtsa_the-token");
    // No body, and that is the shape of the contract: an application still able to
    // send its own callback URL would be one able to point somebody else's
    // installation at itself.
    expect(JSON.parse(install.body ?? "null")).toEqual({});
  });

  it("writes INSTALLED in the SAME save as everything it announces", async () => {
    const { bridge, store } = freshBridge(answering());
    await bridge.start();

    // Written first, a boot falling between the two would believe itself paired
    // holding none of it - and would never try again, since it stops looking at the
    // token.
    const pairing = store.saves.find((values) => ENV.INSTALLED in values);
    expect(pairing?.[ENV.SSO_CLIENT_ID]).toBe("oauth-test");
    expect(pairing?.[ENV.HMAC_PROPAGATION_SECRET]).toBe("prop-secret");
  });

  it("declares nothing of its own: what it sends back is what the store holds", async () => {
    const provider = answering();
    const { bridge } = freshBridge(provider);

    await bridge.start();

    const [, declared] = provider.calls("PUT", CONFIG_PATH);
    expect(JSON.parse(declared.body ?? "{}")).toEqual({
      redirectUri: "https://app.example.com/api/auth/sso/callback",
      cancelUri: "https://app.example.com/",
      template: "gestionpratique",
      dependGlobalRessource: ["infrastructure"],
    });
  });

  it("does not even look at the token once INSTALLED is true", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 204 }).global();

    // The token stays in the configuration for the life of the application: what
    // decides is the key, not its presence.
    await bridgeFor(provider, { installToken: "ycsvtsa_the-token" }).start();

    expect(provider.calls("POST", INSTALL_PATH)).toHaveLength(0);
  });

  // The whole reason `start()` answers rather than throws: an application whose
  // token was refused stands up, says so in one line, and is repaired by a value in
  // a configuration rather than by a container that will not stay alive.
  it("stands up and says so when there is no token to exchange", async () => {
    const error = vi.fn();
    const { bridge } = freshBridge(stubProvider(), { installToken: undefined, logger: { error } });

    const result = await bridge.start();

    expect(result).toMatchObject({ ok: false, status: "not-paired", paired: false, declared: false });
    expect(result.reason).toMatch(/carries no install token/);
    expect(error).toHaveBeenCalled();
    expect(bridge.serving).toBe(false);
  });

  // Unknown, withdrawn, expired, already redeemed, or still a draft - a form
  // somebody left half finished, with no queue, no broker account and no credential
  // behind it. x-core's own words are what an operator needs, so they travel.
  it("repeats the provider's own words when a token is refused", async () => {
    const provider = stubProvider()
      .on("POST", INSTALL_PATH, {
        status: 409,
        body: { message: "This install token carries no reservation: delete it and mint a new one" },
      })
      .global();
    const { bridge } = freshBridge(provider);

    const result = await bridge.start();

    expect(result.status).toBe("not-paired");
    expect(result.reason).toContain("carries no reservation");
    // Nothing was declared, and nothing was written: the store is as it was.
    expect(provider.calls("PUT", CONFIG_PATH)).toHaveLength(0);
  });

  // The login window answers `204` to anything it does not know, so an application
  // pointed at it declares itself "successfully" at every boot with nothing on the
  // other side. Only a `401` proves the far side checks signatures at all.
  it("declares nothing to an address that does not refuse an unsigned call", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 204 }).global();

    const result = await bridgeFor(provider).start();

    expect(result).toMatchObject({ ok: false, status: "not-declared", paired: true });
    expect(result.reason).toMatch(/does not point at the SSO provider/);
    // The probe, and nothing after it.
    expect(provider.calls("PUT", CONFIG_PATH)).toHaveLength(1);
  });

  // A store that can only be written into by the broker is what every consumer has,
  // and the pairing has to be fine with it: it writes no credential at all.
  it("pairs into a credential store it may not write to", async () => {
    const provider = answering();
    const store = stubEnvironment();
    const bridge = createXcoreBridge({
      mode: "sso",
      provider: { baseUrl: API_BASE },
      installToken: "ycsvtsa_the-token",
      live: { enabled: false },
      retry: { attempts: 1, delayMs: 0 },
      di: { hmac: readOnlyHmac(provider), environment: store },
    });

    await bridge.start();

    expect(store.held[ENV.INSTALLED]).toBe(true);
    expect(store.held[ENV.HMAC_AMQP_QUEUE]).toBe("app-prod");
  });

  // Deleting that key is how an operator signs everyone out at once, so a boot
  // finding it gone mints a new one rather than refusing to start.
  it("mints a session password when the store has lost it", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 204 }).global();
    const store = paired();
    delete store.held[ENV.SSO_SESSION_PASSWORD];
    const warn = vi.fn();

    await bridgeFor(provider, { logger: { warn }, di: { hmac: stubHmac(provider), environment: store } }).start();

    expect(String(store.held[ENV.SSO_SESSION_PASSWORD]).length).toBeGreaterThanOrEqual(32);
    expect(warn).toHaveBeenCalled();
  });

  // Election belongs to the deployment, not here: this library knows nothing of PM2,
  // of how many workers there are, or of how they are numbered. What every worker
  // still needs is what it signs as.
  it("loads the environment without declaring, for a worker that was not elected", async () => {
    const provider = stubProvider();
    const bridge = bridgeFor(provider);

    await bridge.load();

    expect(bridge.environment[ENV.SSO_CLIENT_ID]).toBe("oauth-test");
    expect(provider.seen).toHaveLength(0);
  });
});

describe("the rights, read off what the provider answered", () => {
  // Loaded first, always: the resource this application IS comes from the gate it
  // declares, and the gate comes from the store. Nothing here can be answered by a
  // bridge that has not read it.
  const loaded = async () => {
    const bridge = bridgeFor(stubProvider());
    await bridge.load();
    return bridge;
  };

  const withAccount = (global: string[], isRoot = false) => ({
    headers: {},
    me: {
      user: { id: "user-1", email: "reader@example.com", displayName: "Reader", avatarUrl: null },
      profile: {},
      permissions: { global, isRoot, groups: [], portail: [] },
    },
  });

  it("lists this application's actions without their prefix", async () => {
    const bridge = await loaded();
    const req = withAccount(["core:access", "infrastructure:access", "infrastructure:view-queues"]);

    expect(bridge.actions(req)).toEqual(["access", "view-queues"]);
    // A right granted on another application stays in `permissions()` and is
    // invisible above, on purpose.
    expect(bridge.permissions(req)?.global).toContain("core:access");
  });

  it("takes the resource from the gate it already declares, rather than naming it twice", async () => {
    expect((await loaded()).auth.permissions.resource).toBe("infrastructure");
  });

  it("answers the booleans a screen hides its buttons with", async () => {
    const bridge = await loaded();
    const req = withAccount(["infrastructure:view-queues", "infrastructure:manage-queues"]);

    expect(bridge.can(req, "view-queues")).toBe(true);
    expect(bridge.can(req, "delete-queues")).toBe(false);
    expect(bridge.canAll(req, "view-queues", "manage-queues")).toBe(true);
    expect(bridge.canAny(req, "delete-queues", "view-queues")).toBe(true);
  });

  it("refuses, naming what is missing", async () => {
    const bridge = await loaded();

    expect(() => bridge.assert(withAccount(["infrastructure:view-queues"]), "delete-queues")).toThrow(
      "Missing infrastructure:delete-queues"
    );
  });

  it("refuses a request with no session rather than reading nothing as everything", async () => {
    const bridge = await loaded();

    expect(bridge.can({ headers: {} }, "view-queues")).toBe(false);
    expect(bridge.actions({ headers: {} })).toEqual([]);
    expect(bridge.permissions({ headers: {} })).toBeNull();
  });
});

/**
 * The door: who may be here at all, and for how long an answer to that is worth
 * anything.
 *
 * Both cases here were live faults on a paired application. A session ended from the
 * portal's sign-ins screen left every page of the consuming app open for five more
 * minutes, and an account that lost the application's own `access` went on browsing
 * it - because the bridge answered its guards from what the socket had last pushed
 * instead of asking, and no signal exists that would have corrected either.
 */
describe("the door, asked of the provider and asked every time", () => {
  const ME_PATH = "/api/v1/sso/me";
  const SESSION_PATH = "/api/v1/sso/consumer/session";

  /** A request carrying a session this application sealed itself. */
  const signedIn = () => ({
    method: "GET",
    url: "/",
    headers: {
      cookie: `sso_oauth_test=${encodeURIComponent(
        seal(SESSION_PASSWORD, {
          userId: "user-1",
          tokens: { accessToken: "access-1", accessTokenExpiresAt: "", refreshToken: "refresh-1", refreshTokenExpiresAt: "" },
        })
      )}`,
    },
  });

  /** Somewhere for a cleared cookie to land, on the shape the library writes to. */
  const collecting = () => {
    const headers = new Map<string, number | string | string[]>();
    return {
      statusCode: 200,
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: number | string | string[]) => headers.set(name, value),
      end: () => undefined,
      cookies: () => {
        const held = headers.get("Set-Cookie");
        return Array.isArray(held) ? held : [];
      },
    };
  };

  const loaded = async (provider: ReturnType<typeof stubProvider>) => {
    const bridge = bridgeFor(provider);
    await bridge.load();
    return bridge;
  };

  /** An account, and what the provider says THIS application requires of it. */
  const requiring = (portail: string[], global: string[], isRoot = false) => ({
    ...anAccount(global, isRoot),
    permissions: { ...anAccount(global, isRoot).permissions, portail },
  });

  it("asks the provider on every read: nothing is answered from what was pushed before", async () => {
    // Three answers queued for three reads, and it is the assertion: an answer left
    // unconsumed would be a read this bridge served on its own word.
    const provider = stubProvider()
      .on("GET", ME_PATH, { body: { data: anAccount() } })
      .on("GET", ME_PATH, { body: { data: anAccount() } })
      .on("GET", ME_PATH, { body: { data: anAccount() } })
      .global();
    const bridge = await loaded(provider);

    await bridge.sessionOf(signedIn(), collecting());
    await bridge.sessionOf(signedIn(), collecting());
    await bridge.sessionOf(signedIn(), collecting());

    // Three reads, three questions. A held view answering any of them is a session
    // the provider may already have ended, served on this application's own word.
    expect(provider.calls("GET", ME_PATH)).toHaveLength(3);
  });

  it("ends the session of an account that does not hold what this application requires", async () => {
    // Signed in, answered for, holding rights - just not the one this application
    // demands. `portail` is the provider's own answer for THIS application, so the
    // whole door is: does `global` contain all of it.
    const provider = stubProvider()
      .on("GET", ME_PATH, { body: { data: requiring(["factures_edl:access"], ["infrastructure:view-queues"]) } })
      .global();
    const bridge = await loaded(provider);
    const res = collecting();

    expect(await bridge.sessionOf(signedIn(), res)).toBeNull();
    // Cleared, not merely refused: a cookie that opens nothing is a reader sent to
    // the portal by every page without ever being told the session is over.
    expect(res.cookies().some((cookie) => cookie.startsWith("sso_oauth_test=;"))).toBe(true);
  });

  it("admits an account holding every entry, and refuses one short of a single entry", async () => {
    const both = ["edl:access", "factures_edl:access"];
    const provider = stubProvider()
      .on("GET", ME_PATH, { body: { data: requiring(both, [...both, "core:access"]) } })
      .on("GET", ME_PATH, { body: { data: requiring(both, ["edl:access", "core:access"]) } })
      .global();
    const bridge = await loaded(provider);

    // ALL of them, never any of them: an application asking for two rights is
    // asking for two, and holding one is not being let in.
    expect(await bridge.sessionOf(signedIn(), collecting())).not.toBeNull();
    expect(await bridge.sessionOf(signedIn(), collecting())).toBeNull();
  });

  it("lets root through, on the catalogue the provider answers it", async () => {
    // No exception anywhere: root is answered the whole catalogue in `global`, so
    // the subset holds by construction on both ends of the wire.
    const provider = stubProvider()
      .on("GET", ME_PATH, { body: { data: requiring(["factures_edl:access"], ["factures_edl:access"], true) } })
      .global();

    expect(await (await loaded(provider)).sessionOf(signedIn(), collecting())).not.toBeNull();
  });

  it("opens the door for everybody when this application requires nothing", async () => {
    const provider = stubProvider()
      .on("GET", ME_PATH, { body: { data: requiring([], []) } })
      .global();

    // An empty `portail` is the common case - an application that declares no
    // requirement, and one that gates itself. Refusing here would shut out every
    // account of every application in the ecosystem.
    expect(await (await loaded(provider)).sessionOf(signedIn(), collecting())).not.toBeNull();
  });

  it("requires nothing of a provider too old to answer `portail` at all", async () => {
    const account = anAccount(["infrastructure:view-queues"]);
    const provider = stubProvider()
      .on("GET", ME_PATH, { body: { data: account } })
      .global();

    // Absent reads as empty, and only here. A provider that predates the key demands
    // nothing by saying nothing; refusing would shut every door against every x-core
    // not yet upgraded.
    expect(await (await loaded(provider)).sessionOf(signedIn(), collecting())).not.toBeNull();
  });

  it("sends a reader whose session was ended at the portal away on the very next read", async () => {
    // What a revocation looks like from here: the pair is refused, and the rotation
    // meant to tell an expiry apart from it is refused too.
    const provider = stubProvider().on("GET", ME_PATH, { status: 401 }).on("PUT", SESSION_PATH, { status: 401 }).global();

    expect(await (await loaded(provider)).sessionOf(signedIn(), collecting())).toBeNull();
  });
});
