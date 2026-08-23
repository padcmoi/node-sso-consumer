import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import mysql from "mysql2/promise";
import type { Pool, RowDataPacket } from "mysql2/promise";

/**
 * The database this application owns, and the two tables that are left in it.
 *
 * There is no `users` table, no `password_hash` column, no `sessions` table and no
 * permission table. That is the point: they are what the library REPLACED, not what
 * it wraps. A local session row is precisely what cannot honour a revocation - it
 * would still be valid - so the session lives in x-core and what is held here is one
 * sealed cookie at the reader's end.
 *
 *   app_settings     this application's own key/value shelf, which the pairing fills
 *   hmac_credential  the hash it signs x-core's API with, delivered by the broker
 */
const SCHEMA = [
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

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor() {
    this.pool = mysql.createPool({
      // The host and the port are written rather than read: the database is a
      // sibling container and `db` is a network alias the compose declares. The
      // credentials are the container's own, so they come from where the container
      // gets them.
      host: process.env.DB_HOST ?? "db",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "console",
      password: process.env.DB_PASSWORD ?? "",
      database: process.env.DB_NAME ?? "console",
      waitForConnections: true,
      connectionLimit: 5,
      charset: "utf8mb4_general_ci",
    });
  }

  /**
   * The shelf, built before anything reads it - and this is where Nest is simply
   * better than what the Nitro POC could do.
   *
   * There, the schema and the SSO boot were two plugins, Nitro does not await its
   * plugins, and the boot read `app_settings` while the `CREATE TABLE`s were still
   * in flight: the pairing came back `not-paired` on a token that was perfectly
   * good. It had to be fixed with a memoised promise both sides awaited.
   *
   * Here the ordering is the module graph. `XcoreModule` imports this one, Nest
   * awaits every `onModuleInit` before any `onApplicationBootstrap`, and the bridge
   * starts in the second. There is nothing to remember and nothing to race.
   */
  async onModuleInit() {
    await this.waitForDb();
    for (const statement of SCHEMA) await this.execute(statement);
    this.logger.log("schema ready");
  }

  onModuleDestroy() {
    return this.pool.end();
  }

  async select<T extends RowDataPacket>(sql: string, params: unknown[] = []) {
    const [rows] = await this.pool.query<T[]>(sql, params);
    return rows;
  }

  async execute(sql: string, params: unknown[] = []) {
    await this.pool.query(sql, params);
  }

  /** For the one write that must not be half-applied: the pairing's nineteen keys. */
  connection() {
    return this.pool.getConnection();
  }

  /**
   * The database and this process go up together. Two minutes of patience rather
   * than a boot that dies on the first refused connection and takes the container
   * with it into a restart loop.
   */
  private async waitForDb() {
    for (let attempt = 1; attempt <= 60; attempt++) {
      try {
        await this.select("SELECT 1");
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    throw new Error("database unreachable");
  }
}
