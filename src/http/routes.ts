/**
 * The seven routes this library ANSWERS, and nothing that guards anything.
 *
 * One handler carries them and passes through for everything else, so mounting is
 * a single `use` and there is no list of paths for an application to keep in step.
 *
 * @module
 */

import { asFields } from "../parse.js";
import { clientContextOf, jarOf, pathOf, queryOf, readJson, redirect, sendJson } from "./web.js";
import { refuse } from "./refusal.js";
import type { MiddlewareContext } from "./middleware-options.js";
import type { WebHandler, WebRequest, WebResponse } from "./web.js";

/**
 * Whether a path is one of the five this library answers.
 *
 * Asked BEFORE the bridge's state is, so that a request for anything else is
 * passed on whatever that state is. The five are matched exactly, never by
 * prefix: `/auth/sso/startle` is the application's, not this library's.
 */
export const isMine = (path: string, base: string) =>
  path === `${base}/sso/start` ||
  path === `${base}/sso/sign-in` ||
  path === `${base}/sso/sign-up` ||
  path === `${base}/sso/callback` ||
  path === `${base}/logout` ||
  path === `${base}/session` ||
  path === `${base}/realtime-ticket`;

/** The seven routes, and a pass-through for everything else. */
export function routesHandler(ctx: MiddlewareContext) {
  const handler: WebHandler = async (req, res, next) => {
    const path = pathOf(req);
    const method = (req.method ?? "GET").toUpperCase();

    // Anything OUTSIDE the five is passed on untouched, bridge up or down: this
    // handler answers its own routes and nothing else, and what needs an account
    // is marked by the guards below rather than guessed at here.
    if (!isMine(path, ctx.base)) return next();

    // One of the five, with no bridge to serve it. There is no session to start,
    // no code to exchange and no account to read, so the door is shut rather
    // than passed on - passing on would hand these paths to the application,
    // which does not implement them, and answer a `404` for a service that is
    // down.
    if (!ctx.options.serving()) return refuse(ctx, req, res);

    try {
      if (method === "GET" && path === `${ctx.base}/sso/start`) return start(ctx, req, res);
      if (method === "GET" && path === `${ctx.base}/sso/callback`) return await callback(ctx, req, res);
      if (method === "POST" && path === `${ctx.base}/logout`) return await logout(ctx, req, res);
      if (method === "GET" && path === `${ctx.base}/session`) return await session(ctx, req, res);
      if (method === "POST" && path === `${ctx.base}/realtime-ticket`) return await ticket(ctx, req, res);
      if (method === "POST" && path === `${ctx.base}/sso/sign-in`) return await localSignIn(ctx, req, res);
      if (method === "POST" && path === `${ctx.base}/sso/sign-up`) return await localSignUp(ctx, req, res);
    } catch (error) {
      next(error);
      return;
    }
    next();
  };
  return handler;
}

/**
 * Sign a reader in against the application's own directory.
 *
 * Answered by this library, POSTed to by a screen the application draws. The split
 * is deliberate: comparing, sealing and holding the session are the same job in
 * both modes and belong here, while the screen belongs to the application's design
 * and its framework - a library cannot render a Nuxt page, and one that shipped its
 * own form would be a second look nobody chose.
 *
 * `401` and nothing else on a refusal. Which of the two halves was wrong is not
 * said: telling them apart tells whoever is asking which addresses exist here.
 */
async function localSignIn(ctx: MiddlewareContext, req: WebRequest, res: WebResponse) {
  if (!ctx.options.standingIn?.() || !ctx.options.signIn) {
    return sendJson(res, 404, { error: "No local directory" });
  }

  const body = asFields(await readJson(req));
  const email = typeof body?.email === "string" ? body.email : "";
  const password = typeof body?.password === "string" ? body.password : "";

  const me = await ctx.options.signIn(req, res, { email, password });
  if (!me) return sendJson(res, 401, { error: "Wrong email or password" });

  sendJson(res, 200, { data: me });
}

/**
 * Create a reader in this application's own directory, then sign them in.
 *
 * OPT-IN, and it has to be. An application may lend `di.accounts.create` for an
 * administration screen and want nothing open to the internet, so a route that
 * appeared the moment `create` existed would be a public sign-up nobody asked for.
 * `routes.signUp: true` is what turns it on, and it is off by default.
 *
 * The PASSWORD arrives here and the hash is made inside the library. That is the
 * whole reason this route exists rather than an application calling its own store:
 * `verifyPassword` reads a format and a set of scrypt parameters, and anything
 * writing them elsewhere has to reproduce both.
 *
 * Signed in on the way out, on the same cookie: a reader who has just created an
 * account is a reader, and asking them to type what they typed a second ago is a
 * second form for nothing.
 */
async function localSignUp(ctx: MiddlewareContext, req: WebRequest, res: WebResponse) {
  if (!ctx.options.standingIn?.() || !ctx.options.signUp || !ctx.options.signUpOpen) {
    return sendJson(res, 404, { error: "No open sign-up here" });
  }

  const body = asFields(await readJson(req));
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const firstName = typeof body?.firstName === "string" ? body.firstName : "";
  const lastName = typeof body?.lastName === "string" ? body.lastName : "";

  // Refused HERE rather than by the store, so every application answers the same
  // thing: a store left to reject an empty address would answer whatever its driver
  // throws, which is a 500 carrying a column name.
  if (!email.includes("@") || password.length < 8) {
    return sendJson(res, 422, { error: "An email address and a password of at least 8 characters are required" });
  }

  const me = await ctx.options.signUp(req, res, { email, password, firstName, lastName });
  if (!me) return sendJson(res, 409, { error: "That address is already taken" });

  sendJson(res, 201, { data: me });
}

function start(ctx: MiddlewareContext, req: WebRequest, res: WebResponse) {
  // Standing in, there is no provider to send anybody to and no authorize URL to
  // build: the way in is this application's own screen.
  if (ctx.options.standingIn?.()) return redirect(res, ctx.options.loginPath ?? "/login");

  const url = ctx.options.session.start(jarOf(req, res), {
    authorizeUrl: (state) => ctx.options.config.authorizeUrl({ state }),
  });
  redirect(res, url);
}

async function callback(ctx: MiddlewareContext, req: WebRequest, res: WebResponse) {
  const query = queryOf(req);
  const opened = await ctx.options.session.complete(jarOf(req, res), {
    code: query.get("code"),
    state: query.get("state"),
    ...clientContextOf(req),
  });
  // Every failure lands on the application's own front page: a reused code, an
  // expired one or a lost cookie are all things a reader can simply try again.
  redirect(res, opened ? (ctx.options.afterLogin ?? "/") : "/?error=sso");
}

/**
 * End the session, and ANSWER where to go rather than redirecting there.
 *
 * This route has exactly one caller and it is a script: the browser client POSTs
 * to it. A `302` written into a `fetch` is a response nothing follows - the cookie
 * was cleared and the reader stayed on a page that no longer had a session behind
 * it, until they refreshed by hand.
 *
 * So the address comes back as JSON and the client navigates. The work itself -
 * clearing, telling the provider, dropping what followed the account - is the
 * bridge's `logout`, which an application can also call from a handler of its own.
 */
async function logout(ctx: MiddlewareContext, req: WebRequest, res: WebResponse) {
  const exit = ctx.options.logout ? await ctx.options.logout(req, res) : "";
  sendJson(res, 200, { data: { exit: exit || (ctx.options.loginPath ?? "/") } });
}

/**
 * The account, its details and its rights, as the provider answered them.
 *
 * The three blocks stay nested, `user` included, because that is the shape the
 * provider speaks. Nothing sealed travels: the token pair is a password with a
 * month of life, and anything a page can read, anything on that page can take.
 */
/**
 * The account, and WHICH RESOURCE this application is.
 *
 * The resource travels because a page needs it and cannot work it out. It used to
 * be guessed - find the permission ending in `:access`, take what is in front -
 * which reads correctly for an application that declares a gate and answers
 * NOTHING for one that does not. A screen then showed "0 rights" to a reader
 * holding two, with no way to tell that from actually holding none.
 *
 * It is one string the server already knows, so it is answered instead of being
 * reconstructed from a convention every application would copy differently.
 */
async function session(ctx: MiddlewareContext, req: WebRequest, res: WebResponse) {
  const resolved = await ctx.options.resolve(req, res);
  if (!resolved) return sendJson(res, 401, { error: "No session" });
  sendJson(res, 200, { data: resolved.me, resource: ctx.options.auth.permissions.resource });
}

/** What the page dials the socket with. Thirty seconds, single use. */
async function ticket(ctx: MiddlewareContext, req: WebRequest, res: WebResponse) {
  // Standing in, there is no stream: no provider holds this session, so nothing
  // pushes a change to it. Answered as "no bridge" rather than as a refusal - the
  // reader is signed in perfectly well, there is simply nothing to subscribe to.
  if (!ctx.options.realtime || ctx.options.standingIn?.()) {
    return sendJson(res, 404, { error: "No realtime bridge" });
  }

  const resolved = await ctx.options.resolve(req, res);
  if (!resolved) return sendJson(res, 401, { error: "No session" });

  sendJson(res, 200, { data: await ctx.options.realtime.ticket(resolved.tokens.accessToken) });
}
