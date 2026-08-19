import type { SessionPayload } from '#shared/types/session'

export function useSessionState() {
  return useState<SessionPayload | null>('session', () => null)
}

export async function refreshSession() {
  const state = useSessionState()
  const request = useRequestFetch()
  try {
    state.value = await request<SessionPayload>('/api/auth/session')
  } catch {
    state.value = null
  }
  return state.value
}

export async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  useSessionState().value = null
  await navigateTo('/login')
}
