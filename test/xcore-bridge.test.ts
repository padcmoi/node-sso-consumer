import { describe, expect, it, vi } from "vitest";
import { ENV } from "../src/environment.js";
import { createXcoreBridge } from "../src/xcore-bridge.js";
import { PROVIDERS } from "../src/providers.js";
import { API_BASE, aPairing, paired, readOnlyHmac, stubEnvironment, stubHmac, stubProvider } from "./support.js";

const CONFIG_PATH = "/api/v1/sso/consumer/config";
const INSTALL_PATH = "/api/v1/portal/install";

// Which environment a bridge runs against is STATED by the application, so a test
// says it the way a deployment does: one key, no environment variable to stub, and
// nothing global left behind between two tests. Everything here asserts against
// `PROVIDERS.prod`.

/**
 * A bridge on a store that already holds a paired application, which is what every
 * boot after the first one looks like.
 */
const bridgeFor = (provider: ReturnType<typeof stubProvider>, overrides: Partial<Parameters<typeof createXcoreBridge>[0]> = {}) =>
  createXcoreBridge({
    NODE_ENV: "prod",
    provider: { prod: { baseUrl: API_BASE } },
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
    NODE_ENV: "prod",
    provider: { prod: { baseUrl: API_BASE } },
    installToken: { prod: "the-code" },
    live: { enabled: false },
    retry: { attempts: 1, delayMs: 0 },
    di: { hmac, environment: store },
    ...overrides,
  });
  return { bridge, store, hmac };
};

// `provider` is null only when this library is standing down, and none of these
// bridges is: they all say `prod` and they all name a prod endpoint.
const addressesOf = (bridge: ReturnType<typeof createXcoreBridge>) => bridge.provider ?? PROVIDERS.dev;

describe("which environment it is, as the application stated it", () => {
  it("takes the half it was told to take, and not the other", () => {
    const both = {
      provider: { dev: { baseUrl: "https://dev.example:1" }, prod: { baseUrl: "https://prod.example:1" } },
      live: { enabled: false },
      di: { hmac: stubHmac(stubProvider()), environment: paired() },
    };

    expect(createXcoreBridge({ ...both, NODE_ENV: "dev" }).provider?.apiBase).toBe("https://dev.example:1");
    expect(createXcoreBridge({ ...both, NODE_ENV: "prod" }).provider?.apiBase).toBe("https://prod.example:1");
  });

  // The absence of a dev provider is a decision, so it is a state rather than a
  // throw: no pairing, no declaration, no SSO, and the application keeps whatever
  // local login it has.
  it("stands down when it is dev and there is no dev provider", async () => {
    const provider = stubProvider();
    const bridge = createXcoreBridge({
      NODE_ENV: "dev",
      provider: { prod: { baseUrl: API_BASE } },
      installToken: { prod: "the-code" },
      live: { enabled: false },
      di: { hmac: stubHmac(provider), environment: stubEnvironment() },
    });

    expect(bridge.provider).toBeNull();
    expect(await bridge.start()).toBeNull();
    expect(provider.seen).toHaveLength(0);
  });

  // Anything else read as `dev` would be the silent failure this key exists to
  // remove: a production process standing down and offering its local login.
  it("refuses a value that is neither, rather than guessing one", () => {
    expect(() =>
      createXcoreBridge({
        NODE_ENV: "production" as never,
        provider: { prod: { baseUrl: API_BASE } },
        live: { enabled: false },
        di: { hmac: stubHmac(stubProvider()), environment: paired() },
      })
    ).toThrow(/must be "dev" or "prod"/);
  });
});

describe("the addresses it runs against", () => {
  it("takes the API as `baseUrl` and keeps the environment's other three", () => {
    const bridge = bridgeFor(stubProvider());

    expect(addressesOf(bridge).apiBase).toBe(API_BASE);
    expect(addressesOf(bridge).portalUrl).toBe(PROVIDERS.prod.portalUrl);
    expect(addressesOf(bridge).realtimeUrl).toBe(PROVIDERS.prod.realtimeUrl);
  });

  it("lets an object override the lot, for another ecosystem", () => {
    const bridge = bridgeFor(stubProvider(), {
      provider: { prod: { baseUrl: "https://other.example:1", portalUrl: "https://other.example/portal" } },
    });

    expect(addressesOf(bridge).apiBase).toBe("https://other.example:1");
    expect(addressesOf(bridge).portalUrl).toBe("https://other.example/portal");
    expect(addressesOf(bridge).frontUrl).toBe(PROVIDERS.prod.frontUrl);
  });
});

describe("the boot: read, pair if it must, declare", () => {
  const answering = () =>
    stubProvider()
      .on("POST", INSTALL_PATH, { status: 201, body: { data: aPairing() } })
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 204 })
      .global();

  it("exchanges the code when INSTALLED is absent, and records the whole of it", async () => {
    const provider = answering();
    const { bridge, store, hmac } = freshBridge(provider);

    await bridge.start();

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

  it("writes INSTALLED in the SAME save as everything it announces", async () => {
    const { bridge, store } = freshBridge(answering());
    await bridge.start();

    // Written first, a boot falling between the two would believe itself paired
    // holding none of it - and would never try again, since it stops looking at the
    // code.
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

  it("does not even look at the code once INSTALLED is true", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 204 }).global();

    // The code stays in the configuration for the life of the application: what
    // decides is the key, not its presence.
    await bridgeFor(provider, { installToken: { prod: "the-code" } }).start();

    expect(provider.calls("POST", INSTALL_PATH)).toHaveLength(0);
  });

  it("refuses to boot an unpaired application that carries no code, and says where to get one", async () => {
    const { bridge } = freshBridge(stubProvider(), { installToken: undefined });

    await expect(bridge.start()).rejects.toThrow(/not paired and carries no prod install token/);
  });

  // A store that can only be written into by the broker is what every consumer has,
  // and the pairing has to be fine with it: it writes no credential at all.
  it("pairs into a credential store it may not write to", async () => {
    const provider = answering();
    const store = stubEnvironment();
    const bridge = createXcoreBridge({
      NODE_ENV: "prod",
      provider: { prod: { baseUrl: API_BASE } },
      installToken: { prod: "the-code" },
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

    await createXcoreBridge({
      NODE_ENV: "prod",
      provider: { prod: { baseUrl: API_BASE } },
      live: { enabled: false },
      retry: { attempts: 1, delayMs: 0 },
      logger: { warn },
      di: { hmac: stubHmac(provider), environment: store },
    }).start();

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

  const withAccount = (global: string[], isRoot = false) => {
    const req = {
      headers: {},
      me: {
        user: { id: "user-1", email: "reader@example.com", displayName: "Reader", avatarUrl: null },
        profile: {},
        permissions: { global, isRoot, groups: [] },
      },
    };
    return req;
  };

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
