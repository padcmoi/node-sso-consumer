import { describe, expect, it, vi } from "vitest";
import { SsoConfigService } from "../src/config.service.js";
import { SsoError } from "../src/errors.js";
import { SsoHttpClient } from "../src/http.js";
import { API_BASE, aPairing, anIdentity, stubHmac, stubProvider } from "./support.js";

const CONFIG_PATH = "/api/v1/sso/consumer/config";

const declaration = {
  redirectUri: "https://app.example.com/api/auth/sso/callback",
  cancelUri: "https://app.example.com/",
  dependGlobalRessource: ["infrastructure"],
};

const serviceFor = (provider: ReturnType<typeof stubProvider>) => {
  const identity = anIdentity();
  const http = new SsoHttpClient({ apiBase: API_BASE, identity, hmac: stubHmac(provider) });
  return new SsoConfigService({
    http,
    frontUrl: () => "https://sso.example.com",
    identity,
    retry: { attempts: 3, delayMs: 0 },
    // Injected so a test does not wait out a backoff it is not testing.
    sleep: () => Promise.resolve(),
  });
};

describe("where the browser goes to sign in", () => {
  it("carries the consumer and the state, and no redirect_uri", () => {
    const url = new URL(serviceFor(stubProvider()).authorizeUrl({ state: "abc" }));

    expect(url.origin + url.pathname).toBe("https://sso.example.com/authorize");
    expect(url.searchParams.get("consumer")).toBe("oauth-test");
    expect(url.searchParams.get("state")).toBe("abc");
    // The provider resolves the callback from the declaration, which is what makes
    // an open redirect impossible.
    expect(url.searchParams.get("redirect_uri")).toBeNull();
  });
});

describe("declaring this application at boot", () => {
  it("proves the base first, then writes the declaration", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 204 }).global();

    await serviceFor(provider).declare();

    const [proof, written] = provider.calls("PUT", CONFIG_PATH);
    // The proof is UNSIGNED on purpose - a signed probe proves nothing about
    // whether the far side checks signatures - and the declaration that follows
    // carries the identity the store handed over.
    expect(proof.clientId).toBeUndefined();
    expect(written.clientId).toBe("oauth-test");
    // Read back from the store, not retyped here: `declare()` sends what the console
    // recorded, so a copy in the application's own code could not overwrite it.
    expect(JSON.parse(written.body ?? "{}")).toEqual(declaration);
  });

  it("refuses to declare anything to a base that does not refuse an unsigned call", async () => {
    // The login window answers 204 to a route it does not know, and a 204 reads as
    // a success. Nothing must be written to it.
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 204 }).global();

    await expect(serviceFor(provider).declare()).rejects.toMatchObject({ code: "NOT_XCORE" });
    expect(provider.calls("PUT", CONFIG_PATH)).toHaveLength(1);
  });

  it("sends the gate whether it is empty or not, so a declaration can lift one", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 204 }).global();

    await serviceFor(provider).declare({ overrides: { dependGlobalRessource: [] } });

    const written = provider.calls("PUT", CONFIG_PATH)[1];
    expect(JSON.parse(written.body ?? "{}")).toHaveProperty("dependGlobalRessource", []);
  });

  it("retries while the credential has not arrived yet", async () => {
    // The secret travels over the broker, so the first calls can precede it: a
    // refusal at boot is "not yet" rather than "no".
    const provider = stubProvider()
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 204 })
      .global();

    await expect(serviceFor(provider).declare()).resolves.toMatchObject({
      redirectUri: declaration.redirectUri,
    });
    expect(provider.calls("PUT", CONFIG_PATH)).toHaveLength(3);
  });

  it("does not retry a refusal that waiting cannot fix", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 500 }).global();

    await expect(serviceFor(provider).declare()).rejects.toMatchObject({ code: "REFUSED" });
    // The proof, then one attempt. A 500 is not a credential on its way.
    expect(provider.calls("PUT", CONFIG_PATH)).toHaveLength(2);
  });

  it("gives up loudly rather than booting an application that will refuse every sign-in", async () => {
    const provider = stubProvider()
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 401 })
      .global();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

    const identity = anIdentity();
    const http = new SsoHttpClient({ apiBase: API_BASE, identity, hmac: stubHmac(provider) });
    const service = new SsoConfigService({
      http,
      frontUrl: () => "https://sso.example.com",
      identity,
      retry: { attempts: 3, delayMs: 0 },
      sleep: () => Promise.resolve(),
      logger,
    });

    await expect(service.declare()).rejects.toBeInstanceOf(SsoError);
    // The proof, then the three attempts it was given and no fourth.
    expect(provider.calls("PUT", CONFIG_PATH)).toHaveLength(4);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("redeeming a pairing code", () => {
  it("sends it unsigned and with NO body, and lays the answer out as the store's own keys", async () => {
    const provider = stubProvider()
      .on("POST", "/api/v1/portal/install", { status: 201, body: { data: aPairing() } })
      .global();

    const paired = await serviceFor(provider).pair({ token: "code" });

    expect(paired).toMatchObject({ clientId: "oauth-test", secret: "the-secret" });
    expect(provider.last()?.headers["x-install-token"]).toBe("code");
    // Everything this application is was declared on the provider's console when
    // the code was minted. One that could still send its own callback URL here
    // would be one able to point somebody else's installation at itself.
    expect(JSON.parse(provider.last()?.body ?? "{}")).toEqual({});

    // Mapped in ONE place: the provider's shape is its own and still settling, so a
    // second reading of it downstream is a second thing to update when a field moves.
    expect(paired.environment).toEqual({
      SSO_CLIENT_ID: "oauth-test",
      SSO_SESSION_COOKIE_NAME: "sso_oauth_test",
      SSO_REDIRECT_URI: "https://app.example.com/api/auth/sso/callback",
      SSO_CANCEL_URI: "https://app.example.com/",
      SSO_TEMPLATE: "gestionpratique",
      SSO_DEPEND_GLOBAL_RESSOURCE: ["infrastructure"],
      HMAC_AMQP_QUEUE: "app-prod",
      HMAC_PROPAGATION_SECRET: "prop-secret",
      HMAC_AMQP_BROKER_QUEUE: "hmac-app-prod.queue",
      HMAC_AMQP_VHOST: "hmac-credentials",
      RABBITMQ_PROTOCOL: "amqps",
      RABBITMQ_HOST: "x-amqp.example.com",
      RABBITMQ_PORT: 5671,
      RABBITMQ_USER: "app_prod",
      RABBITMQ_PASSWORD: "broker-password",
    });
    // The credential is NOT among them: it goes to the store that signs with it,
    // never onto a key/value shelf beside a broker password.
    expect(paired.environment).not.toHaveProperty("secret");
  });

  // `save` is an upsert, so a null would overwrite a value that was already there
  // with an emptiness nobody decided.
  it("drops what the provider did not send rather than writing it as null", async () => {
    const answer = aPairing();
    delete (answer as Record<string, unknown>).template;
    const provider = stubProvider()
      .on("POST", "/api/v1/portal/install", { status: 201, body: { data: answer } })
      .global();

    const paired = await serviceFor(provider).pair({ token: "code" });
    expect(paired.environment).not.toHaveProperty("SSO_TEMPLATE");
  });

  it("keeps an empty gate, which declares that this application filters nothing", async () => {
    const provider = stubProvider()
      .on("POST", "/api/v1/portal/install", { status: 201, body: { data: aPairing({ dependGlobalRessource: [] }) } })
      .global();

    const paired = await serviceFor(provider).pair({ token: "code" });
    expect(paired.environment.SSO_DEPEND_GLOBAL_RESSOURCE).toEqual([]);
  });

  it("refuses an answer carrying no identity or no secret: neither half is usable alone", async () => {
    const provider = stubProvider()
      .on("POST", "/api/v1/portal/install", { status: 201, body: { data: { clientId: "x" } } })
      .on("POST", "/api/v1/portal/install", { status: 201, body: { data: { secret: "s" } } })
      .global();

    await expect(serviceFor(provider).pair({ token: "code" })).rejects.toMatchObject({ code: "MALFORMED_ANSWER" });
    await expect(serviceFor(provider).pair({ token: "code" })).rejects.toMatchObject({ code: "MALFORMED_ANSWER" });
  });
});
