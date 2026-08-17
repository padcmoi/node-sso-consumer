import { buildHttpSignedHeaders } from "@naskot/node-hmac-auth-core";
import { SsoError } from "./errors.js";
import { asFields } from "./parse.js";
import type { HttpMethod, SsoLogger } from "./types.js";

/**
 * The HMAC runtime the application already runs, injected.
 *
 * Described structurally rather than imported as a class: what arrives here is the
 * `initializeHmacHttpAuth(...)` of the service that owns the credential store -
 * its Redis, its namespace, its secret token - and this library only ever asks it
 * one thing. It opens nothing, holds no secret and keeps no copy.
 *
 * `getSecretHash` answers null while the credential has not been delivered, which
 * is a real state at boot rather than a failure: the secret travels over the
 * broker and the first calls can precede it.
 */
export interface SsoHmacRuntime {
  clients: {
    getSecretHash(clientId: string): Promise<string | null>;
    /**
     * Writing a credential in, which only pairing ever does.
     *
     * Optional because an application whose credential arrives over the broker
     * never needs it: the propagation library writes it, and this side only reads.
     * An application installing itself from a pairing code has nothing to wait for
     * and puts it in itself, once.
     */
    setSecret?(clientId: string, secret: string): Promise<void> | void;
  };
}

export interface HttpAnswer {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

/** Injectable so a test drives the two services without a network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<HttpAnswer>;

export interface SsoHttpOptions {
  /** x-core's API root, WITH its port. Not the login window - see `isProvider`. */
  apiBase: string;
  /** The HMAC clientId, which IS this app's SSO identity. */
  clientId: string;
  hmac: SsoHmacRuntime;
  fetch?: FetchLike;
  timeoutMs?: number;
  logger?: SsoLogger;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DETAIL_MAX = 300;

const globalFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * Every call this library makes to x-core, signed.
 *
 * The signature covers METHOD + path(+query) + timestamp + nonce + sha256(body).
 * Three consequences are wired in here rather than left to each caller: the verb
 * travels explicitly and is never a constant, the query is part of the address
 * being signed, and no credential is ever put in a header - headers are not signed.
 */
export class SsoHttpClient {
  /**
   * The base, without its trailing slash.
   *
   * Trimmed once here rather than trusted: the paths below all carry their own
   * leading slash, so a base written with one produces `…:13001//api/v1/…` - which
   * is a different address AND a different signature, failing as a 401 that looks
   * like a credential problem.
   */
  private readonly base: string;

  constructor(private readonly options: SsoHttpOptions) {
    this.base = options.apiBase.replace(/\/+$/, "");
  }

  get clientId() {
    return this.options.clientId;
  }

  get apiBase() {
    return this.base;
  }

  /**
   * That `apiBase` really is x-core, proven before anything is declared to it.
   *
   * An unsigned call to a signed route must be REFUSED. It reads as redundant
   * until the value points at the login front by mistake: a Nitro answers 204 to a
   * route it does not know, a 204 reads as success to a caller, and the app then
   * logs that it declared itself to something that never heard of it.
   *
   * Only a 401 proves the far side checks signatures at all.
   */
  async isProvider(path = "/api/v1/sso/consumer/config") {
    const doFetch = this.options.fetch ?? globalFetch;
    try {
      const answer = await doFetch(`${this.base}${path}`, { method: "PUT", headers: {} });
      return answer.status === 401;
    } catch {
      return false;
    }
  }

  /**
   * The headers proving this app signed that exact request.
   *
   * Public because a WebSocket handshake needs them too: an upgrade is an HTTP GET
   * that asks to be promoted, and the provider verifies it before the socket
   * exists. Signing it is the same act as signing a call, so it is the same code.
   */
  async signHeaders(request: { method: HttpMethod; url: string; body?: string }) {
    const secretHash = await this.options.hmac.clients.getSecretHash(this.clientId);
    if (!secretHash) {
      // Worth its own code: the credential has not been delivered into the store,
      // so nothing here can sign anything. It is not a bad secret, it is no secret.
      throw new SsoError("NO_CREDENTIAL", `No HMAC credential for ${this.clientId}: nothing has been propagated yet`);
    }

    // The hash and never the secret: what the store holds is already peppered with
    // the provider's own token, and the library signs from it.
    const headers: Record<string, string> = {};
    buildHttpSignedHeaders({
      method: request.method,
      url: request.url,
      body: request.body ?? "",
      clientId: this.clientId,
      secret: secretHash,
      secretIsHashed: true,
    }).forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }

  /**
   * One call carrying no signature.
   *
   * Exactly one thing needs it, and it is the moment before this application has
   * an identity at all: redeeming a pairing code. What authenticates it is the
   * code itself, which is single-use, short-lived and minted for this application
   * alone - so there is no signature to make and nothing yet to make it with.
   */
  async unsigned(path: string, method: HttpMethod, body: unknown, headers: Record<string, string> = {}) {
    const payload = JSON.stringify(body ?? {});
    return this.send(`${this.base}${path}`, method, path, { ...headers, "content-type": "application/json" }, payload);
  }

  /**
   * One signed call, answering the parsed payload, or null for a 204.
   *
   * `path` carries its own query string when it has one: the signature is built
   * over what is sent, so a query assembled afterwards would sign something other
   * than what travels.
   */
  async call(path: string, method: HttpMethod, body?: unknown) {
    if (!this.base) throw new SsoError("UNREACHABLE", "No API base configured for the SSO provider");

    const url = `${this.base}${path}`;
    // A GET, and a DELETE carrying nothing, sign over the hash of an empty body,
    // which is what the verifier hashes on its side.
    const payload = method === "GET" || (method === "DELETE" && body === undefined) ? "" : JSON.stringify(body ?? {});

    const headers: Record<string, string> = { ...(await this.signHeaders({ method, url, body: payload })) };
    if (payload) headers["content-type"] = "application/json";

    return this.send(url, method, path, headers, payload);
  }

  private async send(url: string, method: HttpMethod, path: string, headers: Record<string, string>, payload: string) {
    const doFetch = this.options.fetch ?? globalFetch;
    let answer: HttpAnswer;
    try {
      answer = await doFetch(url, {
        method,
        headers,
        body: payload || undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new SsoError("UNREACHABLE", `${method} ${path} could not reach the SSO provider`, { cause });
    }

    if (!answer.ok) throw await this.refusal(method, path, answer);

    const text = await answer.text();
    if (answer.status === 204 || !text) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new SsoError("MALFORMED_ANSWER", `${method} ${path} answered something that is not JSON`, {
        status: answer.status,
        cause,
      });
    }

    // Answers are wrapped in `{ data: … }`. The envelope is unwrapped here so no
    // caller has to know it exists, and a payload without one is handed back whole
    // rather than turned into null: an unwrapping that guesses is worse than none.
    const envelope = asFields(parsed);
    if (envelope && "data" in envelope) return envelope.data;
    return parsed;
  }

  private async refusal(method: HttpMethod, path: string, answer: HttpAnswer) {
    const detail = await answer.text().catch(() => "");
    const truncated = detail.slice(0, DETAIL_MAX);
    this.options.logger?.error?.(`[sso] ${method} ${path} answered ${answer.status} ${truncated}`);

    // 401 and 403 are not transport failures: the first says the session is over,
    // the second that the account may not be here. Both are answers, and an app
    // has to act on them differently from a provider that is down.
    if (answer.status === 401) {
      return new SsoError("UNAUTHORIZED", `${method} ${path} was refused: the session or the credential is not valid`, {
        status: 401,
        detail: truncated,
      });
    }
    if (answer.status === 403) {
      return new SsoError("FORBIDDEN", `${method} ${path} was refused: this account may not do that`, {
        status: 403,
        detail: truncated,
      });
    }
    return new SsoError("REFUSED", `${method} ${path} answered ${answer.status}`, { status: answer.status, detail: truncated });
  }
}
