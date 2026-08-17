import type { FetchLike, HttpAnswer, SsoHmacRuntime } from "../src/http.js";
import type { CookieJar, CookieOptions } from "../src/session/session.service.js";
import type { SsoMe } from "../src/types.js";

/** One recorded exchange, so a test asserts on what actually travelled. */
export interface Exchange {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
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
 */
export const stubProvider = () => {
  const queued = new Map<string, StubAnswer[]>();
  const seen: Exchange[] = [];

  const key = (method: string, url: string) => `${method.toUpperCase()} ${new URL(url).pathname}`;

  const doFetch: FetchLike = (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body });

    const pending = queued.get(key(init.method, url));
    const next = pending?.shift();
    if (!next) return Promise.reject(new Error(`Nothing queued for ${key(init.method, url)}`));
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

  return {
    fetch: doFetch,
    seen,
    /** Queue one answer for the next call on that route. */
    on(method: string, path: string, answer: StubAnswer) {
      const at = `${method.toUpperCase()} ${path}`;
      queued.set(at, [...(queued.get(at) ?? []), answer]);
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

/** The HMAC runtime, as the consuming application injects it. */
export const stubHmac = (secretHash: string | null = "hashed-secret") => {
  const held = { value: secretHash };
  const written: { clientId: string; secret: string }[] = [];

  const runtime: SsoHmacRuntime & { written: typeof written } = {
    clients: {
      getSecretHash: () => Promise.resolve(held.value),
      setSecret: (clientId, secret) => {
        written.push({ clientId, secret });
        held.value = "hashed-secret";
      },
    },
    written,
  };
  return runtime;
};

/** A credential store nobody can write into, as an app fed over the broker has. */
export const readOnlyHmac = (secretHash: string | null = null) => {
  const runtime: SsoHmacRuntime = { clients: { getSecretHash: () => Promise.resolve(secretHash) } };
  return runtime;
};

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

/** 32 characters, which is the floor the sealing enforces. */
export const SESSION_PASSWORD = "a-session-password-of-32-chars-!!";

export const API_BASE = "https://x-core.example.com:13001";
