export interface SessionUser {
  id: string
  email: string
  hasPassword: boolean
  createdAt: string
}

export interface SessionRecord {
  token: string
  userId: string
  createdAt: string
  expiresAt: string
  ttlSeconds: number
  expiresInSeconds: number
  userAgent: string | null
  ip: string | null
  current: boolean
}

export interface SessionPayload {
  cookieName: string
  user: SessionUser
  session: SessionRecord
  activeSessions: SessionRecord[]
}
