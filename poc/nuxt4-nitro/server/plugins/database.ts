/**
 * The schema, built at boot.
 *
 * The work itself is in `server/utils/schema.ts` and not here, because the SSO boot
 * needs it too and Nitro does not await its plugins: a plugin that others rely on
 * having finished is a race, not an order. Both call `schemaReady()`, it runs once.
 */
export default defineNitroPlugin(async () => {
  await schemaReady()
})
