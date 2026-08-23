import type { RowDataPacket } from 'mysql2/promise'

/**
 * The schema, and what is NOT in it any more.
 *
 * There is no `users` table, no `password_hash` column, no `sessions` table and no
 * permission table. That is the whole point of this POC: they are what the library
 * replaced, not what it wraps. A local session row is precisely what cannot honour a
 * revocation - it would still be valid - so the session lives in x-core and what is
 * held here is one sealed cookie at the reader's end.
 *
 * Three tables are left and none of them is a session:
 *
 *   app_settings     this application's own key/value shelf, which the pairing fills
 *   hmac_credential  the hash it signs x-core's API with, delivered by the broker
 *   services         its OWN data, which is the only thing it ever owned
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
  `CREATE TABLE IF NOT EXISTS services (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    kind VARCHAR(60) NOT NULL,
    status VARCHAR(30) NOT NULL,
    host VARCHAR(120) NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
]

/**
 * What the local authentication left behind, dropped on the way through.
 *
 * A database that still carried them would let somebody read this POC as "the SSO
 * beside a login" rather than "the SSO INSTEAD OF one", and the reflex this exists
 * to remove is exactly that: keeping a local session "just in case".
 */
const REPLACED_BY_THE_SSO = ['sessions', 'users']

const DEMO_SERVICES = [
  ['queue-worker', 'AMQP', 'running', 'node-a'],
  ['object-storage', 'S3', 'running', 'node-b'],
  ['relational-db', 'MariaDB', 'running', 'node-a'],
  ['reverse-proxy', 'HTTP', 'degraded', 'edge-1'],
  ['batch-indexer', 'Cron', 'stopped', 'node-c'],
]

async function waitForDb() {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      await dbSelect('SELECT 1')
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  throw new Error('database unreachable')
}

async function seed() {
  const services = await dbSelect<RowDataPacket>('SELECT COUNT(*) AS total FROM services')
  if (Number(services[0]?.total ?? 0) === 0) {
    for (const [name, kind, status, host] of DEMO_SERVICES) {
      await dbExecute('INSERT INTO services (name, kind, status, host) VALUES (?, ?, ?, ?)', [
        name,
        kind,
        status,
        host,
      ])
    }
  }
}

/**
 * The schema, built ONCE, and awaited by everything that needs it.
 *
 * A memoised promise rather than a plugin others rely on running first. Nitro calls
 * its plugins in filename order but does NOT await them: an `async` one returns a
 * promise nobody holds, so the next plugin starts while the first is still working.
 *
 * That is exactly what happened here. The SSO boot read `app_settings` while these
 * `CREATE TABLE`s were still in flight, the read threw, and the pairing was reported
 * as `not-paired` on an application whose token was perfectly good - a failure whose
 * cause was ordering and whose message named the store.
 *
 * So the dependency is stated instead of assumed: whoever needs the shelf awaits
 * this, and it does its work once however many callers there are.
 */
let building: Promise<void> | null = null

export function schemaReady() {
  building ??= (async () => {
    await waitForDb()
    for (const statement of SCHEMA) {
      await dbExecute(statement)
    }
    for (const table of REPLACED_BY_THE_SSO) {
      await dbExecute(`DROP TABLE IF EXISTS ${table}`)
    }
    await seed()
  })()

  return building
}
