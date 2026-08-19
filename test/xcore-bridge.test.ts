import { describe, expect, it, vi } from "vitest";
import { ENV } from "../src/environment.js";
import { createXcoreBridge } from "../src/xcore-bridge.js";
import { PROVIDERS } from "../src/providers.js";
import { API_BASE, aPairing, paired, readOnlyHmac, stubEnvironment, stubHmac, stubProvider } from "./support.js";

const CONFIG_PATH = "/api/v1/sso/consumer/config";
const INSTALL_PATH = "/api/v1/portal/install";

/**
 * A bridge on a store that already holds a paired application, which is what every
 * boot after the first one looks like.
 */
const bridgeFor = (provider: ReturnType<typeof stubProvider>, overrides: Partial<Parameters<typeof createXcoreBridge>[0]> = {}) =>
  createXcoreBridge({
    environment: "prod",
    provider: API_BASE,
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
    environment: "prod",
    provider: API_BASE,
    installToken: "the-code",
    live: { enabled: false },
    retry: { attempts: 1, delayMs: 0 },
    di: { hmac, environment: store },
    ...overrides,
  });
  return { bridge, store, hmac };
};

describe("the addresses it runs against", () => {
  it("takes the API as a bare string and keeps the environment's other three", () => {
    const bridge = bridgeFor(stubProvider());

    expect(bridge.provider.apiBase).toBe(API_BASE);
    expect(bridge.provider.portalUrl).toBe(PROVIDERS.prod.portalUrl);
    expect(bridge.provider.realtimeUrl).toBe(PROVIDERS.prod.realtimeUrl);
  });

  it("lets an object override the lot, for another ecosystem", () => {
    const bridge = bridgeFor(stubProvider(), {
      provider: { apiBase: "https://other.example:1", portalUrl: "https://other.example/portal" },
    });

    expect(bridge.provider.apiBase).toBe("https://other.example:1");
    expect(bridge.provider.portalUrl).toBe("https://other.example/portal");
    expect(bridge.provider.frontUrl).toBe(PROVIDERS.prod.frontUrl);
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

    // The credential goes to the store that SIGNS with it, never onto the key/value
    // shelf beside a broker password.
    expect(hmac.written).toEqual([{ clientId: "oauth-test", secret: "the-secret" }]);
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
    await bridgeFor(provider, { installToken: "the-code" }).start();

    expect(provider.calls("POST", INSTALL_PATH)).toHaveLength(0);
  });

  it("refuses to boot an unpaired application that carries no code, and says where to get one", async () => {
    const { bridge } = freshBridge(stubProvider(), { installToken: undefined });

    await expect(bridge.start()).rejects.toThrow(/not paired and carries no install token/);
  });

  it("refuses a pairing it has nowhere to write the credential to", async () => {
    const provider = answering();
    const store = stubEnvironment();
    const bridge = createXcoreBridge({
      environment: "prod",
      provider: API_BASE,
      installToken: "the-code",
      live: { enabled: false },
      retry: { attempts: 1, delayMs: 0 },
      di: { hmac: readOnlyHmac(provider), environment: store },
    });

    await expect(bridge.start()).rejects.toThrow(/can only receive a credential/);
    // And nothing was recorded: an application that believed itself paired without a
    // credential would never try again.
    expect(store.held[ENV.INSTALLED]).toBeUndefined();
  });

  // Deleting that key is how an operator signs everyone out at once, so a boot
  // finding it gone mints a new one rather than refusing to start.
  it("mints a session password when the store has lost it", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 204 }).global();
    const store = paired();
    delete store.held[ENV.SSO_SESSION_PASSWORD];
    const warn = vi.fn();

    await createXcoreBridge({
      environment: "prod",
      provider: API_BASE,
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
