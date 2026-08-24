import mysql from "mysql2/promise";
import type { Pool, RowDataPacket } from "mysql2/promise";

/**
 * The database this application owns, and the two things it lends the library.
 *
 * There is no `users` table, no `password_hash` column, no `sessions` table and no
 * permission table. That is what the library REPLACED, not what it wraps: a local
 * session row is precisely what cannot honour a revocation - it would still be
 * valid - so the session lives in x-core and what is held here is one sealed cookie
 * at the reader's end.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS app_sso_accounts (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    origin ENUM('sso','local') NOT NULL,
    first_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    email VARCHAR(320) NULL,
    display_name VARCHAR(190) NULL,
    first_name VARCHAR(190) NULL,
    last_name VARCHAR(190) NULL,
    avatar_url VARCHAR(1024) NULL,
    UNIQUE KEY uq_app_sso_accounts_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    \`key\` VARCHAR(190) NOT NULL PRIMARY KEY,
    \`type\` ENUM('string','number','boolean','array','object','null') NOT NULL,
    \`value\` LONGTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // ── REPRISE DE L'ANCIENNE FORME, UNE FOIS ────────────────────────────────
  //
  // `CREATE TABLE IF NOT EXISTS` ne touche pas une table qui existe deja, et les
  // deploiements appaires avant cette version en portent une sans `type`, avec des
  // chaines encodees en JSON. Les relire avec le nouveau lecteur donnerait un
  // `type` vide sur chaque ligne, donc un magasin illisible, donc un `INSTALLED`
  // absent - et un reappairage avec un jeton deja depense.
  //
  // Idempotent des deux cotes : `IF NOT EXISTS` sur les colonnes, et le remplissage
  // ne touche que les lignes dont le type n'a jamais ete ecrit.
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS \`type\` ENUM('string','number','boolean','array','object','null') NOT NULL DEFAULT 'string' AFTER \`key\``,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `UPDATE app_settings SET \`type\` = CASE
      WHEN \`value\` = 'null' THEN 'null'
      WHEN \`value\` IN ('true','false') THEN 'boolean'
      WHEN \`value\` REGEXP '^-?[0-9]+(\\\\.[0-9]+)?$' THEN 'number'
      WHEN \`value\` LIKE '[%' THEN 'array'
      WHEN \`value\` LIKE '{%' THEN 'object'
      ELSE 'string' END
    WHERE \`value\` LIKE '"%' OR \`value\` LIKE '[%' OR \`value\` LIKE '{%'
       OR \`value\` IN ('true','false','null') OR \`value\` REGEXP '^-?[0-9]'`,
  // Les chaines etaient stockees entre guillemets JSON ; elles sont brutes
  // desormais, sinon le lecteur rendrait `"oauth-tvx"` guillemets compris.
  `UPDATE app_settings SET \`value\` = JSON_UNQUOTE(\`value\`) WHERE \`type\` = 'string' AND \`value\` LIKE '"%'`,
  `CREATE TABLE IF NOT EXISTS hmac_credential (
    client_id VARCHAR(190) NOT NULL PRIMARY KEY,
    secret_hash VARCHAR(255) NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

interface SettingRow extends RowDataPacket {
  key: string;
  type: string;
  value: string;
}

interface CredentialRow extends RowDataPacket {
  secret_hash: string;
}

export const createPool = () =>
  mysql.createPool({
    // Written rather than read: the database is a sibling container and `db` is a
    // network alias the compose declares. The credentials are the container's own,
    // so they come from where the container gets them.
    host: process.env.DB_HOST ?? "db",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "console",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "console",
    waitForConnections: true,
    connectionLimit: 5,
    charset: "utf8mb4_general_ci",
  });

/**
 * The shelf, built once and awaited before the first boot of the bridge.
 *
 * The database and this process go up together, so this waits rather than dying on
 * the first refused connection and taking the container into a restart loop.
 */
export const buildSchema = async (pool: Pool) => {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch {
      if (attempt === 60) throw new Error("database unreachable");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  for (const statement of SCHEMA) await pool.query(statement);
};

/**
 * `di.accounts` in `mode: "sso"` - ONE function, and the only one that means anything
 * here.
 *
 * There is no directory to read: x-core answers who is there. What this application
 * needs is a ROW to hang a foreign key on, because a key cannot cross two databases
 * and the account lives in x-core's.
 *
 * `last_seen_at` is written EXPLICITLY rather than left to `ON UPDATE
 * CURRENT_TIMESTAMP`: MariaDB only fires that when a column value actually changes,
 * and a reader signing in with the same name changes nothing.
 */
export const accountsOf = (pool: Pool) => ({
  async seen(account: XcoreSeenAccount) {
    await pool.query(
      `INSERT INTO app_sso_accounts (id, origin, email, display_name, first_name, last_name, avatar_url, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE
         email = VALUES(email), display_name = VALUES(display_name),
         first_name = VALUES(first_name), last_name = VALUES(last_name),
         avatar_url = VALUES(avatar_url), last_seen_at = CURRENT_TIMESTAMP(6)`,
      [account.id, account.origin, account.email, account.displayName, account.firstName, account.lastName, account.avatarUrl]
    );
  },
});

/**
 * This application's key/value shelf, and what replaces the hand-copied `.env` an
 * installation used to need. Every value carries its TYPE in its own column - see
 * `readSetting` below for why.
 */
export const settingsOf = (pool: Pool) => ({
  async all() {
    const [rows] = await pool.query<SettingRow[]>("SELECT `key`, `type`, `value` FROM app_settings");

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
   * An upsert, not a replacement, and in ONE transaction: the pairing hands over
   * nineteen keys at once, `INSTALLED` included, so there is no instant where this
   * application believes itself paired without holding what that announces.
   */
  async upsertAll(values: Record<string, unknown>) {
    const entries = Object.entries(values);
    if (!entries.length) return;

    const connection = await pool.getConnection();
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
});

/**
 * The HMAC hash this application signs x-core's API with.
 *
 * A HASH, never a secret. x-core keeps `hashClientSecret(secret, pepper)` and
 * verifies against that, and the pepper never travels: an application that hashed
 * the pairing's secret itself would sign with something else and collect a `401` on
 * every call while holding the right secret. What works is the hash X-CORE COMPUTED,
 * and it only ever arrives on the propagation queue the library opens itself - so
 * this table is EMPTY between the pairing and the first message from the broker.
 */
export const credentialsOf = (pool: Pool) => ({
  /**
   * READ ON EVERY SIGNED CALL and never captured: the credential is replaced by
   * propagation, and a client built once at boot would sign with the old one until
   * the next restart.
   */
  async get(clientId: string) {
    const [rows] = await pool.query<CredentialRow[]>("SELECT secret_hash FROM hmac_credential WHERE client_id = ?", [clientId]);
    return rows[0]?.secret_hash ?? null;
  },

  async set(clientId: string, secretHash: string) {
    await pool.query(
      "INSERT INTO hmac_credential (client_id, secret_hash) VALUES (?, ?) ON DUPLICATE KEY UPDATE secret_hash = VALUES(secret_hash)",
      [clientId, secretHash]
    );
  },

  async remove(clientId: string) {
    await pool.query("DELETE FROM hmac_credential WHERE client_id = ?", [clientId]);
  },
});

/**
 * ── WHY `type` IS A COLUMN AND NOT A CONVENTION ────────────────────────────────
 *
 * The library hands over JavaScript values and takes JavaScript values back: a gate
 * is an array, a port is a number, `INSTALLED` is a boolean and the propagation
 * cursor is an object. Stored as one opaque blob, that shape survives only as long
 * as whoever reads it remembers to parse - and the first reader who does not is a
 * boot comparing the string "false" to `false` and finding them different.
 *
 * Named in a column, the shape is a fact the table carries rather than a habit the
 * code has: a `SELECT` is readable by a human, and a row somebody edited by hand is
 * refused for the right reason instead of entering the environment as nonsense.
 *
 * `null` is one of the six because `save` takes `value ?? null`, and a key set to
 * nothing has to be tellable from a key never written - absent means "never set",
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
