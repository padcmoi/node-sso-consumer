import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derived}`
}

export function verifyPassword(password: string, stored: string) {
  const [salt, derived] = stored.split(':')
  if (!salt || !derived) return false
  const expected = Buffer.from(derived, 'hex')
  const candidate = scryptSync(password, salt, 64)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
