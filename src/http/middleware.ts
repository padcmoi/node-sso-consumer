import { SsoError } from "../errors.js";
import { clientContextOf, jarOf, pathOf, queryOf, redirect, sendJson } from "./web.js";
import { statusOf, type SsoErrorCode } from "../errors.js";
import type { SsoRefusal } from "../xcore-bridge.js";
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
   * The application turned this library OFF - `enabled: false`.
   *
   * A DECISION, and the opposite of a failure. It says: this deployment does not use
   * the SSO, and what guards it is its own login - a hardcoded account, a table, a
   * development screen, whatever it had before. So every door STANDS ASIDE: the five
   * routes pass on, so an application serving its own `/api/auth/*` finds them free,
   * and the guards call `next` with no account.
   *
   * Refusing here would be refusing a reader for a reason that is not theirs, on an
   * application that never asked this library to guard anything.
   *
   * Asked BEFORE `serving`, because the two answer different questions and only one
   * of them is about a fault.
   */
  withdrawn(): boolean;
  /**
   * Whether this library, WHICH IS ON, can hold a session, asked on every request.
   *
   * A function rather than a value: it is false while a boot is still standing up
   * and true a moment later, and a handler built once must see the change.
   *
   * When it is false EVERY DOOR IS SHUT. Not stood aside - SHUT. This library is
   * the bridge to the provider, and without the provider there is no account, no
   * rights, and therefore nothing anybody is entitled to see. A guard that waved
   * readers through on a bridge that is down would serve every protected page of
   * this application to anyone who asked, which is not a degraded mode: it is the
   * application with its lock removed, at the exact moment it cannot tell who is
   * knocking.
   *
   * The DIFFERENCE with `withdrawn` is the whole of it: one is a deployment that
   * said it does not use the SSO, the other is one that says it does and cannot.
   */
  serving(): boolean;
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
  /**
   * How the application says "refused", lent by it. See `di.errors`: the library
   * decides whether and why, the application decides how it is spoken.
   */
  errors?(refusal: SsoRefusal, req: WebRequest, res: WebResponse): void;
  basePath?: string;
  afterLogin?: string;
  logger?: SsoLogger;
}

/**
 * Whether a path is one of the five this library answers.
 *
 * Asked BEFORE the bridge's state is, so that a request for anything else is
 * passed on whatever that state is. The five are matched exactly, never by
 * prefix: `/auth/sso/startle` is the application's, not this library's.
 */
const isMine = (path: string, base: string) =>
  path === `${base}/sso/start` ||
  path === `${base}/sso/callback` ||
  path === `${base}/logout` ||
  path === `${base}/session` ||
  path === `${base}/realtime-ticket`;

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

  /**
   * Where the five routes are mounted. `/api/auth` unless the application says
   * otherwise.
   *
   * The default matters more than a default usually does, because x-core's console
   * COMPOSES the callback it records: an operator types the application's address
   * and the form writes `<address>/api/auth/sso/callback` into the SSO consumer,
   * with no field offering anything else. So an application that configures nothing
   * here has to answer on that path, or it is declared at one address and listens
   * at another - which shows up at the first sign-in, as a callback that does not
   * match, on a row whose host is pinned and cannot be edited.
   *
   * It was `/auth` and every example in this repository overrode it: the README, the
   * three integration guides and the POC all wrote `/api/auth`. A default no
   * document uses is a trap for whoever trusts it.
   */
  private get base() {
    return this.options.basePath ?? "/api/auth";
  }

  /**
   * THE refusal, and there is only one for every way a request can fail to prove
   * who is asking.
   *
   * x-core's consumer session decides life or death of a reader, and this library
   * is the only thing that asks it. So all of these are the same answer: nobody is
   * signed in, x-core refused, x-core could not be reached, or this application was
   * never paired and could not ask at all. In each case what is known about the
   * reader is nothing, and nothing is what may be served.
   *
   * The portal is where they go, because it is the only thing in this ecosystem
   * that signs a human in. And when there is no portal to go to - an application
   * nobody configured never received one - the answer is `500`: the fault is the
   * application's, no round trip fixes it, and a redirect built from an empty
   * string leaves the browser exactly where it is, painting the shell of a
   * signed-in application around no account.
   */
  private refuse(req: WebRequest, res: WebResponse, code: SsoErrorCode = "UNAUTHORIZED", message?: string) {
    const portal = this.options.portalUrl();
    // No portal means never paired: the address arrives WITH the pairing. So there
    // is nowhere to send anybody, no round trip that would help, and the fault is
    // this application's - which is a `500` however it ends up being expressed.
    const refusal: SsoRefusal = portal
      ? { status: statusOf(new SsoError(code, "")), code, message: message ?? "Not signed in", redirectTo: portal }
      : {
          status: 500,
          code: "NOT_CONFIGURED",
          message: "This application is not configured for authentication",
          redirectTo: null,
        };

    if (refusal.status === 500) this.options.logger?.error?.(`[sso] ${refusal.message}`);

    // Lent by the application, and called from INSIDE the decision rather than
    // around it. It may throw - Nitro and Nest both want that - and the throw
    // travels untouched, which is why nothing here catches it.
    this.options.errors?.(refusal, req, res);

    // Reached when the application lent nothing, or lent something that answered
    // by returning. Either way the library never leaves a request hanging on a
    // refusal, and never writes over a response the application already ended.
    if (res.writableEnded) return;
    if (refusal.redirectTo) return redirect(res, refusal.redirectTo);
    sendJson(res, refusal.status, { error: refusal.message });
  }

  /** The five routes, and a pass-through for everything else. */
  routes() {
    const handler: WebHandler = async (req, res, next) => {
      const path = pathOf(req);
      const method = (req.method ?? "GET").toUpperCase();

      // Withdrawn: these five paths belong to nothing here, and an application
      // serving its own `/api/auth/*` must find them free.
      if (this.options.withdrawn()) return next();

      // Anything OUTSIDE the five is passed on untouched, bridge up or down: this
      // handler answers its own routes and nothing else, and what needs an account
      // is marked by the guards below rather than guessed at here.
      if (!isMine(path, this.base)) return next();

      // One of the five, with no bridge to serve it. There is no session to start,
      // no code to exchange and no account to read, so the door is shut rather
      // than passed on - passing on would hand these paths to the application,
      // which does not implement them, and answer a `404` for a service that is
      // down.
      if (!this.options.serving()) return this.refuse(req, res);

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
  async account(req: WebRequest, res: WebResponse, ...actions: string[]) {
    // Withdrawn: there is no SSO session because this deployment does not use the
    // SSO. `401` and not `500` - nothing is broken, this route simply asked for an
    // account from a library that was told to hold none, and what signs anybody in
    // here is the application's own login.
    if (this.options.withdrawn()) throw new SsoError("UNAUTHORIZED", "No session: this library is withdrawn");

    if (!this.options.serving()) {
      throw new SsoError("NOT_CONFIGURED", "This application cannot reach its identity provider");
    }

    const resolved = await this.options.resolve(req, res);
    if (!resolved) throw new SsoError("UNAUTHORIZED", "No session");

    this.options.auth.assert(resolved.me.permissions, ...actions);
    return resolved.me;
  }

  /**
   * Behind this, a handler reads `req.me` and trusts it: it is what the provider
   * answered for THIS request, rotation included.
   */
  requireSession() {
    const handler: WebHandler = async (req, res, next) => {
      // Nothing here to require: the application withdrew, and its own login is
      // what guards this. See `withdrawn`.
      if (this.options.withdrawn()) return next();

      // NOTHING is served from behind this guard while the bridge is down. Not a
      // page, not an empty shell, not a `next()` with no account on it.
      //
      // This is the whole point of mounting it: what sits behind it needs to know
      // WHO is asking, the provider is the only thing that answers that, and an
      // application that cannot reach it cannot answer it either. Waving the
      // request through would hand a protected page to whoever asked, at the one
      // moment nothing can tell them apart.
      if (!this.options.serving()) return this.refuse(req, res);

      try {
        const resolved = await this.options.resolve(req, res);
        if (!resolved) {
          // No login page here, and there must not be: the portal is the only
          // thing in this ecosystem that signs a human in.
          this.refuse(req, res);
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
        this.options.logger?.error?.(`[sso] session refused: ${error instanceof Error ? error.message : String(error)}`);
        this.refuse(req, res);
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
    const handler: WebHandler = (req, res, next) => {
      // Withdrawn: no account was resolved because none was asked for, and refusing
      // on an empty permission list would make every route of a withdrawn
      // application answer `403` - this library enforcing a gate it was told not to
      // hold.
      if (this.options.withdrawn()) return next();

      // Shut, like the session guard above and for the same reason. Reached on its
      // own it would be asserting rights against `req.me` - which nothing filled,
      // because nothing could - and an empty permission list read as "holds
      // nothing" would answer `403`: the reader told they lack a right, when what
      // is missing is the provider.
      if (!this.options.serving()) return this.refuse(req, res);

      try {
        this.options.auth.assert(req.me?.permissions, ...actions);
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
          this.options.logger?.warn?.(`[sso] ${error.message}`);
          return sendJson(res, 403, { error: error.message });
        }

        this.options.logger?.error?.(`[sso] permissions refused: ${error instanceof Error ? error.message : String(error)}`);
        this.refuse(req, res);
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
    const handler: WebErrorHandler = (error, req, res, next) => {
      if (!(error instanceof SsoError)) return next(error);

      this.options.logger?.error?.(`[sso] ${error.code}: ${error.message}`);

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
      this.refuse(req, res, error.code, error.message);
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
    this.refuse(req, res);
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
