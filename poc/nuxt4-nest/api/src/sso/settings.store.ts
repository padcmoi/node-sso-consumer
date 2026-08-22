import { Injectable, Logger } from "@nestjs/common";
import type { RowDataPacket } from "mysql2/promise";
import { DatabaseService } from "../database/database.service";

interface SettingRow extends RowDataPacket {
  key: string;
  value: string;
}

/**
 * This application's own key/value shelf, and one of the two things it lends the
 * library.
 *
 * TWO FUNCTIONS around a table, and the library knows nothing else about it: it
 * hands an object over and takes one back. Where the rows live - here MariaDB,
 * elsewhere a vault or a file - is this application's business.
 *
 * The VALUES ARE JSON, not strings. A gate is a list, a port is a number and
 * `INSTALLED` is a boolean; flattening them into text would make every reader
 * responsible for unfolding them again, which is one more unwritten convention that
 * the first crooked `split(",")` breaks.
 *
 * This is what replaces the hand-copied `.env` an installation used to need. The
 * pairing brings nineteen keys back and `save` puts them here, so nothing about the
 * identity, the callback, the gate or the broker is typed by anybody.
 */
@Injectable()
export class SettingsStore {
  private readonly logger = new Logger(SettingsStore.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Everything, in one read, and it runs before anything else at boot.
   *
   * A key that was never written is ABSENT rather than `null`, which is what tells
   * "never set" apart from "set to nothing": an empty gate means this application
   * filters nothing, and that is a declaration rather than an absence.
   */
  async all() {
    const rows = await this.db.select<SettingRow>("SELECT `key`, `value` FROM app_settings");

    const held: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        held[row.key] = JSON.parse(row.value);
      } catch {
        // A row somebody edited by hand. Skipped rather than fatal: a store that
        // refuses to be read at all would stop a boot over one bad line.
        this.logger.warn(`${row.key} is not JSON and was ignored`);
      }
    }
    return held;
  }

  /**
   * CREATE OR UPDATE each key given, and leave the others alone.
   *
   * An upsert, not a replacement. The pairing hands everything over at once,
   * `INSTALLED` included, and does it in ONE transaction - so there is no instant
   * where this application believes itself paired without holding what that
   * announces.
   */
  async upsertAll(values: Record<string, unknown>) {
    const entries = Object.entries(values);
    if (!entries.length) return;

    const connection = await this.db.connection();
    try {
      await connection.beginTransaction();
      for (const [key, value] of entries) {
        await connection.query(
          "INSERT INTO app_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
          [key, JSON.stringify(value ?? null)]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
