import { SsoError, statusOf } from '@gestionpratique/node-sso-consumer'
import type { RowDataPacket } from 'mysql2/promise'
import type { H3Event } from 'h3'

interface NoteRow extends RowDataPacket {
  id: number
  title: string
  body: string
}

/**
 * The account behind a request, with the rights asked for in the SAME call.
 *
 * Nothing here decides anything: the library reads the session, checks the actions,
 * and refuses. Authenticating and authorising in one call is deliberate - a route
 * that did the first and forgot the second would be asserting rights against nobody.
 *
 * THE MAPPING IS HERE, and it has to be. `middleware.account()` is the entry point a
 * handler CALLS rather than sits behind, and it throws a typed `SsoError` instead of
 * going through `di.errors` - which is right for it, since a caller that asked for
 * the account is also the one that decides how its own route answers. Left to
 * travel, though, Nitro reads it as an unknown throw and answers `500`: a reader
 * missing a right would be told the server is broken.
 *
 * `statusOf` is the library's own reading of its codes - `403` for a missing right,
 * `401` for nobody identified, `500` for never configured - so this is one line
 * rather than a second table of statuses that would drift from the first.
 */
const requirePermissions = async (event: H3Event, ...actions: string[]) => {
  try {
    return await xcore.middleware.account(event.node.req, event.node.res, ...actions)
  } catch (error) {
    if (error instanceof SsoError) {
      throw createError({ statusCode: statusOf(error), statusMessage: error.message })
    }
    throw error
  }
}

/**
 * This application's OWN data, behind its OWN rule.
 *
 * The guard is CALLED rather than wrapped around, because an API refuses with a
 * status: redirecting an XHR to the sign-in screen hands a component HTML where it
 * expected JSON.
 *
 * `read:note` is namespaced by the library against this application's own resource,
 * so what the directory writes as `read:note` is compared as `<app>:read:note`. And
 * `admin@example.test`, whose list is empty, passes anyway because `isRoot` is read
 * before the list is.
 */
export default defineEventHandler(async (event) => {
  const me = await requirePermissions(event, 'read:note')

  const rows = await dbSelect<NoteRow>('SELECT id, title, body FROM notes ORDER BY id')
  return { reader: me.user.email, notes: rows }
})
