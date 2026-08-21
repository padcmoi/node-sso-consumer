/**
 * The boot, and the socket.
 *
 * A Nitro plugin is where the raw HTTP server is reachable, which is what the
 * realtime bridge hangs on, and it is also where `start()` belongs: awaited before
 * anything is served.
 *
 * `start()` reads the store, exchanges the install token if `INSTALLED` is not
 * there, opens the credential queue and declares. IT NEVER THROWS - what it did
 * comes back as a value and is said in one loud line in the log. A boot that died
 * because a token was spent or because x-core was still starting would take this
 * whole application with it, including the pages that have nothing to do with the
 * SSO; what is wanted instead is an application that stands up and says what is
 * wrong.
 */
export default defineNitroPlugin(async (nitro) => {
  // The shelf FIRST, and awaited. `start()` reads it before anything else - that is
  // how it knows whether this application is already paired - so a boot that ran
  // while the tables were still being created reported `not-paired` on a token that
  // was perfectly good, and named the store in a message nobody would connect to
  // plugin ordering. Nitro does not await its plugins; this does.
  await schemaReady()

  const started = await xcore.start()

  if (!started.ok) {
    // Said again, in this application's own words, because the state it leaves
    // behind is worth being unambiguous about: everything under the SSO answers
    // `401` until an operator fixes the line above.
    console.error(
      `[poc] the SSO is not serving (${started.status}). ` +
        'Mint an install token on x-core, under « Portails applicatifs », put it in ' +
        '`server/utils/xcore.ts` and boot again.',
    )
  }

  // ── HANGING THE BRIDGE ON THE HTTP SERVER ─────────────────────────────────
  //
  // Nitro has no runtime hook that hands the server over: `listen` belongs to the
  // BUILD instance, and a plugin runs inside the built one. What is reachable is the
  // server behind the first request that arrives - `req.socket.server` - so the
  // bridge is hung there, once, and every request after that finds it already done.
  //
  // Hung once and never twice: a second `upgrade` listener on the same path means
  // two handlers answering one upgrade, the second `handleUpgrade` throwing out of a
  // promise nobody can catch, and that unhandled rejection is the worker gone.
  //
  // The bridge returns for every upgrade that is not its own, so Nuxt's own HMR
  // socket in dev is untouched, and its path is matched EXACTLY.
  let hung = false
  nitro.hooks.hook('request', (event) => {
    if (hung) return

    // ESCAPE HATCH, and the only one in this POC. Node sets `server` on every socket
    // a server accepted, and does not declare it in its own types - so there is no
    // way to reach it that the compiler can check. Read defensively all the same: a
    // request that somehow carries none leaves `hung` false and the next one tries
    // again.
    const socket = event.node.req.socket as unknown as {
      server?: Parameters<typeof xcore.realtime.attach>[0]
    }
    if (!socket.server) return

    hung = true
    xcore.realtime.attach(socket.server)
    console.info('[poc] realtime bridge listening on /_ws/realtime')
  })

  // A process that exits without letting go leaves a consumer registered on the
  // broker until its heartbeat times out, and the next boot finds two.
  nitro.hooks.hook('close', () => xcore.close())
})
