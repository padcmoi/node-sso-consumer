export default defineEventHandler(async (event) => {
  const session = await readSession(event)
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Aucune session' })
  }
  return session
})
