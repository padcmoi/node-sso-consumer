import type { RowDataPacket } from 'mysql2/promise'

interface ServiceRow extends RowDataPacket {
  id: number
  name: string
  kind: string
  status: string
  host: string
  updated_at: Date
}

export default defineEventHandler(async (event) => {
  const session = await readSession(event)
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Aucune session' })
  }

  const rows = await dbSelect<ServiceRow>(
    'SELECT id, name, kind, status, host, updated_at FROM services ORDER BY id',
  )

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    host: row.host,
    updatedAt: new Date(row.updated_at).toISOString(),
  }))
})
