/**
 * What guards whatever comes after, and the one distinction all four share.
 *
 * FORBIDDEN is about the ACCOUNT: it is signed in, the provider answered for it,
 * and it does not hold the right - so it is refused where it stands and the right
 * is named. A redirect would loop, because signing in again changes nothing about
 * what it holds. Everything else is about the SESSION, which a round trip does fix,
 * and goes to the portal.
 *
 * @module
 */

import { SsoError } from "../errors.js";
import { pathOf, sendJson } from "./web.js";
import { refuse } from "./refusal.js";
import type { MiddlewareContext } from "./middleware-options.js";
import type { WebErrorHandler, WebHandler, WebRequest, WebResponse } from "./web.js";

/**
 * The account, or a typed refusal - for a handler that CALLS rather than one
 * that sits behind a middleware.
 *
 * The same decision as the guards below, reached the same way, for the frameworks
 * where a handler asks instead of being wrapped: Nitro, Fastify, a plain route
 * table. It throws rather than writing to the response, because a caller that
 * asked a question is going to answer it itself - and an application must not
 * have to reimplement the chain to get an account out of this library.
 *
 * Every refusal is an `SsoError`, and `statusOf` in this same package turns one
 * into a status. Nothing about which status belongs to which cause is left for an
 * application to work out: get that wrong and a misconfigured deployment tells a
 * reader to sign in, on an application that cannot sign anyone in.
 *
 * `actions` is checked in the SAME call as the session, and after it. Two calls
 * would be two things to remember, and the one that gets forgotten is the first -
 * which is a route asserting rights against an account nobody read.
 */
export async function account(ctx: MiddlewareContext, req: WebRequest, res: WebResponse, ...actions: string[]) {
  if (!ctx.options.serving()) {
    throw new SsoError("NOT_CONFIGURED", "This application cannot reach its identity provider");
  }

  const resolved = await ctx.options.resolve(req, res);
  if (!resolved) throw new SsoError("UNAUTHORIZED", "No session");

  ctx.options.auth.assert(resolved.me.permissions, ...actions);
  return resolved.me;
}

/**
 * Behind this, a handler reads `req.me` and trusts it: it is what the provider
 * answered for THIS request, rotation included.
 */
export function requireSession(ctx: MiddlewareContext) {
  const handler: WebHandler = async (req, res, next) => {
    // The sign-in screen itself is never guarded, or the refusal sends a reader to
    // a page that refuses them, which redirects to itself. Standing in only: in
    // `"sso"` this path means nothing and is guarded like any other.
    if (ctx.options.standingIn?.() && pathOf(req) === (ctx.options.loginPath ?? "/login")) return next();

    // NOTHING is served from behind this guard while the bridge is down. Not a
    // page, not an empty shell, not a `next()` with no account on it.
    //
    // This is the whole point of mounting it: what sits behind it needs to know
    // WHO is asking, the provider is the only thing that answers that, and an
    // application that cannot reach it cannot answer it either. Waving the
    // request through would hand a protected page to whoever asked, at the one
    // moment nothing can tell them apart.
    if (!ctx.options.serving()) return refuse(ctx, req, res);

    try {
      const resolved = await ctx.options.resolve(req, res);
      if (!resolved) {
        // No login page here, and there must not be: the portal is the only
        // thing in this ecosystem that signs a human in.
        refuse(ctx, req, res);
        return;
      }
      req.me = resolved.me;
      req.ssoTokens = resolved.tokens;
      req.ssoUserId = resolved.userId;
      next();
    } catch (error) {
      // Refused HERE, not handed on. Whatever went wrong - the provider
      // unreachable, an answer this library cannot read, a credential missing -
      // the result is the same: nothing was learned about this reader, so
      // nothing behind this guard may be served to them.
      //
      // Handed to the error handler instead, as this once did, it would depend
      // on that handler being mounted. An application that forgot it would let
      // the request continue into a framework's default page, which is not a
      // refusal at all.
      ctx.options.logger?.error?.(`[sso] session refused: ${error instanceof Error ? error.message : String(error)}`);
      refuse(ctx, req, res);
    }
  };
  return handler;
}

/**
 * Refuse unless every action is held, against what was just read.
 *
 * The requirement sits on the route it guards, so authenticating and authorising
 * cannot come apart - and nothing here defaults to open.
 */
export function requirePermissions(ctx: MiddlewareContext, actions: string[]) {
  const handler: WebHandler = (req, res, next) => {
    // Shut, like the session guard above and for the same reason. Reached on its
    // own it would be asserting rights against `req.me` - which nothing filled,
    // because nothing could - and an empty permission list read as "holds
    // nothing" would answer `403`: the reader told they lack a right, when what
    // is missing is the provider.
    if (!ctx.options.serving()) return refuse(ctx, req, res);

    try {
      ctx.options.auth.assert(req.me?.permissions, ...actions);
      next();
    } catch (error) {
      // Answered HERE rather than handed on, for the reason the session guard
      // is: a refusal that depends on an error handler being mounted is a
      // refusal an application can forget to install.
      //
      // FORBIDDEN and nothing else is a `403`. It is the one refusal about the
      // ACCOUNT: it is signed in, the provider answered for it, and it does not
      // hold the right - so it is told which, where it stands. A redirect would
      // loop, since signing in again changes nothing about what it holds.
      if (error instanceof SsoError && error.code === "FORBIDDEN") {
        ctx.options.logger?.warn?.(`[sso] ${error.message}`);
        return sendJson(res, 403, { error: error.message });
      }

      ctx.options.logger?.error?.(`[sso] permissions refused: ${error instanceof Error ? error.message : String(error)}`);
      refuse(ctx, req, res);
    }
  };
  return handler;
}

/**
 * The last handler of the chain.
 *
 * The distinction that matters: FORBIDDEN is about the ACCOUNT and must not be
 * redirected to a sign-in, which would loop - signing in again changes nothing
 * about what it holds. UNAUTHORIZED is about the SESSION, which a round trip
 * does fix.
 */
export function errorsHandler(ctx: MiddlewareContext) {
  const handler: WebErrorHandler = (error, req, res, next) => {
    if (!(error instanceof SsoError)) return next(error);

    ctx.options.logger?.error?.(`[sso] ${error.code}: ${error.message}`);

    // The ONE distinction that survives here. FORBIDDEN is about the ACCOUNT: it
    // is signed in, x-core answered for it, and it does not hold the right. A
    // redirect would loop, because signing in again changes nothing about what
    // it holds - so it is refused where it stands, and the right is named.
    if (error.code === "FORBIDDEN") return sendJson(res, 403, { error: error.message });

    // Everything else is the same sentence: what is known about this reader is
    // nothing. Session over, x-core refusing, x-core unreachable, credential
    // missing, never paired - the reasons differ and the answer cannot, because
    // in every one of them nobody has been identified. To the portal, or `500`
    // when this application has no portal to send them to.
    refuse(ctx, req, res, error.code, error.message);
  };
  return handler;
}
