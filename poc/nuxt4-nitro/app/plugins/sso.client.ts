import { createSsoClient, signInUrl } from '@gestionpratique/node-sso-consumer/client'

/**
 * The browser half, opened once for the whole application.
 *
 * `.client.ts`, and it has to be: this reads a cookie and dials a socket, both of
 * which are a browser's business. Nothing here runs during SSR.
 *
 * The client itself is held by `useSso.ts`, which is where a page can reach it.
 */
export default defineNuxtPlugin(async () => {
  const account = useSsoAccount()
  const connected = useSsoConnected()

  /** Read from the server rather than written here: x-core answers it at pairing. */
  const exit = async () => {
    const answer = await $fetch<{ url: string | null }>('/api/portal').catch(() => null)
    location.assign(answer?.url || signInUrl('/api/auth'))
  }

  const client = setSsoClient(createSsoClient({
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
  }))

  // Read the account, then follow it - in that order: the first read is what proves
  // there is a session at all, and dialling a socket without one is a socket that
  // opens and closes on the ticket route's 401.
  //
  // NOTHING IS REDIRECTED FROM HERE, and that is not an omission. The server guard
  // in `server/middleware/sso.ts` already sends a browser with no session where it
  // has to go, before a single byte of this page is rendered - so a page that IS
  // rendering has either passed that guard or is the sign-in screen, which is exempt.
  //
  // Sending it away again from the client was a second router on top of the first,
  // and the two disagreed: on the sign-in screen this read `null`, went to
  // `sso/start`, which sends a reader without a session to the sign-in screen, which
  // ran this again. The page reloaded itself forever, and what a reader saw was a
  // login form that would not stay still.
  const me = await client.connect()
  account.value = me
})
