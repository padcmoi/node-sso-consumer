import { Injectable } from "@nestjs/common";
import type { RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";

interface CredentialRow extends RowDataPacket {
  secret_hash: string;
}

/**
 * Where this application keeps the HMAC hash it signs x-core's API with.
 *
 * A table here because this POC has no Redis. A real console hands the three
 * closures below onto `@naskot/node-hmac-auth-core`'s own store instead - its Redis,
 * its namespace - and that is the point of the shape: the library names no method of
 * that package, it knows three moments, and this file knows how.
 *
 * A HASH, never a secret. The pairing answer does carry a secret in clear, but it is
 * not what signs: x-core stores `hashClientSecret(secret, pepper)` and verifies
 * against that, and the pepper is its own and never travels. An application that
 * hashed the secret itself would store something else, sign with it, and collect a
 * `401 BAD_SIGNATURE` on every call while holding the right secret.
 *
 * What works is the hash X-CORE COMPUTED, and it only ever arrives on the propagation
 * queue - which the library opens itself. So this table is EMPTY between the pairing
 * and the first message from the broker, and that is a state rather than a fault:
 * `declare()` retries on it.
 */
@Injectable()
export class CredentialsStore {
  constructor(private readonly db: DatabaseService) {}

  /**
   * The current hash, READ ON EVERY SIGNED CALL and never captured.
   *
   * The credential is replaced by propagation, and a client built once at boot would
   * sign with the old one until the next restart - which surfaces as a `401` on
   * everything, with nothing naming the cause.
   */
  async get(clientId: string) {
    const rows = await this.db.select<CredentialRow>("SELECT secret_hash FROM hmac_credential WHERE client_id = ?", [
      clientId,
    ]);
    return rows[0]?.secret_hash ?? null;
  }

  /** Store what arrived on the queue. Called on the first delivery and every rotation. */
  async set(clientId: string, secretHash: string) {
    await this.db.execute(
      "INSERT INTO hmac_credential (client_id, secret_hash) VALUES (?, ?) ON DUPLICATE KEY UPDATE secret_hash = VALUES(secret_hash)",
      [clientId, secretHash]
    );
  }

  /** The provider says this identity is gone. */
  async remove(clientId: string) {
    await this.db.execute("DELETE FROM hmac_credential WHERE client_id = ?", [clientId]);
  }
}
