import { describe, expect, it } from "vitest";
import { SsoError } from "../src/errors.js";
import { SsoHttpClient } from "../src/http.js";
import type { SsoHmacRuntime } from "../src/http.js";
import { API_BASE, readOnlyHmac, stubHmac, stubProvider } from "./support.js";

const clientFor = (provider: ReturnType<typeof stubProvider>, hmac: SsoHmacRuntime = stubHmac()) =>
  new SsoHttpClient({ apiBase: API_BASE, clientId: "oauth-test", hmac, fetch: provider.fetch });

const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof SsoError ? error.code : `not an SsoError: ${String(error)}`;
  }
  return "no error";
};

describe("the signed channel", () => {
  it("trims a base written with a trailing slash, which would sign a different address", async () => {
    const provider = stubProvider().on("GET", "/api/v1/sso/me", { body: { data: { ok: true } } });
    const client = new SsoHttpClient({
      apiBase: `${API_BASE}/`,
      clientId: "oauth-test",
      hmac: stubHmac(),
      fetch: provider.fetch,
    });

    await client.call("/api/v1/sso/me", "GET");

    expect(provider.last()?.url).toBe(`${API_BASE}/api/v1/sso/me`);
  });

  it("signs with the clientId and carries no credential in a header of its own", async () => {
    const provider = stubProvider().on("GET", "/api/v1/sso/me", { body: { data: {} } });
    await clientFor(provider).call("/api/v1/sso/me", "GET");

    const headers = provider.last()?.headers ?? {};
    const names = Object.keys(headers).map((name) => name.toLowerCase());

    expect(names).toContain("x-client-id");
    expect(names).toContain("x-signature");
    expect(headers["x-client-id"]).toBe("oauth-test");
  });

  it("unwraps the envelope, so no caller has to know it exists", async () => {
    const provider = stubProvider().on("GET", "/api/v1/sso/me", { body: { data: { email: "reader@example.com" } } });
    expect(await clientFor(provider).call("/api/v1/sso/me", "GET")).toEqual({ email: "reader@example.com" });
  });

  it("hands back a payload with no envelope whole, rather than guessing", async () => {
    const provider = stubProvider().on("GET", "/api/v1/sso/me", { body: { email: "reader@example.com" } });
    expect(await clientFor(provider).call("/api/v1/sso/me", "GET")).toEqual({ email: "reader@example.com" });
  });

  it("answers null for a 204", async () => {
    const provider = stubProvider().on("DELETE", "/api/v1/sso/consumer/session", { status: 204 });
    expect(await clientFor(provider).call("/api/v1/sso/consumer/session", "DELETE")).toBeNull();
  });

  it("sends no body on a GET, which is what the far side hashes", async () => {
    const provider = stubProvider().on("GET", "/api/v1/sso/me", { body: { data: {} } });
    await clientFor(provider).call("/api/v1/sso/me", "GET");

    expect(provider.last()?.body).toBeUndefined();
  });

  describe("tells the refusals apart", () => {
    it("reads a 401 as a session that is over", async () => {
      const provider = stubProvider().on("GET", "/api/v1/sso/me", { status: 401, text: "expired" });
      expect(await codeOf(() => clientFor(provider).call("/api/v1/sso/me", "GET"))).toBe("UNAUTHORIZED");
    });

    it("reads a 403 as an account that may not be here", async () => {
      const provider = stubProvider().on("GET", "/api/v1/sso/me", { status: 403 });
      expect(await codeOf(() => clientFor(provider).call("/api/v1/sso/me", "GET"))).toBe("FORBIDDEN");
    });

    it("reads anything else as a refusal, which is nobody's session", async () => {
      const provider = stubProvider().on("GET", "/api/v1/sso/me", { status: 500 });
      expect(await codeOf(() => clientFor(provider).call("/api/v1/sso/me", "GET"))).toBe("REFUSED");
    });

    it("reads a transport failure as unreachable, never as a sign-out", async () => {
      const provider = stubProvider().on("GET", "/api/v1/sso/me", { fail: true });
      expect(await codeOf(() => clientFor(provider).call("/api/v1/sso/me", "GET"))).toBe("UNREACHABLE");
    });

    it("reads something that is not JSON as a malformed answer", async () => {
      const provider = stubProvider().on("GET", "/api/v1/sso/me", { text: "<html>login window</html>" });
      expect(await codeOf(() => clientFor(provider).call("/api/v1/sso/me", "GET"))).toBe("MALFORMED_ANSWER");
    });

    it("says NO_CREDENTIAL when nothing has been propagated yet", async () => {
      const provider = stubProvider();
      const client = clientFor(provider, readOnlyHmac(null));

      // Not a bad secret: no secret. It is a real state at boot.
      expect(await codeOf(() => client.call("/api/v1/sso/me", "GET"))).toBe("NO_CREDENTIAL");
      expect(provider.seen).toHaveLength(0);
    });
  });

  describe("proving the base really is the provider", () => {
    it("accepts only a 401, since that is what proves signatures are checked", async () => {
      const provider = stubProvider().on("PUT", "/api/v1/sso/consumer/config", { status: 401 });
      expect(await clientFor(provider).isProvider()).toBe(true);
    });

    it("refuses the login window, which answers 204 to anything it does not know", async () => {
      const provider = stubProvider().on("PUT", "/api/v1/sso/consumer/config", { status: 204 });
      expect(await clientFor(provider).isProvider()).toBe(false);
    });

    it("refuses a base nothing answers on", async () => {
      const provider = stubProvider().on("PUT", "/api/v1/sso/consumer/config", { fail: true });
      expect(await clientFor(provider).isProvider()).toBe(false);
    });
  });

  describe("the one unsigned call", () => {
    it("carries the pairing code in a header and no signature at all", async () => {
      const provider = stubProvider().on("POST", "/api/v1/portal/install", { body: { data: { secret: "s" } } });
      const client = clientFor(provider, readOnlyHmac(null));

      await client.unsigned("/api/v1/portal/install", "POST", { clientId: "oauth-test" }, { "x-install-token": "code" });

      const headers = provider.last()?.headers ?? {};
      expect(headers["x-install-token"]).toBe("code");
      expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("x-signature");
    });
  });
});
