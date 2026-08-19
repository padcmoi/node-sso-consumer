import { SsoError } from "../errors.js";
import { clientContextOf, jarOf, pathOf, queryOf, redirect, sendJson } from "./web.js";
import type { WebErrorHandler, WebHandler, WebRequest, WebResponse } from "./web.js";
import type { SsoAuthService } from "../auth.service.js";
import type { SsoConfigService } from "../config.service.js";
import type { SsoRealtimeBridge } from "../realtime/bridge.js";
import type { SsoSessionService } from "../session/session.service.js";
import type { SsoLogger, SsoMe, SsoTokens } from "../types.js";

export interface SsoMiddlewareOptions {
  auth: SsoAuthService;
  config: SsoConfigService;
  session: SsoSessionService;
  realtime: SsoRealtimeBridge | null;
  /**
   * The reactive read. Injected rather than reached for: the bridge owns the
   * followed accounts, and every door has to answer from the same one or a
   * revocation lands on one and not the others.
   */
  resolve(req: WebRequest, res: WebResponse): Promise<{ me: SsoMe; tokens: SsoTokens; userId: string } | null>;
  forget?(userId: string): void;
  /**
   * Where a signed-out browser goes. The only thing that signs anyone in.
   *
   * A function rather than a value: the provider sends this address at pairing and
   * it is read out of the store, which happens inside `start()` - long after this
   * middleware is built. Captured as a string it would always be the fallback.
   */
  portalUrl(): string;
  basePath?: string;
  afterLogin?: string;
  logger?: SsoLogger;
}

/**
 * Everything an application would otherwise have written itself, as middleware.
 *
 * One handler carries the five routes and passes through for anything else, so
 * mounting is a single `use` and there is no list of paths to keep in step. Two
 * more guard what comes after, and one maps this library's codes onto answers.
 *
 * All of it on raw Node request and response objects: no `res.json`, no
 * `res.redirect`, no `req.query`. That is what makes the same code work under
 * Express, under Nest on either platform, and under anything else that hands over
 * what Node hands over.
 */
export class SsoMiddleware {
  constructor(private readonly options: SsoMiddlewareOptions) {}

  private get base() {
    return this.options.basePath ?? "/auth";
  }

  /** The five routes, and a pass-through for everything else. */
  routes() {
    const handler: WebHandler = async (req, res, next) => {
      const path = pathOf(req);
      const method = (req.method ?? "GET").toUpperCase();

      try {
        if (method === "GET" && path === `${this.base}/sso/start`) return this.start(req, res);
        if (method === "GET" && path === `${this.base}/sso/callback`) return await this.callback(req, res);
        if (method === "POST" && path === `${this.base}/logout`) return await this.logout(req, res);
        if (method === "GET" && path === `${this.base}/session`) return await this.session(req, res);
        if (method === "POST" && path === `${this.base}/realtime-ticket`) return await this.ticket(req, res);
      } catch (error) {
        next(error);
        return;
      }
      next();
    };
    return handler;
  }

  /**
   * Behind this, a handler reads `req.me` and trusts it: it is what the provider
   * answered for THIS request, rotation included.
   */
  requireSession() {
    const handler: WebHandler = async (req, res, next) => {
      try {
        const resolved = await this.options.resolve(req, res);
        if (!resolved) {
          // No login page here, and there must not be: the portal is the only
          // thing in this ecosystem that signs a human in.
          redirect(res, this.options.portalUrl());
          return;
        }
        req.me = resolved.me;
        req.ssoTokens = resolved.tokens;
        req.ssoUserId = resolved.userId;
        next();
      } catch (error) {
        // Not a session that is over: the provider is unreachable, and signing
        // everyone out on a hiccup reads as a mass revocation.
        next(error);
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
  requirePermissions(...actions: string[]) {
    const handler: WebHandler = (req, _res, next) => {
      try {
        this.options.auth.assert(req.me?.permissions, ...actions);
        next();
      } catch (error) {
        next(error);
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
  errors() {
    const handler: WebErrorHandler = (error, _req, res, next) => {
      if (!(error instanceof SsoError)) return next(error);

      this.options.logger?.error?.(`[sso] ${error.code}: ${error.message}`);

      if (error.code === "FORBIDDEN") return sendJson(res, 403, { error: error.message });
      if (error.code === "UNAUTHORIZED") return redirect(res, this.options.portalUrl());
      // NO_CREDENTIAL, NOT_XCORE, UNREACHABLE, MALFORMED_ANSWER, REFUSED: this
      // application's problem, and never the reader's to act on.
      sendJson(res, 503, { error: "The identity provider is unavailable" });
    };
    return handler;
  }

  private start(req: WebRequest, res: WebResponse) {
    const url = this.options.session.start(jarOf(req, res), {
      authorizeUrl: (state) => this.options.config.authorizeUrl({ state }),
    });
    redirect(res, url);
  }

  private async callback(req: WebRequest, res: WebResponse) {
    const query = queryOf(req);
    const opened = await this.options.session.complete(jarOf(req, res), {
      code: query.get("code"),
      state: query.get("state"),
      ...clientContextOf(req),
    });
    // Every failure lands on the application's own front page: a reused code, an
    // expired one or a lost cookie are all things a reader can simply try again.
    redirect(res, opened ? (this.options.afterLogin ?? "/") : "/?error=sso");
  }

  private async logout(req: WebRequest, res: WebResponse) {
    const jar = jarOf(req, res);
    // Read before ending: the socket following this account has to be dropped with
    // it, or the process keeps a stream open for a session nobody holds.
    const sealed = this.options.session.read(jar);
    await this.options.session.end(jar);
    if (sealed) this.options.forget?.(sealed.userId);
    // Asymmetric on purpose: this closes THIS application's session and leaves the
    // reader signed into the SSO and every other app.
    redirect(res, this.options.portalUrl());
  }

  /**
   * The account, its details and its rights, as the provider answered them.
   *
   * The three blocks stay nested, `user` included, because that is the shape the
   * provider speaks. Nothing sealed travels: the token pair is a password with a
   * month of life, and anything a page can read, anything on that page can take.
   */
  private async session(req: WebRequest, res: WebResponse) {
    const resolved = await this.options.resolve(req, res);
    if (!resolved) return sendJson(res, 401, { error: "No session" });
    sendJson(res, 200, { data: resolved.me });
  }

  /** What the page dials the socket with. Thirty seconds, single use. */
  private async ticket(req: WebRequest, res: WebResponse) {
    if (!this.options.realtime) return sendJson(res, 404, { error: "No realtime bridge" });

    const resolved = await this.options.resolve(req, res);
    if (!resolved) return sendJson(res, 401, { error: "No session" });

    sendJson(res, 200, { data: await this.options.realtime.ticket(resolved.tokens.accessToken) });
  }
}
