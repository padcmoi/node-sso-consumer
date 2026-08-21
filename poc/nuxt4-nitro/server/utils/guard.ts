import type { H3Event } from 'h3'

/**
 * The account behind a request, or a refusal.
 *
 * TWO LINES, and that is the measure of this file rather than an accident of it.
 * Nothing here decides anything: not what counts as a session, not which refusal a
 * cause deserves, not what a missing right answers. The library asks x-core on every
 * call, x-core decides life or death of a reader, and this hands the answer on.
 *
 * The refusal itself is not translated here either. `di.errors`, in
 * `server/utils/xcore.ts`, is the function this application LENDS the library, and
 * the library calls it from inside its own decision - so a refusal is thrown as an
 * `H3Error` before these ever return.
 *
 * A function each handler calls rather than a middleware mounted once, because a
 * Nuxt application serves its pages and its API from the same origin: the pages are
 * guarded in `server/middleware/sso.ts`, where a browser can be sent to the portal,
 * and the API refuses with a status where a redirect would hand a component a page
 * of HTML it cannot parse.
 */
export const requireSession = (event: H3Event) => xcore.middleware.account(event.node.req, event.node.res)

/**
 * The same, and the rights with it - in ONE call, so authenticating and authorising
 * cannot come apart. The library checks the session first and the actions after, and
 * a route that forgot the first would be asserting rights against nobody.
 */
export const requirePermissions = (event: H3Event, ...actions: string[]) =>
  xcore.middleware.account(event.node.req, event.node.res, ...actions)
