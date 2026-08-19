import type { RowDataPacket } from 'mysql2/promise'

interface CredentialsRow extends RowDataPacket {
  id: string
  password_hash: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown; password?: unknown }>(event)
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!email || !password) {
    throw createError({ statusCode: 400, statusMessage: 'Email et mot de passe requis' })
  }

  const rows = await dbSelect<CredentialsRow>(
    'SELECT id, password_hash FROM users WHERE email = ?',
    [email],
  )
  const user = rows[0]

  if (!user || !verifyPassword(password, user.password_hash)) {
    throw createError({ statusCode: 401, statusMessage: 'Identifiants invalides' })
  }

  await createSession(event, user.id)

  return { ok: true }
})
