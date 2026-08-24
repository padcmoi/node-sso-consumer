/**
 * The boot.
 *
 * `start()` in `mode: "local"` does three things and no more: it reads the shelf,
 * mints the cookie password if it is not there yet, and names the cookie. No
 * pairing, no declaration, no broker, no socket - there is nothing at the other end
 * to do any of it with.
 *
 * IT NEVER THROWS. What it did comes back as a value. Here the only way it can fail
 * is a directory that was not lent, and it says so rather than serving every guarded
 * page to whoever asks.
 */
export default defineNitroPlugin(async () => {
  // The shelf FIRST, and awaited: `start()` reads it immediately, and a boot that
  // ran while the tables were still being created would report a store it could not
  // read. Nitro does not await its plugins; this does.
  await schemaReady()

  const started = await xcore.start()

  console.info(`[poc] start() -> ${started.status} (ok=${started.ok})`)
  if (!started.ok) {
    console.error(
      `[poc] the SSO is not serving (${started.status}): ${started.reason ?? 'no reason given'}. ` +
        'In local mode that means no directory was lent - see `di.local_accounts` in `server/utils/xcore.ts`.',
    )
  }
})
