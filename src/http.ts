import { SsoError } from "./errors.js";
import type { SsoEnvironment } from "./environment.js";
import type { SsoLogger } from "./types.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface HttpAnswer {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

/**
 * What this library is handed to reach the provider, and it arrives SIGNED.
 *
 * `init` carries the `clientId` this call must be signed as: the library holds it -
 * from what the pairing brought back, or from `environment.load()` - and hands it
 * over on every call. The application adds its own secret and nothing else, which is
 * why no secret ever crosses this library.
 *
 * A real `Response` satisfies this: only `status`, `ok` and `text()` are ever read.
 */
export type SignedFetch = (
  url: string,
  init: { method: HttpMethod; headers: Record<string, string>; body?: string; clientId: string; signal?: AbortSignal }
) => Promise<HttpAnswer>;

/**
 * The headers proving this application signed that exact request.
 *
 * Its own entry rather than a use of the transport above, because a WebSocket
 * UPGRADE is not a fetch: it is an HTTP GET that asks to be promoted, the provider
 * verifies it before a socket exists, and what the dialer needs is the headers
 * themselves rather than an answer to a request.
 *
 * Signing it is the same act as signing a call, so it is the same code on the
 * application's side - `buildHttpSignedHeaders` from `@naskot/node-hmac-auth`.
 */
export type SignHeaders = (request: {
  method: HttpMethod;
  url: string;
  body: string;
}) => Promise<Record<string, string>> | Record<string, string>;

/**
 * Everything that touches this application's HMAC credential, in one place.
 *
 * The three belong together because they are one object seen from three sides:
 * signing a call with it, signing an upgrade with it, and writing it down when the
 * pairing brings it. Split apart they would read as three unrelated favours.
 */
export interface XcoreHmacInjection {
  fetch: SignedFetch;
  signHeaders: SignHeaders;
  /**
   * Write the credential the pairing just brought back, once in the life of the
   * application. The only write, and what makes the two above able to sign at every
   * boot after this one.
   */
  setSecret(clientId: string, secret: string): Promise<void> | void;
}

export interface SsoHttpOptions {
  /** x-core's API root, WITH its port. Not the login window - see `isProvider`. */
  apiBase: string;
  /** The identity to sign as, read through rather than captured: it arrives at boot. */
  identity: SsoEnvironment;
  hmac: XcoreHmacInjection;
  timeoutMs?: number;
  logger?: SsoLogger;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DETAIL_MAX = 300;

/**
 * Every call this library makes to x-core.
 *
 * The signature covers METHOD + path(+query) + timestamp + nonce + sha256(body), and
 * three consequences are wired in here rather than left to each caller: the verb
 * travels explicitly and is never a constant, the query is part of the address being
 * signed, and no credential is ever put in a header - headers are not signed.
 *
 * The signing itself belongs to the application: it already holds the runtime that
 * signs for every other service it talks to, and a second implementation here is a
 * second thing to drift from the one that verifies in front.
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

  get apiBase() {
    return this.base;
  }

  /**
   * That `apiBase` really is x-core, proven before anything is declared to it.
   *
   * An unsigned call to a signed route must be REFUSED. It reads as redundant until
   * the value points at the login front by mistake: a Nitro answers 204 to a route
   * it does not know, a 204 reads as success to a caller, and the app then logs that
   * it declared itself to something that never heard of it.
   *
   * Only a 401 proves the far side checks signatures at all.
   */
  async isProvider(path = "/api/v1/sso/consumer/config") {
    try {
      const answer = await fetch(`${this.base}${path}`, { method: "PUT" });
      return answer.status === 401;
    } catch {
      return false;
    }
  }

  /** The headers that open the realtime socket, signed as this application. */
  signHeaders(request: { method: HttpMethod; url: string; body?: string }) {
    return this.options.hmac.signHeaders({ method: request.method, url: request.url, body: request.body ?? "" });
  }

  /**
   * One call carrying no signature.
   *
   * Exactly one thing needs it, and it is the moment before this application has an
   * identity at all: redeeming a pairing code. What authenticates it is the code
   * itself, which is single-use, short-lived and minted for this application alone -
   * so there is no signature to make and nothing yet to make it with.
   *
   * The global `fetch` and not the injected one, deliberately: the injected one
   * signs, and signing here would mean holding the credential this call exists to
   * collect.
   */
  async unsigned(path: string, method: HttpMethod, body: unknown, headers: Record<string, string> = {}) {
    const url = `${this.base}${path}`;
    const payload = JSON.stringify(body ?? {});

    let answer: HttpAnswer;
    try {
      answer = await fetch(url, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new SsoError("UNREACHABLE", `${method} ${path} could not reach the SSO provider`, { cause });
    }

    return this.read(answer, method, path);
  }

  /**
   * One signed call, answering the parsed payload, or null for a 204.
   *
   * `path` carries its own query string when it has one: the signature is built over
   * what is sent, so a query assembled afterwards would sign something other than
   * what travels.
   */
  async call(path: string, method: HttpMethod, body?: unknown) {
    if (!this.base) throw new SsoError("UNREACHABLE", "No API base configured for the SSO provider");

    const url = `${this.base}${path}`;
    // A GET, and a DELETE carrying nothing, sign over the hash of an empty body,
    // which is what the verifier hashes on its side.
    const payload = method === "GET" || (method === "DELETE" && body === undefined) ? "" : JSON.stringify(body ?? {});
    const headers: Record<string, string> = payload ? { "content-type": "application/json" } : {};

    let answer: HttpAnswer;
    try {
      answer = await this.options.hmac.fetch(url, {
        method,
        headers,
        body: payload || undefined,
        // Handed over on every call rather than captured once: it is read from the
        // store at boot, and an application that captured it before that would sign
        // as nobody.
        clientId: this.options.identity.clientId,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      if (cause instanceof SsoError) throw cause;
      throw new SsoError("UNREACHABLE", `${method} ${path} could not reach the SSO provider`, { cause });
    }

    return this.read(answer, method, path);
  }

  private async read(answer: HttpAnswer, method: HttpMethod, path: string) {
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
    const envelope = parsed as Record<string, unknown> | null;
    if (envelope && typeof envelope === "object" && "data" in envelope) return envelope.data;
    return parsed;
  }

  private async refusal(method: HttpMethod, path: string, answer: HttpAnswer) {
    const detail = await answer.text().catch(() => "");
    const truncated = detail.slice(0, DETAIL_MAX);
    this.options.logger?.error?.(`[sso] ${method} ${path} answered ${answer.status} ${truncated}`);

    // 401 and 403 are not transport failures: the first says the session is over,
    // the second that the account may not be here. Both are answers, and an app has
    // to act on them differently from a provider that is down.
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
