import { SsoError } from "./errors.js";
import { asFields } from "./parse.js";
import { ENV, type SsoEnvironment } from "./environment.js";
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
  /**
   * What this application IS, read back from its own store rather than written here.
   *
   * The declaration was recorded on the console when the pairing code was minted,
   * and `declare()` sends it again at every boot. A copy kept in the application's
   * own code would be a second source, and it would WIN: the day the two differ, the
   * boot silently replaces what an operator set, and a callback URL moved that way
   * breaks the login with nothing saying so.
   */
  identity: SsoEnvironment;
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

const text = (fields: Record<string, unknown> | null, key: string) =>
  fields && typeof fields[key] === "string" ? fields[key] : null;

/**
 * The pairing answer, laid out as the keys the application's store holds.
 *
 * Mapped HERE and in one place: the provider's shape is its own and it is still
 * settling, so a second reading of it somewhere downstream is a second thing to
 * update the day a field moves.
 *
 * The HMAC credential is NOT among them. It goes to `hmac.setSecret`, into the store
 * that signs with it, and never into a key/value shelf beside a broker password.
 */
function environmentOf(fields: Record<string, unknown> | null) {
  const propagation = asFields(fields?.propagation);
  const account = asFields(propagation?.account);
  const gate = fields?.dependGlobalRessource;

  const values: Record<string, unknown> = {
    [ENV.SSO_CLIENT_ID]: text(fields, "clientId"),
    [ENV.SSO_SESSION_COOKIE_NAME]: text(fields, "sessionCookieName"),
    [ENV.SSO_REDIRECT_URI]: text(fields, "redirectUri"),
    [ENV.SSO_CANCEL_URI]: text(fields, "cancelUri"),
    // Where a sign-out lands. Sent by the provider because the provider is what
    // serves it, and a constant here would outlive the address.
    [ENV.SSO_PORTAL_URL]: text(fields, "portalUrl"),
    [ENV.SSO_TEMPLATE]: text(fields, "template"),
    // An ARRAY, and an empty one is a declaration - "this application filters
    // nothing" - rather than an absence, so it is kept even when it is empty.
    [ENV.SSO_DEPEND_GLOBAL_RESSOURCE]: Array.isArray(gate) ? gate : [],

    [ENV.HMAC_AMQP_QUEUE]: text(propagation, "amqpQueue"),
    [ENV.HMAC_PROPAGATION_SECRET]: text(propagation, "propagationSecret"),
    [ENV.HMAC_AMQP_BROKER_QUEUE]: text(propagation, "brokerQueue"),
    [ENV.HMAC_AMQP_VHOST]: text(account, "vhost"),

    [ENV.RABBITMQ_PROTOCOL]: text(account, "protocol"),
    [ENV.RABBITMQ_HOST]: text(account, "host"),
    [ENV.RABBITMQ_PORT]: typeof account?.port === "number" ? account.port : null,
    [ENV.RABBITMQ_USER]: text(account, "username"),
    [ENV.RABBITMQ_PASSWORD]: text(account, "password"),
  };

  // A field the provider did not send is DROPPED rather than written as null: `save`
  // is an upsert, and writing null would overwrite a value that was already there
  // with an emptiness nobody decided.
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined));
}

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
    url.searchParams.set("consumer", this.options.identity.clientId);
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
    const declaration: SsoConsumerDeclaration = { ...this.options.identity.declaration, ...params.overrides };
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
   * Redeem the pairing code, ONCE, and collect everything built for this app.
   *
   * The code is single-use and short-lived by design: it installs and nothing else,
   * so what comes out of it is durable and the code itself has no business surviving
   * the moment. x-core deletes the row in the same breath and revokes the
   * infrastructure manager key it had borrowed.
   *
   * NOTHING IS CREATED by this call. The queue, the broker account, the SSO consumer
   * and the HMAC credential were all made when the code was MINTED, on the console,
   * in front of whoever minted it - so a boot either finds its credential waiting or
   * finds nothing at all, and never fails half way.
   *
   * There is NO BODY, and that is the shape of the contract: an application still
   * able to send its own callback URL here would be one able to point somebody
   * else's installation at itself. It is also the only unsigned call this library
   * makes - the code IS the credential here, because the one it brings back does not
   * exist yet.
   */
  async pair(params: { token: string }) {
    const path = this.options.installPath ?? "/api/v1/portal/install";
    const payload = await this.options.http.unsigned(path, "POST", undefined, { "x-install-token": params.token });

    const fields = asFields(payload);
    const clientId = fields && typeof fields.clientId === "string" ? fields.clientId : null;
    const secret = fields && typeof fields.secret === "string" ? fields.secret : null;

    // Both or nothing. A credential with no identity cannot be signed with, and an
    // identity with no credential is an application that boots and then fails every
    // call with a 401 naming nothing.
    if (!clientId || !secret) {
      throw new SsoError(
        "MALFORMED_ANSWER",
        `The pairing answer carried no ${!clientId ? "identity" : "secret"}: there is nothing to sign with`
      );
    }

    return { clientId, secret, environment: environmentOf(fields) };
  }
}
