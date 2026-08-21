import { describe, expect, it, vi } from "vitest";
import { ENV } from "../src/environment.js";
import { createXcoreBridge } from "../src/xcore-bridge.js";
import { API_BASE, aPairing, paired, readOnlyHmac, stubEnvironment, stubHmac, stubProvider } from "./support.js";

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
    enabled: true,
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
    enabled: true,
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

describe("on, or withdrawn", () => {
  it("does nothing at all when it is off, and does not call that a failure", async () => {
    const provider = stubProvider();
    const bridge = createXcoreBridge({
      enabled: false,
      provider: { baseUrl: API_BASE },
      installToken: "ycsvtsa_the-token",
      di: { hmac: stubHmac(provider), environment: stubEnvironment() },
    });

    const result = await bridge.start();

    // No pairing, no declaration, no probe: the store is not even read.
    expect(provider.seen).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, status: "withdrawn", paired: false, declared: false });
  });

  // What guards a withdrawn application is its own login, so every door stands
  // aside. Refusing instead would make an application that works perfectly answer
  // `403` on every route, or loop its readers into a portal it is not paired with.
  it("lets its guards through when it is off", async () => {
    const bridge = createXcoreBridge({
      enabled: false,
      provider: { baseUrl: API_BASE },
      di: { hmac: stubHmac(stubProvider()), environment: stubEnvironment() },
    });
    await bridge.start();

    const req = { headers: {} };
    const res = { statusCode: 200, getHeader: () => undefined, setHeader: () => undefined, end: () => undefined };

    const passed: string[] = [];
    await bridge.middleware.routes()(req, res, () => passed.push("routes"));
    await bridge.middleware.requireSession()(req, res, () => passed.push("session"));
    await bridge.middleware.requirePermissions("anything")(req, res, () => passed.push("permissions"));

    expect(passed).toEqual(["routes", "session", "permissions"]);
    expect(res.statusCode).toBe(200);
    expect(await bridge.session(req, res)).toBeNull();
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
        enabled: true,
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
      enabled: true,
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
      permissions: { global, isRoot, groups: [] },
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
