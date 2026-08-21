import type { SsoMe } from '@gestionpratique/node-sso-consumer'
import type { SsoBrowserClient } from '@gestionpratique/node-sso-consumer/client'

/**
 * The one socket this application holds, kept here rather than in the plugin that
 * opens it: Nuxt auto-imports `app/composables/`, and a page reaching for it from a
 * plugin file would have to import a path by hand.
 *
 * Module scope, and one for the whole client session. Opening one per page would be
 * a socket per navigation, and the two topics that matter - the account, and the end
 * of the session - are exactly the ones that must not be dropped between two of them.
 */
let client: SsoBrowserClient | null = null

export const setSsoClient = (opened: SsoBrowserClient) => (client = opened)
export const useSsoClient = () => client

/**
 * The account this page holds, and whether the stream is up.
 *
 * `useState` rather than a module-scope ref: it is per request on the server and
 * shared across the application on the client, which is what a session wants.
 *
 * It is NOT persisted, and must not be. A store written to `localStorage` would be a
 * session outliving the one it mirrors, which is the thing this whole model forbids.
 */
export const useSsoAccount = () => useState<SsoMe | null>('sso.account', () => null)
export const useSsoConnected = () => useState('sso.connected', () => false)

/**
 * What a page reads, and the two questions it asks.
 *
 * The socket is opened once, by `plugins/sso.client.ts`, and held for the whole
 * session whatever page is showing. Nothing here dials anything.
 */
export const useSso = () => {
  const account = useSsoAccount()
  const connected = useSsoConnected()

  /**
   * The actions this application's account holds, without their prefix.
   *
   * Asked of the library rather than worked out here. This used to find the
   * permission ending in `:access` and take what was in front of it, which reads
   * correctly for an application that declares a gate and answers NOTHING for one
   * that does not - so a reader holding two rights was shown "0", with no way to
   * tell that from holding none. The server answers the resource; the client knows
   * it; this reads it.
   */
  const actions = computed(() => {
    // `account` is in the dependency list on purpose: the client is not reactive, so
    // this recomputes when the account it was read from changes.
    void account.value
    return useSsoClient()?.actions() ?? []
  })

  return {
    account,
    connected,
    actions,
    /**
     * Hides a button; it never refuses a call.
     *
     * The server decides, always. This exists so a reader is not shown a door that
     * answers `403` - which is a courtesy, not a control.
     */
    can: (permission: string) => Boolean(account.value?.permissions.global.includes(permission)),
    logout: () => useSsoClient()?.logout(),
  }
}
