import { createSsoClient, signInUrl } from '@gestionpratique/node-sso-consumer/client'

/**
 * The browser half, opened once for the whole console.
 *
 * `.client.ts`, and it has to be: this reads a cookie and dials a socket, both of
 * which are a browser's business. Nothing here runs during SSR.
 *
 * It talks to THIS origin and knows nothing else. The six routes it calls are served
 * by the NestJS API and reached through the relay in `server/`, and the socket it
 * dials is relayed the same way - so this file is identical to the one in
 * `nuxt4-nitro`, where the same routes are served by the Nitro it runs on.
 */
export default defineNuxtPlugin(async () => {
  const account = useSsoAccount()
  const connected = useSsoConnected()
  const portal = useSsoPortal()

  const exit = async () => {
    portal.value ??= (await $fetch<{ url: string | null }>('/api/portal').catch(() => null))?.url ?? null
    location.assign(portal.value || signInUrl('/api/auth'))
  }

  const client = setSsoClient(
    createSsoClient({
      basePath: '/api/auth',
      // The frame IS the new value, written straight in with no re-read behind it: a
      // permission granted or revoked from another application lands here within
      // seconds, and the ref is reactive, so the screens follow on their own.
      onAccount: (me) => (account.value = me),
      // Signed out at the portal, account disabled, or access to THIS application
      // revoked. Empty everything and leave - nothing reconnects into a session that
      // is over, and the next frame would be refused for the same reason.
      onSignedOut: () => {
        account.value = null
        connected.value = false
        void exit()
      },
      onConnectionChange: (up) => (connected.value = up),
    })
  )

  // Read the account, then follow it - in that order: the first read is what proves
  // there is a session at all, and dialling a socket without one is a socket that
  // opens and closes on the ticket route's 401.
  //
  // NOTHING IS REDIRECTED FROM HERE. `middleware/auth.global.ts` is the one place
  // that sends a browser away, and it runs after this: two routers on the same
  // decision disagreed in `nuxt4-nitro` and reloaded the sign-in screen forever.
  const me = await client.connect()
  account.value = me
})
