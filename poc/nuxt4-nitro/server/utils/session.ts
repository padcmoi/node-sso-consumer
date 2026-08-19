import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import type { RowDataPacket } from 'mysql2/promise'
import type { SessionPayload, SessionRecord } from '#shared/types/session'

export const SESSION_COOKIE = 'app_session'

interface SessionRow extends RowDataPacket {
  token: string
  user_id: string
  created_at: Date
  expires_at: Date
  user_agent: string | null
  ip: string | null
}

interface UserRow extends RowDataPacket {
  id: string
  email: string
  created_at: Date
}

function toRecord(row: SessionRow, currentToken: string) {
  const createdAt = new Date(row.created_at)
  const expiresAt = new Date(row.expires_at)
  return {
    token: row.token,
    userId: row.user_id,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ttlSeconds: Math.round((expiresAt.getTime() - createdAt.getTime()) / 1000),
    expiresInSeconds: Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)),
    userAgent: row.user_agent,
    ip: row.ip,
    current: row.token === currentToken,
  } satisfies SessionRecord
}

export async function createSession(event: H3Event, userId: string) {
  const config = useRuntimeConfig()
  const ttlHours = Number(config.sessionTtlHours)
  const token = randomUUID()
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000)

  await dbExecute(
    'INSERT INTO sessions (token, user_id, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)',
    [
      token,
      userId,
      expiresAt,
      getRequestHeader(event, 'user-agent')?.slice(0, 255) ?? null,
      getRequestIP(event, { xForwardedFor: true }) ?? null,
    ],
  )

  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ttlHours * 3600,
  })

  return token
}

export async function destroySession(event: H3Event) {
  const token = getCookie(event, SESSION_COOKIE)
  if (token) {
    await dbExecute('DELETE FROM sessions WHERE token = ?', [token])
  }
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
}

export async function readSession(event: H3Event): Promise<SessionPayload | null> {
  const token = getCookie(event, SESSION_COOKIE)
  if (!token) return null

  const sessions = await dbSelect<SessionRow>(
    'SELECT token, user_id, created_at, expires_at, user_agent, ip FROM sessions WHERE token = ? AND expires_at > NOW()',
    [token],
  )

  const row = sessions[0]
  if (!row) return null

  const users = await dbSelect<UserRow>('SELECT id, email, created_at FROM users WHERE id = ?', [
    row.user_id,
  ])
  const user = users[0]
  if (!user) return null

  const active = await dbSelect<SessionRow>(
    `SELECT token, user_id, created_at, expires_at, user_agent, ip
     FROM sessions
     WHERE user_id = ? AND expires_at > NOW()
     ORDER BY created_at DESC`,
    [row.user_id],
  )

  return {
    cookieName: SESSION_COOKIE,
    user: {
      id: user.id,
      email: user.email,
      hasPassword: true,
      createdAt: new Date(user.created_at).toISOString(),
    },
    session: toRecord(row, token),
    activeSessions: active.map((item) => toRecord(item, token)),
  }
}
