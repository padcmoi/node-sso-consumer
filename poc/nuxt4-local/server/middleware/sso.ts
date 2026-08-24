import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The seven routes the library carries, and the guard in front of the pages.
 *
 *   GET  /api/auth/sso/start        would go to the portal - refuses here, there is none
 *   GET  /api/auth/sso/callback     idem
 *   POST /api/auth/sso/sign-in      THE ONE THIS MODE USES: email + password
 *   POST /api/auth/sso/sign-up      create then sign in - only because `routes.signUp`
 *   POST /api/auth/logout           clears the cookie
 *   GET  /api/auth/session          the account, or 401
 *   POST /api/auth/realtime-ticket  refuses: no provider, so no socket to open
 *
 * Nitro middleware runs before every handler and passes through when it answers
 * nothing, which is exactly what `routes()` does.
 */

/**
 * A `next`-style handler, run to completion under Nitro.
 *
 * The library is framework-free: its handlers take `(req, res, next)`. Nitro has no
 * `next`, so one is supplied - and the three ways a handler can end all have to be
 * caught, because getting that wrong does not fail, it HANGS.
 */
const run = (handler: ReturnType<typeof xcore.middleware.routes>, req: IncomingMessage, res: ServerResponse) =>
  new Promise<void>((resolve, reject) => {
    Promise.resolve(handler(req, res, (error) => (error ? reject(error) : resolve()))).then(() => resolve(), reject);
  });

export default defineEventHandler(async (event) => {
  const { req, res } = event.node;

  await run(xcore.middleware.routes(), req, res);
  if (res.writableEnded) return;

  // This application's OWN API answers as an API: its handlers call the guard
  // themselves and refuse with a status, because redirecting an XHR to the sign-in
  // screen hands a component a page of HTML where it expected JSON.
  if (event.path.startsWith("/api/")) return;

  // The sign-in screen is never guarded, or the refusal sends a reader to a page
  // that refuses them, which redirects to itself. The library already exempts
  // `routes.loginPath` while standing in; this is the same fact said where a reader
  // of this file can see it.
  if (event.path === "/login" || event.path === "/register") return;

  // Assets are skipped: the guard would run on every file a page pulls, and it
  // re-reads the account each time. Named by PATH and not by the `accept` header -
  // filtering on `text/html` lets through anything that does not announce that type.
  if (/^\/(_nuxt|__nuxt|_ipx|_fonts)\//.test(event.path) || /\.[a-z0-9]+$/i.test(event.path.split("?")[0] ?? "")) return;

  await run(xcore.middleware.requireSession(), req, res);
});
