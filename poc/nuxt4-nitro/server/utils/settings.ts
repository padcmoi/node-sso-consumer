import type { RowDataPacket } from "mysql2/promise";

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
 * the first crooked `split(',')` breaks.
 *
 * This is what replaces the hand-copied `.env` an installation used to need. The
 * pairing brings nineteen keys back and `save` puts them here, so nothing about the
 * identity, the callback, the gate or the broker is typed by anybody.
 */
interface SettingRow extends RowDataPacket {
  key: string;
  type: string;
  value: string;
}

export const settings = {
  /**
   * Everything, in one read, and it runs before anything else at boot.
   *
   * A key that was never written is ABSENT rather than `null`, which is what tells
   * "never set" apart from "set to nothing": an empty gate means this application
   * filters nothing, and that is a declaration rather than an absence.
   */
  async all() {
    const rows = await dbSelect<SettingRow>("SELECT `key`, `type`, `value` FROM app_settings");

    const held: Record<string, unknown> = {};
    for (const row of rows) {
      const value = readSetting(row.type, row.value);
      // A row somebody edited by hand, or one whose type and value no longer agree.
      // Skipped rather than fatal: a store that refuses to be read at all would stop
      // a boot over one bad line, and the library reads an absent key as never set.
      if (value === UNREADABLE) console.warn(`[settings] ${row.key} is not a readable ${row.type} and was ignored`);
      else held[row.key] = value;
    }
    return held;
  },

  /**
   * CREATE OR UPDATE each key given, and leave the others alone.
   *
   * An upsert, not a replacement: a key that did not exist is written, one that did
   * is overwritten, and one absent from the object stays what it was. The pairing
   * hands over everything at once, `INSTALLED` included, and does it in ONE
   * transaction - so there is no instant where this application believes itself
   * paired without holding what that announces.
   */
  async upsertAll(values: Record<string, unknown>) {
    const entries = Object.entries(values);
    if (!entries.length) return;

    const connection = await useDb().getConnection();
    try {
      await connection.beginTransaction();
      for (const [key, value] of entries) {
        const { type, text } = writeSetting(value);
        await connection.query(
          "INSERT INTO app_settings (`key`, `type`, `value`) VALUES (?, ?, ?) " +
            "ON DUPLICATE KEY UPDATE `type` = VALUES(`type`), `value` = VALUES(`value`)",
          [key, type, text]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },
};

/**
 * ── WHY `type` IS A COLUMN AND NOT A CONVENTION ────────────────────────────────
 *
 * The library hands over JavaScript values and takes JavaScript values back: a gate
 * is an array, a port is a number, `INSTALLED` is a boolean and the propagation
 * cursor is an object. Stored as one opaque blob, that shape survives only as long
 * as whoever reads it remembers to parse - and the first reader who does not is a
 * boot comparing the string 'false' to `false` and finding them different.
 *
 * Named in a column, the shape is a fact the table carries rather than a habit the
 * code has: a `SELECT` is readable by a human, and a row somebody edited by hand is
 * refused for the right reason instead of entering the environment as nonsense.
 *
 * `null` is one of the six because `save` takes `value ?? null`, and a key set to
 * nothing has to be tellable from a key never written - absent means 'never set',
 * which is what makes an empty gate a declaration rather than an omission.
 */
export type AppSettingType = "string" | "number" | "boolean" | "array" | "object" | "null";

/** A row that cannot be read, told apart from a row holding `null`. */
const UNREADABLE = Symbol("unreadable");

/** The stored pair, back as the value the library handed over. */
const readSetting = (type: string, value: string) => {
  if (type === "null") return null;
  if (type === "string") return value;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return UNREADABLE;
  }

  // The declared type is CHECKED against what came back rather than trusted: a row
  // saying `number` whose value parses to an array is corrupt, and letting it
  // through would put a shape downstream that nothing expects.
  if (type === "array") return Array.isArray(parsed) ? parsed : UNREADABLE;
  if (type === "object") return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : UNREADABLE;
  if (type === "number") return typeof parsed === "number" ? parsed : UNREADABLE;
  if (type === "boolean") return typeof parsed === "boolean" ? parsed : UNREADABLE;
  return UNREADABLE;
};

const typeOf = (value: unknown): AppSettingType => {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "string";
};

/**
 * The value, split into the pair the table holds.
 *
 * A string is stored RAW rather than JSON-encoded: it is the commonest of the
 * nineteen, and quoting every one would make the table unreadable to anybody
 * looking at it with a SQL client - which is half the point of naming the type.
 */
const writeSetting = (value: unknown) => {
  const type = typeOf(value);
  return { type, text: type === "string" ? String(value) : JSON.stringify(value ?? null) };
};
