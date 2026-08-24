import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The five routes the library carries, and the guard that stands in front of the
 * pages, mounted in the one place Nitro has for it.
 *
 *   GET  /api/auth/sso/start        the portal's card points here
 *   GET  /api/auth/sso/callback     the code comes back, sealed into a session
 *   POST /api/auth/logout           closes THIS application's session, not the SSO's
 *   GET  /api/auth/session          the account, its details, its rights
 *   POST /api/auth/realtime-ticket  a single-use ticket for the browser's socket
 *
 * Nitro middleware runs before every handler and passes through when it answers
 * nothing, which is exactly what `routes()` does. The two are the same idea, so the
 * adapter is `run` below - and there is no list of paths here to keep in step.
 */

/**
 * A `next`-style handler, run to completion under Nitro.
 *
 * The library is framework-free: its handlers take `(req, res, next)`, which is what
 * makes the same code work under Express, Nest and anything else that hands over
 * what Node hands over. Nitro has no `next`, so one is supplied - and the three ways
 * a handler can end all have to be caught, because getting that wrong does not fail,
 * it HANGS.
 *
 *   it calls `next`        nothing was answered: carry on
 *   it answers and returns  the response is written: stop here
 *   it THROWS               which is the contract `di.errors` is built on under
 *                           Nitro - the throw has to travel, or the request waits
 *                           for a `next` that will never come
 *
 * The last one is why this is not `void handler(...)`. Discarded, the rejection took
 * `next` with it and every guarded page timed out instead of refusing.
 */
const run = (handler: ReturnType<typeof xcore.middleware.routes>, req: IncomingMessage, res: ServerResponse) =>
  new Promise<void>((resolve, reject) => {
    Promise.resolve(handler(req, res, (error) => (error ? reject(error) : resolve()))).then(() => resolve(), reject);
  });

export default defineEventHandler(async (event) => {
  const { req, res } = event.node;

  // The five routes. Answering nothing means this was not one of them.
  await run(xcore.middleware.routes(), req, res);

  // Answered by the library: nothing else runs for this request.
  if (res.writableEnded) return;

  // This application's OWN API answers as an API: its handlers call the guard
  // themselves and refuse with a status, because redirecting an XHR to the portal
  // hands a component a page of HTML where it expected JSON. Everything else is a
  // page, and a page is a browser - which the guard below sends to the portal.
  //
  // That split is the ONE thing this file decides, because it is the one thing the
  // library cannot know: which paths belong to this application's API. What to DO
  // in each case is the library's, and stays there.
  if (event.path.startsWith("/api/")) return;

  // The pages, behind the library's own guard. Without it the shell rendered for
  // anybody: `useSso()` handed the components a null account, they painted zeros,
  // and the only thing refusing was the API underneath - so what a reader saw was
  // a signed-in application containing nothing, on an application that had never
  // been paired with anything.
  await run(xcore.middleware.requireSession(), req, res);
});
