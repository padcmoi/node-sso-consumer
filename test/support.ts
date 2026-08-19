import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { ENV, SsoEnvironment } from "../src/environment.js";
import type { HttpAnswer, SignedFetch, XcoreHmacInjection } from "../src/http.js";
import type { CookieJar, CookieOptions } from "../src/session/session.service.js";
import type { SsoMe } from "../src/types.js";

/** One recorded exchange, so a test asserts on what actually travelled. */
export interface Exchange {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Which identity it was signed as. Absent on the one unsigned call. */
  clientId?: string;
}

export interface StubAnswer {
  status?: number;
  body?: unknown;
  /** Raw text, for the malformed-answer cases where `body` would be re-encoded. */
  text?: string;
  /** Thrown instead of answered, for the transport failures. */
  fail?: boolean;
}

/**
 * A provider on a string, driving the library without a network.
 *
 * Answers are queued per `METHOD /path` and consumed in order, so a test says what
 * happens on the first call and what happens on the second - which is the whole of
 * what the rotation, the retry and the dedup paths need.
 *
 * Two faces, because the library has two transports and that is deliberate: the
 * SIGNED one it is handed, and the global `fetch` it uses for the single unsigned
 * call - redeeming a pairing code, which cannot be signed with a credential it does
 * not have yet. `install()` on this object stubs the global so both land here.
 */
export const stubProvider = () => {
  const queued = new Map<string, StubAnswer[]>();
  const seen: Exchange[] = [];

  const key = (method: string, url: string) => `${method.toUpperCase()} ${new URL(url).pathname}`;

  const answerFor = (method: string, url: string) => {
    const pending = queued.get(key(method, url));
    const next = pending?.shift();
    if (!next) return Promise.reject(new Error(`Nothing queued for ${key(method, url)}`));
    if (next.fail) return Promise.reject(new Error("connect ECONNREFUSED"));

    const status = next.status ?? 200;
    const text = next.text ?? (next.body === undefined ? "" : JSON.stringify(next.body));
    const answer: HttpAnswer = {
      status,
      ok: status >= 200 && status < 300,
      text: () => Promise.resolve(text),
    };
    return Promise.resolve(answer);
  };

  const signed: SignedFetch = (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body, clientId: init.clientId });
    return answerFor(init.method, url);
  };

  return {
    fetch: signed,
    seen,
    /** Queue one answer for the next call on that route. */
    on(method: string, path: string, answer: StubAnswer) {
      const at = `${method.toUpperCase()} ${path}`;
      queued.set(at, [...(queued.get(at) ?? []), answer]);
      return this;
    },
    /**
     * Answer the UNSIGNED calls too - the pairing, and the `isProvider` probe.
     *
     * The library reaches for the global `fetch` there on purpose: signing that call
     * would mean holding the credential it exists to collect.
     */
    global() {
      vi.stubGlobal("fetch", (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
        const method = init.method ?? "GET";
        seen.push({ url, method, headers: init.headers ?? {}, body: init.body });
        return answerFor(method, url);
      });
      return this;
    },
    /** What travelled, for asserting on a signature or a header. */
    last() {
      return seen[seen.length - 1];
    },
    calls(method: string, path: string) {
      return seen.filter((entry) => key(entry.method, entry.url) === `${method.toUpperCase()} ${path}`);
    },
  };
};

/**
 * The signing side, as the consuming application lends it.
 *
 * It signs by writing the identity into a header rather than computing anything: the
 * protocol is `@naskot/node-hmac-auth`'s and this library never implements it, so
 * what a test proves here is that the right identity reached the transport - not
 * that a signature is correct, which is that package's own suite.
 */
export const stubHmac = (provider: ReturnType<typeof stubProvider>) => {
  const written: { clientId: string; secret: string }[] = [];

  const hmac: XcoreHmacInjection & { written: typeof written } = {
    fetch: (url, init) => provider.fetch(url, { ...init, headers: { ...init.headers, "x-client-id": init.clientId } }),
    signHeaders: (request) => ({ "x-client-id": "signed", "x-signature": `${request.method} ${request.url}` }),
    setSecret: (clientId, secret) => {
      written.push({ clientId, secret });
    },
    written,
  };
  return hmac;
};

/** A credential store nobody can write into, as an app fed over the broker has. */
export const readOnlyHmac = (provider: ReturnType<typeof stubProvider>) => {
  const hmac = stubHmac(provider);
  hmac.setSecret = () => {
    throw new Error("this HMAC runtime can only receive a credential, not write one");
  };
  return hmac;
};

/**
 * The application's own key/value store, in a Map.
 *
 * `save` is an UPSERT, exactly as the contract says: it writes the keys it is given
 * and leaves the others alone. A stub that replaced everything would hide the one
 * mistake this shape exists to prevent.
 */
export const stubEnvironment = (initial: Record<string, unknown> = {}) => {
  const held: Record<string, unknown> = { ...initial };
  const saves: Record<string, unknown>[] = [];

  return {
    held,
    saves,
    load: () => ({ ...held }),
    save: (values: Record<string, unknown>) => {
      saves.push(values);
      Object.assign(held, values);
    },
  };
};

/** A store holding a paired application, which is what most tests start from. */
export const paired = (overrides: Record<string, unknown> = {}) =>
  stubEnvironment({
    [ENV.INSTALLED]: true,
    [ENV.SSO_SESSION_PASSWORD]: SESSION_PASSWORD,
    [ENV.SSO_SESSION_COOKIE_NAME]: "sso_oauth_test",
    [ENV.SSO_CLIENT_ID]: "oauth-test",
    [ENV.SSO_REDIRECT_URI]: "https://app.example.com/api/auth/sso/callback",
    [ENV.SSO_CANCEL_URI]: "https://app.example.com/",
    [ENV.SSO_DEPEND_GLOBAL_RESSOURCE]: ["infrastructure"],
    ...overrides,
  });

/** An identity already hydrated, for the services that read through one. */
export const anIdentity = (values: Record<string, unknown> = paired().held) => {
  const identity = new SsoEnvironment();
  identity.hydrate(values);
  return identity;
};

/** What the provider answers to a redemption, in its own shape. */
export const aPairing = (overrides: Record<string, unknown> = {}) => ({
  clientId: "oauth-test",
  secret: "the-secret",
  sessionCookieName: "sso_oauth_test",
  redirectUri: "https://app.example.com/api/auth/sso/callback",
  cancelUri: "https://app.example.com/",
  template: "gestionpratique",
  dependGlobalRessource: ["infrastructure"],
  propagation: {
    amqpQueue: "app-prod",
    propagationSecret: "prop-secret",
    brokerQueue: "hmac-app-prod.queue",
    account: {
      username: "app_prod",
      password: "broker-password",
      vhost: "hmac-credentials",
      protocol: "amqps",
      host: "x-amqp.example.com",
      port: 5671,
    },
  },
  ...overrides,
});

/** The cookie jar, in a Map, with what was written kept for the assertions. */
export const stubJar = (initial: Record<string, string> = {}) => {
  const held = new Map(Object.entries(initial));
  const writes: { name: string; value: string; options: CookieOptions }[] = [];
  const cleared: string[] = [];

  const jar: CookieJar & { held: typeof held; writes: typeof writes; cleared: typeof cleared } = {
    read: (name) => held.get(name) ?? null,
    write: (name, value, options) => {
      held.set(name, value);
      writes.push({ name, value, options });
    },
    clear: (name) => {
      held.delete(name);
      cleared.push(name);
    },
    held,
    writes,
    cleared,
  };
  return jar;
};

export const anAccount = (global: string[] = ["infrastructure:access"], isRoot = false) => ({
  user: { id: "user-1", email: "reader@example.com", displayName: "Reader", avatarUrl: null, hasPassword: false },
  profile: { firstname: "Julien", city: "Fréjus" },
  permissions: { global, isRoot, groups: [] },
});

export const anAccountRead = (global?: string[], isRoot?: boolean) => {
  const me: SsoMe = {
    user: { id: "user-1", email: "reader@example.com", displayName: "Reader", avatarUrl: null },
    profile: { firstname: "Julien" },
    permissions: { global: global ?? ["infrastructure:access"], isRoot: isRoot ?? false, groups: [] },
  };
  return me;
};

export const aSession = (suffix = "1") => ({
  accessToken: `access-${suffix}`,
  accessTokenExpiresAt: "2026-08-17T12:00:00.000Z",
  refreshToken: `refresh-${suffix}`,
  refreshTokenExpiresAt: "2026-09-17T12:00:00.000Z",
  user: { id: "user-1", email: "reader@example.com", displayName: "Reader", avatarUrl: null },
});

/**
 * A sealing password for the tests, minted rather than written down.
 *
 * Its value is meaningless - the sealing only demands 32 characters - and a
 * meaningless string that LOOKS like a password is exactly what a secret scanner
 * reports, having no way to tell one from a real one. Generating it costs nothing
 * and leaves nothing in the repository to report.
 */
export const SESSION_PASSWORD = randomBytes(24).toString("base64url");

/** Another one, for the cases that check a cookie sealed by somebody else. */
export const OTHER_SESSION_PASSWORD = randomBytes(24).toString("base64url");

export const API_BASE = "https://x-core.example.com:13001";
