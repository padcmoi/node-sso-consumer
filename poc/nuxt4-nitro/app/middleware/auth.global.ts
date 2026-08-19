export default defineNuxtRouteMiddleware(async (to) => {
  const session = useSessionState()

  if (!session.value) {
    await refreshSession()
  }

  if (to.path === '/login') {
    return session.value ? navigateTo('/') : undefined
  }

  if (!session.value) {
    return navigateTo('/login')
  }
})
