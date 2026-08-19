import { describe, expect, it, vi } from "vitest";
import { createXcoreBridge } from "../src/xcore-bridge.js";
import { PROVIDERS } from "../src/providers.js";
import { API_BASE, SESSION_PASSWORD, readOnlyHmac, stubHmac, stubProvider } from "./support.js";

const CONFIG_PATH = "/api/v1/sso/consumer/config";
const INSTALL_PATH = "/api/v1/portal/install";

const consumer = {
  redirectUri: "https://app.example.com/api/auth/sso/callback",
  cancelUri: "https://app.example.com/",
  dependGlobalRessource: ["infrastructure"],
};

const bridgeFor = (provider: ReturnType<typeof stubProvider>, overrides: Partial<Parameters<typeof createXcoreBridge>[0]> = {}) =>
  createXcoreBridge({
    clientId: "oauth-test",
    hmac: stubHmac(),
    environment: "prod",
    provider: API_BASE,
    consumer,
    session: { password: SESSION_PASSWORD },
    // Nothing may open a socket in a test: the accounts are followed on demand.
    live: { enabled: false },
    fetch: provider.fetch,
    retry: { attempts: 1, delayMs: 0 },
    ...overrides,
  });

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

describe("booting", () => {
  it("declares, and proves the address before it does", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 204 });

    await bridgeFor(provider).start();

    expect(provider.calls("PUT", CONFIG_PATH)).toHaveLength(2);
  });

  it("pairs first when a code was given and the store is empty, then declares", async () => {
    const provider = stubProvider()
      .on("POST", INSTALL_PATH, { status: 201, body: { data: { clientId: "oauth-test", secret: "the-secret" } } })
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 204 });
    const hmac = stubHmac(null);

    await bridgeFor(provider, { hmac, installToken: "the-code" }).start();

    expect(hmac.written).toEqual([{ clientId: "oauth-test", secret: "the-secret" }]);
    expect(provider.calls("POST", INSTALL_PATH)).toHaveLength(1);
  });

  it("declares nothing when it redeems: the code carries the whole installation", async () => {
    const provider = stubProvider()
      .on("POST", INSTALL_PATH, { status: 201, body: { data: { clientId: "oauth-test", secret: "s" } } })
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 204 });

    await bridgeFor(provider, { hmac: stubHmac(null), installToken: "the-code" }).start();

    // An empty body, on purpose: the identity, the callback and the queue were all
    // decided when the code was minted. An application able to send its own
    // callback URL here would be able to point somebody else's installation at
    // itself.
    expect(JSON.parse(provider.calls("POST", INSTALL_PATH)[0].body ?? "{}")).toEqual({});
  });

  // The code comes off a screen and is read once: an application that gets it from
  // a prompt or a secret store passes it in rather than putting it in a config.
  it("takes the pairing code as an argument, and prefers it over the configured one", async () => {
    const provider = stubProvider()
      .on("POST", INSTALL_PATH, { status: 201, body: { data: { clientId: "oauth-test", secret: "s" } } })
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 204 });

    await bridgeFor(provider, { hmac: stubHmac(null), installToken: "the-config-one" }).start("the-typed-one");

    expect(provider.calls("POST", INSTALL_PATH)[0].headers["x-install-token"]).toBe("the-typed-one");
  });

  it("refuses to install with no code at all: an empty one is an env that never got set", async () => {
    const provider = stubProvider();

    await expect(bridgeFor(provider, { hmac: stubHmac(null) }).install("  ")).rejects.toThrow(/needs the pairing code/);
    expect(provider.calls("POST", INSTALL_PATH)).toHaveLength(0);
  });

  it("installs from an argument alone, with nothing in the config", async () => {
    const provider = stubProvider().on("POST", INSTALL_PATH, {
      status: 201,
      body: { data: { clientId: "oauth-test", secret: "s" } },
    });

    const paired = await bridgeFor(provider, { hmac: stubHmac(null) }).install("the-typed-one");

    expect(paired).toMatchObject({ clientId: "oauth-test", secret: "s" });
  });

  it("refuses a code minted for another identity", async () => {
    const provider = stubProvider().on("POST", INSTALL_PATH, {
      status: 201,
      body: { data: { clientId: "oauth-somebody-else", secret: "s" } },
    });

    // Installs cleanly, then signs as somebody it is not - which surfaces as a 401
    // on every later call, hours away, naming neither cause.
    await expect(bridgeFor(provider, { hmac: stubHmac(null), installToken: "the-code" }).start()).rejects.toThrow(
      /minted for 'oauth-somebody-else'/
    );
  });

  it("does not spend the code again once a credential is in the store", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 204 });

    // Pairing twice is not a repair: the code is single-use and the second attempt
    // is refused. This check is what makes `start()` safe to leave in place.
    await bridgeFor(provider, { installToken: "the-code" }).start();

    expect(provider.calls("POST", INSTALL_PATH)).toHaveLength(0);
  });

  it("refuses a pairing code it has nowhere to write the credential to", async () => {
    const provider = stubProvider();

    await expect(bridgeFor(provider, { hmac: readOnlyHmac(null), installToken: "the-code" }).start()).rejects.toThrow(
      /cannot write a credential/
    );
  });

  it("does nothing at all when another worker won the election", async () => {
    const provider = stubProvider();
    const elect = vi.fn(() => false);

    expect(await bridgeFor(provider, { installToken: "code", bootstrap: { elect } }).start()).toBeNull();
    expect(elect).toHaveBeenCalledOnce();
    expect(provider.seen).toHaveLength(0);
  });
});

describe("the rights, read off what the provider answered", () => {
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

  it("lists this application's actions without their prefix", () => {
    const bridge = bridgeFor(stubProvider());
    const req = withAccount(["core:access", "infrastructure:access", "infrastructure:view-queues"]);

    expect(bridge.actions(req)).toEqual(["access", "view-queues"]);
    // A right granted on another application stays in `permissions()` and is
    // invisible above, on purpose.
    expect(bridge.permissions(req)?.global).toContain("core:access");
  });

  it("takes the resource from the gate it already declares, rather than naming it twice", () => {
    expect(bridgeFor(stubProvider()).auth.permissions.resource).toBe("infrastructure");
  });

  it("answers the booleans a screen hides its buttons with", () => {
    const bridge = bridgeFor(stubProvider());
    const req = withAccount(["infrastructure:view-queues", "infrastructure:manage-queues"]);

    expect(bridge.can(req, "view-queues")).toBe(true);
    expect(bridge.can(req, "delete-queues")).toBe(false);
    expect(bridge.canAll(req, "view-queues", "manage-queues")).toBe(true);
    expect(bridge.canAny(req, "delete-queues", "view-queues")).toBe(true);
  });

  it("refuses, naming what is missing", () => {
    const bridge = bridgeFor(stubProvider());

    expect(() => bridge.assert(withAccount(["infrastructure:view-queues"]), "delete-queues")).toThrow(
      "Missing infrastructure:delete-queues"
    );
  });

  it("refuses a request with no session rather than reading nothing as everything", () => {
    const bridge = bridgeFor(stubProvider());

    expect(bridge.can({ headers: {} }, "view-queues")).toBe(false);
    expect(bridge.actions({ headers: {} })).toEqual([]);
    expect(bridge.permissions({ headers: {} })).toBeNull();
  });
});
