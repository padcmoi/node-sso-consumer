import { createPropagator, type PropagationRedisClient } from "@naskot/node-hmac-auth-core-propagation";
import { ENV, type SsoEnvironment, type XcoreEnvironmentStore } from "./environment.js";
import type { XcoreHmacInjection } from "./http.js";
import type { SsoLogger } from "./types.js";

/**
 * The credential queue, consumed HERE rather than by every application.
 *
 * It is in this library for a reason of ownership rather than of convenience.
 * `@naskot/node-hmac-auth-core` does not speak to a broker - it stores credentials
 * and signs with them - and the propagation is a package of its own. Installing that
 * package in every consuming application would mean each of them wiring a queue, a
 * signed ACK and a reconnection for something it never reads itself.
 *
 * And this library is the only side that ever holds what the connection needs. x-core
 * created the queue and the broker account when the pairing code was minted; the nine
 * values come back in the install answer and the row is deleted in the same breath.
 * Nobody else will ever hand them over.
 *
 * WITHOUT IT, A PAIRED APPLICATION SIGNS NOTHING. The install answer carries a secret
 * in clear, but it is not what signs: x-core stores `hashClientSecret(secret, pepper)`
 * and verifies against that, and the pepper never travels. What works is the hash
 * x-core computed, and it only ever travels on this queue.
 */

/**
 * One value of the store, as text, or empty.
 *
 * The store holds JSON, so a key could be anything an application saved into it.
 * Anything that is not a string reads as absent rather than as `[object Object]`:
 * a broker host that stringified an object would be dialled, fail, and be blamed on
 * the network.
 */
const text = (identity: SsoEnvironment, key: string) => {
  const held = identity.all[key];
  return typeof held === "string" ? held : "";
};

/** The nine values the pairing brought back, as the propagator wants them. */
const connectionOf = (identity: SsoEnvironment) => {
  const port = identity.all[ENV.RABBITMQ_PORT];
  // The one vhost credentials travel on. Narrowed rather than trusted: the
  // propagator's own type names it, and anything else is that field left unset.
  const vhost = text(identity, ENV.HMAC_AMQP_VHOST) === "hmac-credentials" ? ("hmac-credentials" as const) : undefined;

  return {
    amqpProtocol: text(identity, ENV.RABBITMQ_PROTOCOL) === "amqp" ? ("amqp" as const) : ("amqps" as const),
    amqpHost: text(identity, ENV.RABBITMQ_HOST),
    amqpPort: typeof port === "number" ? port : Number(port ?? 5671),
    amqpUser: text(identity, ENV.RABBITMQ_USER),
    amqpPassword: text(identity, ENV.RABBITMQ_PASSWORD),
    amqpVhost: vhost,
    amqpQueue: text(identity, ENV.HMAC_AMQP_QUEUE),
    propagationSecret: text(identity, ENV.HMAC_PROPAGATION_SECRET),
  };
};

/** Everything needed is there, or the queue is not opened at all. */
const isComplete = (connection: ReturnType<typeof connectionOf>) =>
  Boolean(connection.amqpHost && connection.amqpUser && connection.amqpQueue && connection.propagationSecret);

/**
 * The credential store, as the propagator expects to find it.
 *
 * Built from the two injected functions rather than being the application's own
 * instance. The propagator wants an object with a `clients` on it; on the receiving
 * path it touches exactly two of its methods, and both have an injected equivalent.
 * So the object crosses no boundary: this shape is assembled here, from functions,
 * and thrown away with the process.
 */
const credentialStoreOf = (hmac: XcoreHmacInjection) => ({
  clients: {
    setSecretHash: async (clientId: string, secretHash: string) => {
      await hmac.setCredential(clientId, secretHash);
    },
    delete: async (clientId: string) => {
      await hmac.deleteCredential?.(clientId);
    },
  },
});

/**
 * The cursor's storage, over the key/value store the application already lends.
 *
 * The propagator keeps a monotonic cursor so a redelivered event is not applied
 * twice, and it asks for a Redis-shaped client to keep it in. Rather than requiring a
 * second connection - and with it a setting, and a dependency an application did not
 * choose - the handful of hash operations it uses on this path are mapped onto
 * `environment`, which is already a key/value store holding JSON.
 *
 * Only what the receiving path calls is implemented. The rest belongs to management
 * mode, which a consumer never runs: it publishes nothing.
 */
function cursorStoreOf(environment: XcoreEnvironmentStore) {
  const read = async (key: string) => {
    const all = await environment.load();
    const held = all[`${ENV.HMAC_PROPAGATION_CURSOR}:${key}`];
    return held && typeof held === "object" ? (held as Record<string, string>) : {};
  };
  const write = (key: string, fields: Record<string, string>) =>
    environment.save({ [`${ENV.HMAC_PROPAGATION_CURSOR}:${key}`]: fields });

  const unused = () => Promise.resolve(undefined);

  return {
    hGet: async (key, field) => (await read(key))[field] ?? null,
    hSet: async (key, fields) => write(key, { ...(await read(key)), ...fields }),
    hGetAll: read,
    hDel: async (key, field) => {
      const held = await read(key);
      for (const name of Array.isArray(field) ? field : [field]) delete held[name];
      return write(key, held);
    },
    // The ack store, which only a publisher fills. A consumer answers its ACKs and
    // keeps no tally of them.
    sAdd: unused,
    sRem: unused,
    sCard: () => Promise.resolve(0),
    expire: unused,
    del: unused,
  } satisfies PropagationRedisClient;
}

export interface SsoPropagationOptions {
  identity: SsoEnvironment;
  hmac: XcoreHmacInjection;
  environment: XcoreEnvironmentStore;
  logger?: SsoLogger;
}

/**
 * Open the queue and keep it open, or say why it was not opened.
 *
 * RECEIVE-ONLY, and that is the whole of what a consumer does: no `management`, so
 * the propagator never publishes and never has to sign an outbound event - which it
 * could not do anyway, since signing an ACK needs the SENDER's own propagation
 * secret, held out of band.
 *
 * Best effort by design. A broker that is down is not a reason to refuse to boot: the
 * application keeps signing with the credential it already holds, and the connection
 * comes back on its own. What it must never do is fail silently, so it is logged
 * loudly - an application that misses its rotations signs perfectly today and
 * collects a `401` on everything in a week, with nothing naming the cause.
 */
export async function startPropagation(options: SsoPropagationOptions) {
  const connection = connectionOf(options.identity);
  if (!isComplete(connection)) {
    options.logger?.warn?.(
      "[sso] no broker in the store: credential rotations will not arrive, and this application will sign with a dead key the day one happens"
    );
    return null;
  }

  try {
    const propagator = await createPropagator({
      ...connection,
      redis: cursorStoreOf(options.environment),
      // Two escape hatches, and both are deliberate. The propagator asks for a whole
      // `InitializedHmacHttpAuth` and for its own logger shape; on the receiving path
      // it uses two methods of the first and three of the second. Implementing the
      // rest to satisfy a type would be writing code nothing calls, and asking an
      // application for the real objects would be the coupling this whole boundary
      // exists to avoid.
      hmacHttpAuth: credentialStoreOf(options.hmac) as never,
      logger: options.logger as never,
    });
    options.logger?.info?.(`[sso] listening for credential rotations on ${connection.amqpQueue}`);
    return propagator;
  } catch (cause) {
    options.logger?.error?.(`[sso] could not open the credential queue ${connection.amqpQueue}: ${String(cause)}`);
    return null;
  }
}
