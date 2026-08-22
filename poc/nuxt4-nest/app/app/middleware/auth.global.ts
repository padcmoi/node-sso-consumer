import type { SsoMe } from '@gestionpratique/node-sso-consumer'

/**
 * The page guard, and the ONE thing this architecture moves.
 *
 * In `nuxt4-nitro` the pages are guarded server-side, by the library's own
 * `requireSession()` mounted as Nitro middleware: nothing renders for a browser
 * without a session because the library refuses before a byte is written.
 *
 * Here the library is not on this side at all. This half serves pages and relays
 * calls, and neither of those can ask the library anything - it lives in the API.
 * So the guard is a route middleware that ASKS, over the same relay every other call
 * goes through, and the answer is still the library's: `GET /api/auth/session` is one
 * of its six routes, it resolves against x-core on every call, and it caches nothing.
 *
 * Universal rather than client-only, and it has to be. Left to the client, the shell
 * renders for anybody first: components paint zeros around a null account, and the
 * only thing refusing is the API underneath - which reads, to whoever is looking, as
 * a signed-in application containing nothing.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  // The sign-in screen is exempt, or a reader refused on it is sent to it, which
  // refuses them again. It is only ever reachable while the library stands in.
  if (to.path === '/login') return

  const account = useSsoAccount()
  const portal = useSsoPortal()

  // `useRequestFetch` and not `$fetch`: during SSR this call carries the browser's
  // cookie through to the relay. Without it the request arrives at the API with no
  // cookie at all, is answered 401, and every reader is sent to the portal on every
  // first paint - including the ones who just came back from it.
  const request = useRequestFetch()

  // Filled by `plugins/sso.client.ts` on the client, which runs before this. Empty
  // during SSR, where this read is the only one.
  if (!account.value) {
    const answer = await request<{ data: SsoMe }>('/api/auth/session').catch(() => null)
    account.value = answer?.data ?? null
  }

  if (account.value) return

  portal.value ??= (await request<{ url: string | null }>('/api/portal').catch(() => null))?.url ?? null

  // No portal means the library is standing in: there is nowhere over there to send
  // anybody, and the way in is this console's own screen.
  return navigateTo(portal.value ?? '/login', { external: Boolean(portal.value) })
})
