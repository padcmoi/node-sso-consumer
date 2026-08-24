import type { SsoAuthService } from "../auth.service.js";
import type { SsoConfigService } from "../config.service.js";
import type { SsoRealtimeBridge } from "../realtime/bridge.js";
import type { SsoRefusal } from "../bridge/contract.js";
import type { SsoSessionService } from "../session/session.service.js";
import type { SsoLogger, SsoMe, SsoTokens } from "../types.js";
import type { WebRequest, WebResponse } from "./web.js";

export interface SsoMiddlewareOptions {
  auth: SsoAuthService;
  config: SsoConfigService;
  session: SsoSessionService;
  realtime: SsoRealtimeBridge | null;
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
   * There is no third state and no door that ever stands aside. Off with a directory
   * lent, this library stands in and serves; off with nothing lent, nobody can ever
   * sign in and every door shuts. Standing aside was what served protected pages to
   * anybody at all.
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
  /** Standing in for the provider: the sign-in route answers, and refusals go to `loginPath`. */
  standingIn?(): boolean;
  /** Prove a reader against the application's own directory. Null: refused. */
  signIn?(req: WebRequest, res: WebResponse, credentials: { email: string; password: string }): Promise<SsoMe | null>;
  /** Create one, then sign them in. Null: the address is already taken. */
  signUp?(
    req: WebRequest,
    res: WebResponse,
    input: { email: string; password: string; firstName: string; lastName: string }
  ): Promise<SsoMe | null>;
  /** Whether `<base>/sso/sign-up` answers at all. Off unless the application says so. */
  signUpOpen?: boolean;
  /** The application's own sign-in screen. Only used while standing in. */
  loginPath?: string;
  /** End the session and answer where the reader goes. The bridge's own. */
  logout?(req: WebRequest, res: WebResponse): Promise<string>;
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
 * The options, and the one value derived from them, in the shape everything below
 * the facade is handed.
 *
 * `base` is computed once rather than read per call: the options are held read-only
 * for the life of the middleware, so the two are the same answer.
 */
export interface MiddlewareContext {
  options: SsoMiddlewareOptions;
  base: string;
}

/**
 * Where the seven routes are mounted. `/api/auth` unless the application says
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
export const baseOf = (options: SsoMiddlewareOptions) => options.basePath ?? "/api/auth";
