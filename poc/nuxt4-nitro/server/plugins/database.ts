import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) NOT NULL PRIMARY KEY,
    email VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    user_agent VARCHAR(255) NULL,
    ip VARCHAR(64) NULL,
    INDEX idx_sessions_user (user_id)
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

const LEGACY_USER_COLUMNS = [
  'display_name',
  'firstname',
  'lastname',
  'gender',
  'locale',
  'city',
  'postal_code',
  'country',
  'permissions',
]

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
  const config = useRuntimeConfig()
  const email = config.admin.email.toLowerCase()

  const existing = await dbSelect<RowDataPacket>('SELECT id FROM users WHERE email = ?', [email])
  if (existing.length === 0) {
    await dbExecute('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', [
      randomUUID(),
      email,
      hashPassword(config.admin.password),
    ])
  }

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

export default defineNitroPlugin(async () => {
  await waitForDb()
  for (const statement of SCHEMA) {
    await dbExecute(statement)
  }
  for (const column of LEGACY_USER_COLUMNS) {
    await dbExecute(`ALTER TABLE users DROP COLUMN IF EXISTS ${column}`)
  }
  await seed()
})
