import { account, errorsHandler, requirePermissions, requireSession } from "./guards.js";
import { baseOf } from "./middleware-options.js";
import { routesHandler } from "./routes.js";
import type { MiddlewareContext, SsoMiddlewareOptions } from "./middleware-options.js";
import type { WebRequest, WebResponse } from "./web.js";

export type { SsoMiddlewareOptions } from "./middleware-options.js";

/**
 * Everything an application would otherwise have written itself, as middleware.
 *
 * One handler carries the seven routes and passes through for anything else, so
 * mounting is a single `use` and there is no list of paths to keep in step. Two
 * more guard what comes after, and one maps this library's codes onto answers.
 *
 * All of it on raw Node request and response objects: no `res.json`, no
 * `res.redirect`, no `req.query`. That is what makes the same code work under
 * Express, under Nest on either platform, and under anything else that hands over
 * what Node hands over.
 *
 * A FACADE, and only that. Three files hold what it does: `routes.ts` the six
 * routes it answers, `guards.ts` what guards whatever comes after, and
 * `refusal.ts` the one refusal both of them speak.
 */
export class SsoMiddleware {
  private readonly ctx: MiddlewareContext;

  constructor(options: SsoMiddlewareOptions) {
    this.ctx = { options, base: baseOf(options) };
  }

  /** The seven routes, and a pass-through for everything else. */
  routes() {
    return routesHandler(this.ctx);
  }

  /**
   * The account, or a typed refusal - for a handler that CALLS rather than one
   * that sits behind a middleware.
   */
  account(req: WebRequest, res: WebResponse, ...actions: string[]) {
    return account(this.ctx, req, res, ...actions);
  }

  /**
   * Behind this, a handler reads `req.me` and trusts it: it is what the provider
   * answered for THIS request, rotation included.
   */
  requireSession() {
    return requireSession(this.ctx);
  }

  /** Refuse unless every action is held, against what was just read. */
  requirePermissions(...actions: string[]) {
    return requirePermissions(this.ctx, actions);
  }

  /** The last handler of the chain. */
  errors() {
    return errorsHandler(this.ctx);
  }
}
