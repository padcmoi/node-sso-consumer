import { describe, expect, it, vi } from "vitest";
import { SsoConfigService } from "../src/config.service.js";
import { SsoError } from "../src/errors.js";
import { SsoHttpClient } from "../src/http.js";
import type { SsoHmacRuntime } from "../src/http.js";
import { API_BASE, readOnlyHmac, stubHmac, stubProvider } from "./support.js";

const CONFIG_PATH = "/api/v1/sso/consumer/config";

const declaration = {
  redirectUri: "https://app.example.com/api/auth/sso/callback",
  cancelUri: "https://app.example.com/",
  dependGlobalRessource: ["infrastructure"],
};

const serviceFor = (provider: ReturnType<typeof stubProvider>, hmac: SsoHmacRuntime = stubHmac()) => {
  const http = new SsoHttpClient({ apiBase: API_BASE, clientId: "oauth-test", hmac, fetch: provider.fetch });
  return new SsoConfigService({
    http,
    frontUrl: "https://sso.example.com",
    declaration,
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
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 204 });

    await serviceFor(provider).declare();

    const [proof, written] = provider.calls("PUT", CONFIG_PATH);
    expect(proof.headers["x-signature"]).toBeUndefined();
    expect(written.headers["x-signature"]).toBeDefined();
    expect(JSON.parse(written.body ?? "{}")).toEqual(declaration);
  });

  it("refuses to declare anything to a base that does not refuse an unsigned call", async () => {
    // The login window answers 204 to a route it does not know, and a 204 reads as
    // a success. Nothing must be written to it.
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 204 });

    await expect(serviceFor(provider).declare()).rejects.toMatchObject({ code: "NOT_XCORE" });
    expect(provider.calls("PUT", CONFIG_PATH)).toHaveLength(1);
  });

  it("sends the gate whether it is empty or not, so a declaration can lift one", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 204 });

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
      .on("PUT", CONFIG_PATH, { status: 204 });

    await expect(serviceFor(provider, readOnlyHmac("hash")).declare()).resolves.toMatchObject({
      redirectUri: declaration.redirectUri,
    });
    expect(provider.calls("PUT", CONFIG_PATH)).toHaveLength(3);
  });

  it("does not retry a refusal that waiting cannot fix", async () => {
    const provider = stubProvider().on("PUT", CONFIG_PATH, { status: 401 }).on("PUT", CONFIG_PATH, { status: 500 });

    await expect(serviceFor(provider).declare()).rejects.toMatchObject({ code: "REFUSED" });
    // The proof, then one attempt. A 500 is not a credential on its way.
    expect(provider.calls("PUT", CONFIG_PATH)).toHaveLength(2);
  });

  it("gives up loudly rather than booting an application that will refuse every sign-in", async () => {
    const provider = stubProvider()
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 401 })
      .on("PUT", CONFIG_PATH, { status: 401 });
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

    const http = new SsoHttpClient({ apiBase: API_BASE, clientId: "oauth-test", hmac: stubHmac(), fetch: provider.fetch });
    const service = new SsoConfigService({
      http,
      frontUrl: "https://sso.example.com",
      declaration,
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
  it("sends it unsigned and with NO body, and hands the secret back to its owner", async () => {
    const provider = stubProvider().on("POST", "/api/v1/portal/install", {
      status: 201,
      body: { data: { clientId: "oauth-test", secret: "the-secret" } },
    });

    const paired = await serviceFor(provider, readOnlyHmac(null)).pair({ token: "code", clientId: "oauth-test" });

    expect(paired).toMatchObject({ clientId: "oauth-test", secret: "the-secret" });
    expect(provider.last()?.headers["x-install-token"]).toBe("code");
    // Everything this application is was declared on the provider's console when
    // the code was minted. One that could still send its own callback URL here
    // would be one able to point somebody else's installation at itself.
    expect(JSON.parse(provider.last()?.body ?? "{}")).toEqual({});
  });

  it("refuses an answer carrying no secret, since nothing could be signed with it", async () => {
    const provider = stubProvider().on("POST", "/api/v1/portal/install", { status: 201, body: { data: { clientId: "x" } } });

    await expect(serviceFor(provider, readOnlyHmac(null)).pair({ token: "code", clientId: "oauth-test" })).rejects.toMatchObject({
      code: "MALFORMED_ANSWER",
    });
  });
});
