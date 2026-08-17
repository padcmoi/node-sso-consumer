import { SsoError } from "./errors.js";
import { asFields } from "./parse.js";
import type { SsoHttpClient } from "./http.js";
import type { SsoConsumerDeclaration, SsoLogger } from "./types.js";

const CONSUMER_CONFIG_PATH = "/api/v1/sso/consumer/config";
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 3_000;

/** Retried at boot: the credential travels over a broker, so "not yet" is a state. */
const RETRYABLE = new Set(["NO_CREDENTIAL", "UNREACHABLE", "UNAUTHORIZED"]);

export interface SsoConfigServiceOptions {
  http: SsoHttpClient;
  /** The login window the browser is sent to. NOT the API - they differ by a port. */
  frontUrl: string;
  /** How this app plugs in. Sent whole on every declaration. */
  declaration: SsoConsumerDeclaration;
  logger?: SsoLogger;
  retry?: { attempts?: number; delayMs?: number };
  /**
   * Where a pairing code is redeemed. Injectable because the provider owns this
   * path and it is the one part of the protocol still settling.
   */
  installPath?: string;
  /** Injectable so a test does not wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Initiating the configuration: how this app becomes an application the provider
 * knows about, and stays one.
 *
 * Two moments, and they are not the same one. PAIRING happens once, with a code
 * somebody minted for this app, and is what brings a credential into existence.
 * DECLARING happens at every boot, signed with that credential, and is what keeps
 * the callback, the login screen and the access gate in step with the code that is
 * deployed - so changing any of them is a change in configuration rather than an
 * operator's errand.
 *
 * Everything is passed in. This service reads no environment, holds no secret and
 * opens nothing: it is handed a signed client and a declaration, and it acts on
 * what its methods are called with.
 */
export class SsoConfigService {
  constructor(private readonly options: SsoConfigServiceOptions) {}

  /**
   * Where the browser goes to sign in.
   *
   * Two parameters travel and neither is secret: the public clientId, and a state
   * the caller invents to correlate the return. No `redirect_uri` - the provider
   * resolves it from the declaration below, which is what makes an open redirect
   * impossible.
   */
  authorizeUrl(params: { state: string; frontUrl?: string }) {
    const front = params.frontUrl ?? this.options.frontUrl;
    if (!front) throw new SsoError("UNREACHABLE", "No front URL configured for the SSO login window");

    const url = new URL("/authorize", front);
    url.searchParams.set("consumer", this.options.http.clientId);
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  /**
   * That the configured base really is the provider, and not its login window.
   *
   * Worth calling before declaring anything: the login window answers 204 to a
   * route it does not know, a 204 reads as success, and an app pointed at it
   * reports at every boot that it declared itself to something that never heard
   * of it.
   */
  verifyProvider() {
    return this.options.http.isProvider(CONSUMER_CONFIG_PATH);
  }

  /**
   * Declare this app to the provider. Idempotent, so it belongs on every boot.
   *
   * `dependGlobalRessource` travels whether it is empty or not: an optional field
   * is only written when provided, so omitting it could SET a gate and never clear
   * one - and the gate is the one setting an app must be able to lift from its own
   * configuration.
   *
   * Refuses to declare anything to a base that does not refuse an unsigned call,
   * unless told to skip that proof.
   */
  async declare(params: { overrides?: Partial<SsoConsumerDeclaration>; verify?: boolean } = {}) {
    const declaration: SsoConsumerDeclaration = { ...this.options.declaration, ...params.overrides };
    if (!declaration.redirectUri) throw new SsoError("NOT_XCORE", "No redirectUri to declare: the callback address is missing");

    if (params.verify !== false && !(await this.verifyProvider())) {
      throw new SsoError(
        "NOT_XCORE",
        "The configured API base does not point at the SSO provider: an unsigned call was not refused with a 401. " +
          "Nothing was declared - a 204 from anything else would have looked like a success."
      );
    }

    const attempts = this.options.retry?.attempts ?? DEFAULT_ATTEMPTS;
    const delayMs = this.options.retry?.delayMs ?? DEFAULT_DELAY_MS;
    const sleep = this.options.sleep ?? wait;

    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.options.http.call(CONSUMER_CONFIG_PATH, "PUT", declaration);
        const gate = declaration.dependGlobalRessource.length ? declaration.dependGlobalRessource.join(", ") : "no gate";
        this.options.logger?.info?.(
          `[sso] declared ${declaration.redirectUri} (template ${declaration.template ?? "default"}, ${gate})`
        );
        return declaration;
      } catch (error) {
        const retryable = error instanceof SsoError && RETRYABLE.has(error.code);
        if (!retryable || attempt >= attempts) {
          // Loud, and never swallowed: an app that failed to declare itself boots
          // perfectly and refuses every sign-in afterwards, which is the failure
          // that costs an afternoon to trace back to here.
          this.options.logger?.error?.(`[sso] could not declare this app after ${attempt} attempt(s): ${String(error)}`);
          throw error;
        }
        this.options.logger?.warn?.(`[sso] declaring failed (${String(error)}), retrying in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }
  }

  /**
   * Redeem a pairing code, ONCE, to bring this app into existence.
   *
   * The code is single-use and short-lived by design: it installs and nothing
   * else, so what comes out of it is durable and the code itself has no business
   * surviving the moment. What the provider answers - the credential and what it
   * takes to receive its rotations - is handed straight back to the caller, which
   * is the only side entitled to write it into its own store.
   *
   * The answer is returned unread on purpose: its shape belongs to the provider,
   * and reading it here would pin this library to a contract that is still
   * settling. Give `installPath` when it lands somewhere other than the default.
   */
  async pair(params: {
    token: string;
    clientId: string;
    declaration?: Partial<SsoConsumerDeclaration>;
    /** Left out unless this application's queue was decided elsewhere. */
    amqpQueue?: string;
  }) {
    const path = this.options.installPath ?? "/api/v1/portal/install";

    // UNSIGNED, and it is the only call in this library that is: the code IS the
    // credential here, because the one it brings back does not exist yet.
    const payload = await this.options.http.unsigned(
      path,
      "POST",
      {
        clientId: params.clientId,
        declaration: { ...this.options.declaration, ...params.declaration },
        // Omitted rather than sent empty: the provider names it after the clientId,
        // and sending an undefined key would be sending a decision nobody made.
        ...(params.amqpQueue ? { amqpQueue: params.amqpQueue } : {}),
      },
      { "x-install-token": params.token }
    );

    const fields = asFields(payload);
    const secret = fields && typeof fields.secret === "string" ? fields.secret : null;
    if (!secret) {
      throw new SsoError("MALFORMED_ANSWER", "The pairing answer carried no secret: nothing can be signed with it");
    }

    // Everything else the provider chose to send travels back untouched: its shape
    // is the provider's, and reading it here would pin this library to a contract
    // that is still settling.
    return { clientId: params.clientId, secret, answer: payload };
  }
}
