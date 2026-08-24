import type { RowDataPacket } from 'mysql2/promise'

/**
 * Two tables, and neither is a session.
 *
 * `app_settings`  this application's key/value shelf, which the library uses
 * `notes`         its OWN data, which is the only thing it ever owned
 *
 * There is no `users` table and no `password_hash` column even HERE, where the
 * accounts are this application's own. They are lent to the library as a list, and
 * the library compares, seals and holds the session - so what would go in a users
 * table has nowhere to be. And there is no `sessions` table, because a session row
 * is precisely what cannot honour a revocation: it would still be valid.
 *
 * `app_settings` holds exactly two rows in this mode - the password that seals the
 * cookie and the name of the cookie - where a paired application holds twenty. That
 * difference is the whole of what the pairing brings, said as data.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS app_settings (
    \`key\` VARCHAR(190) NOT NULL PRIMARY KEY,
    \`type\` ENUM('string','number','boolean','array','object','null') NOT NULL,
    \`value\` LONGTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS notes (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(190) NOT NULL,
    body TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
]

const DEMO_NOTES = [
  ['Ce que la table ne contient pas', 'Ni compte, ni mot de passe, ni session. La liste est prêtée à la librairie.'],
  ['Le mode local', "Aucun fournisseur n'est appelé. La session est réelle, le cookie est scellé, les gardes refusent."],
  ['Le cookie', 'sso_local, scellé avec le mot de passe tiré au premier démarrage et gardé dans app_settings.'],
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
  const rows = await dbSelect<RowDataPacket>('SELECT COUNT(*) AS total FROM notes')
  if (Number(rows[0]?.total ?? 0) > 0) return

  for (const [title, body] of DEMO_NOTES) {
    await dbExecute('INSERT INTO notes (title, body) VALUES (?, ?)', [title, body])
  }
}

/**
 * The schema, built ONCE, and awaited by everything that needs it.
 *
 * A memoised promise rather than a plugin others rely on running first. Nitro calls
 * its plugins in filename order but does NOT await them, so an `async` one returns a
 * promise nobody holds and the next plugin starts while the first is still working.
 * The library's boot reads `app_settings` immediately, so it has to wait for this.
 */
let building: Promise<void> | null = null

export function schemaReady() {
  building ??= (async () => {
    await waitForDb()
    for (const statement of SCHEMA) await dbExecute(statement)
    await seed()
  })()

  return building
}
