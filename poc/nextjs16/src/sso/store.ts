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
  `CREATE TABLE IF NOT EXISTS app_settings (
    \`key\` VARCHAR(190) NOT NULL PRIMARY KEY,
    \`value\` LONGTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS hmac_credential (
    client_id VARCHAR(190) NOT NULL PRIMARY KEY,
    secret_hash VARCHAR(255) NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

interface SettingRow extends RowDataPacket {
  key: string;
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
 * This application's key/value shelf. The VALUES ARE JSON, not strings: a gate is a
 * list, a port is a number and `INSTALLED` is a boolean, and flattening them into
 * text would make every reader responsible for unfolding them again.
 *
 * This is what replaces the hand-copied `.env` an installation used to need.
 */
export const settingsOf = (pool: Pool) => ({
  async all() {
    const [rows] = await pool.query<SettingRow[]>("SELECT `key`, `value` FROM app_settings");

    const held: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        held[row.key] = JSON.parse(row.value);
      } catch {
        // A row somebody edited by hand. Skipped rather than fatal: a store that
        // refuses to be read at all would stop a boot over one bad line.
        console.warn(`[settings] ${row.key} is not JSON and was ignored`);
      }
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
    const [rows] = await pool.query<CredentialRow[]>("SELECT secret_hash FROM hmac_credential WHERE client_id = ?", [
      clientId,
    ]);
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
