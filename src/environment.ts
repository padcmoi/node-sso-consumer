import { randomBytes } from "node:crypto";
import { SsoError } from "./errors.js";
import type { SsoConsumerDeclaration } from "./types.js";

/**
 * The keys this library reads and writes in the application's own store.
 *
 * Named as environment variables because that is what they replace: until now they
 * were transcribed by hand into a `.env` from the console that minted the pairing
 * code, and that is the gesture people get wrong. Left unwired, an application
 * signs perfectly on its first boot and then misses every rotation - the secret is
 * replaced in x-core, the event is published to a queue nobody reads, and what
 * surfaces days later is a `401` on every call with no cause named anywhere.
 *
 * Written as constants rather than spelled out at each use: a key mistyped in one
 * place and right in another is a value written where nothing reads it.
 */
export const ENV = {
  /** `true` once the pairing code has been exchanged. Nothing else decides it. */
  INSTALLED: "INSTALLED",
  /** Seals the session cookie. Minted here at the first boot, never received. */
  SSO_SESSION_PASSWORD: "SSO_SESSION_PASSWORD",

  /** The cookie this application seals its session into, named after its identity. */
  SSO_SESSION_COOKIE_NAME: "SSO_SESSION_COOKIE_NAME",
  /** The identity it signs as. */
  SSO_CLIENT_ID: "SSO_CLIENT_ID",
  /** Where the SSO sends the browser back. */
  SSO_REDIRECT_URI: "SSO_REDIRECT_URI",
  /** Where a reader who gives up on signing in lands. */
  SSO_CANCEL_URI: "SSO_CANCEL_URI",
  /**
   * The portal: where a sign-out lands, and the only place anyone signs in.
   *
   * ONE address for three exits, and they are the same exit seen from three sides:
   * a reader who signs out, a session refused because it is over, and a session
   * revoked from somewhere else all end up in the same place - the portal, which is
   * the only thing in this ecosystem that signs a human in.
   *
   * It comes from the provider rather than from the address book: x-core is what
   * serves the portal and what knows which one an application belongs to. A copy
   * written down here would keep sending readers to an address that moved, and a
   * sign-out landing on nothing reads as broken rather than as stale.
   */
  SSO_PORTAL_URL: "SSO_PORTAL_URL",
  /** The look of the login screen. */
  SSO_TEMPLATE: "SSO_TEMPLATE",
  /** The gate, an ARRAY: empty means this application filters nothing. */
  SSO_DEPEND_GLOBAL_RESSOURCE: "SSO_DEPEND_GLOBAL_RESSOURCE",

  /** What the application configures its propagation consumer with. */
  HMAC_AMQP_QUEUE: "HMAC_AMQP_QUEUE",
  HMAC_PROPAGATION_SECRET: "HMAC_PROPAGATION_SECRET",
  HMAC_AMQP_VHOST: "HMAC_AMQP_VHOST",
  HMAC_AMQP_BROKER_QUEUE: "HMAC_AMQP_BROKER_QUEUE",

  /** Where the broker is, and who to be on it. */
  RABBITMQ_PROTOCOL: "RABBITMQ_PROTOCOL",
  RABBITMQ_HOST: "RABBITMQ_HOST",
  RABBITMQ_PORT: "RABBITMQ_PORT",
  RABBITMQ_USER: "RABBITMQ_USER",
  RABBITMQ_PASSWORD: "RABBITMQ_PASSWORD",

  /**
   * Where the propagation queue is up to, so a redelivered rotation is applied
   * once. Written by this library, never by the pairing: it is a position, not a
   * setting, and the only key here that x-core knows nothing about.
   */
  HMAC_PROPAGATION_CURSOR: "HMAC_PROPAGATION_CURSOR",
} as const;

/**
 * The application's own store, as this library uses it.
 *
 * A key/value shelf whose VALUES ARE JSON - not strings. A gate is a list, a port
 * is a number, `INSTALLED` is a boolean, and flattening them into text would make
 * every reader responsible for unfolding them again: one more convention, unwritten,
 * that the first crooked `split(",")` breaks.
 *
 * Where it lives is not this library's business. A table, a vault, a file, a stub in
 * a test - it hands an object over and takes one back.
 */
export interface XcoreEnvironmentStore {
  /**
   * Everything, in one read, and it runs before anything else.
   *
   * Four things come out of it: `INSTALLED`, which decides whether the pairing code
   * is exchanged; `SSO_SESSION_PASSWORD`, without which no cookie opens;
   * `SSO_CLIENT_ID`, without which this library does not know what to sign as; and
   * the declaration, which is sent back to the provider at every boot.
   *
   * Not key by key: that would be seventeen round trips at every boot for seventeen
   * values that are read together, and a seventeenth that failed would leave an
   * application half configured with nothing having said so.
   *
   * A key that was never written is ABSENT, not `null` - which is what tells "never
   * set" apart from "set to nothing". An empty gate means this application filters
   * nothing, and that is a declaration rather than an absence.
   */
  load(): Promise<Record<string, unknown>> | Record<string, unknown>;

  /**
   * CREATE OR UPDATE each key given, and leave the others alone.
   *
   * An upsert, not a replacement: a key that did not exist is written, one that did
   * is overwritten, and one absent from the object stays what it was. Neither a
   * `DELETE` followed by an `INSERT`, nor an `UPDATE` that fails for want of a row -
   * the first pairing has nothing in front of it and every boot after has everything.
   *
   * Atomic over what it is given. The pairing hands it everything at once,
   * `INSTALLED` included, and that is what guarantees there is no instant where an
   * application believes itself paired without holding what that announces.
   */
  save(values: Record<string, unknown>): Promise<void> | void;
}

const SESSION_PASSWORD_BYTES = 32;

/** 43 base64url characters, which clears the 32 the seal refuses to go below. */
export const mintSessionPassword = () => randomBytes(SESSION_PASSWORD_BYTES).toString("base64url");

const text = (values: Record<string, unknown>, key: string) => (typeof values[key] === "string" ? values[key] : null);

/**
 * What the store said, once, held for the life of the process.
 *
 * Everything downstream reads THROUGH this rather than being handed values at
 * construction: at construction there is nothing to hand: the identity, the
 * declaration and the sealing password all arrive from the store, and the store is
 * read inside `start()`.
 *
 * Reading before that raises, and says which call is missing. The alternative is an
 * application that signs as `undefined` and gets a `401` naming nothing.
 */
export class SsoEnvironment {
  private values: Record<string, unknown> | null = null;

  hydrate(values: Record<string, unknown>) {
    this.values = values;
  }

  /** Everything the store holds, for whoever wires the broker consumer with it. */
  get all() {
    return { ...this.ready };
  }

  /** Whether the pairing code has been exchanged. The one thing that decides it. */
  get installed() {
    return this.ready[ENV.INSTALLED] === true;
  }

  get clientId() {
    return this.required(ENV.SSO_CLIENT_ID);
  }

  get sessionPassword() {
    return this.required(ENV.SSO_SESSION_PASSWORD);
  }

  get cookieName() {
    return this.required(ENV.SSO_SESSION_COOKIE_NAME);
  }

  /**
   * What this application declares itself to be, read back rather than retyped.
   *
   * `declare()` sends this at every boot, so it has to be what the console recorded:
   * a copy kept in the application's own code would win over the operator's the day
   * the two differed, and a callback URL replaced that way breaks the login with
   * nothing saying so.
   */
  get declaration() {
    const values = this.ready;
    const gate = values[ENV.SSO_DEPEND_GLOBAL_RESSOURCE];

    const declaration: SsoConsumerDeclaration = {
      redirectUri: this.required(ENV.SSO_REDIRECT_URI),
      cancelUri: text(values, ENV.SSO_CANCEL_URI) ?? undefined,
      template: text(values, ENV.SSO_TEMPLATE) ?? undefined,
      // An ARRAY whether it is empty or not: an optional field is only written when
      // provided, so omitting it could set a gate and never clear one.
      dependGlobalRessource: Array.isArray(gate) ? gate.filter((value) => typeof value === "string") : [],
    };
    return declaration;
  }

  /**
   * Where a signed-out browser goes, as the provider said it - or nothing.
   *
   * Nothing rather than a guess: the caller falls back on the address book, which
   * is what answers for an application paired before this key existed. A value
   * invented here would be indistinguishable from one the provider sent.
   */
  get portalUrl() {
    return text(this.ready, ENV.SSO_PORTAL_URL);
  }

  /** The resource this application IS, taken from the gate it already declares. */
  get resource() {
    return this.declaration.dependGlobalRessource[0];
  }

  private get ready() {
    if (!this.values) {
      throw new SsoError(
        "MALFORMED_ANSWER",
        "This bridge has not read its environment yet: await start() before serving, it is what loads the identity everything else signs with"
      );
    }
    return this.values;
  }

  private required(key: string) {
    const value = text(this.ready, key);
    if (!value) {
      throw new SsoError(
        "MALFORMED_ANSWER",
        `${key} is missing from this application's environment: it is written at pairing, so a store that lost it has to be paired again`
      );
    }
    return value;
  }
}
