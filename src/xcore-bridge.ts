import { SsoEnvironment } from "./environment.js";
import { SsoRealtimeClient } from "./realtime/realtime.client.js";
import { buildServices } from "./bridge/wiring.js";
import { jarOf } from "./http/web.js";
import { signInLocally, standingIn as isStandingIn } from "./bridge/stand-in.js";
import { startPropagation } from "./propagation.js";
import * as access from "./bridge/access.js";
import * as boot from "./bridge/boot.js";
import { addressesOf, type ProviderAddresses } from "./provider.js";
import type { SsoAuthService } from "./auth.service.js";
import type { SsoConfigService } from "./config.service.js";
import type { SsoHttpClient } from "./http.js";
import type { SsoLiveAccounts } from "./session/live-accounts.js";
import type { SsoMiddleware } from "./http/middleware.js";
import type { SsoRealtimeBridge } from "./realtime/bridge.js";
import type { SsoSessionService } from "./session/session.service.js";
import type { WebRequest, WebResponse } from "./http/web.js";
import type { XcoreBridgeOptions, XcoreMode, XcoreStartResult } from "./bridge/contract.js";
import type { SsoMe } from "./types.js";

export type { SsoRefusal, XcoreBridgeOptions, XcoreInjection, XcoreMode, XcoreStartResult } from "./bridge/contract.js";

/**
 * The bridge between an application and x-core: the API that holds the portal and
 * the SSO.
 *
 * Named for what it is rather than for what it talks to. It is not the SSO - it is
 * the one link to it, and everything an application used to copy to build that link
 * is behind it: the signed calls, the boot declaration and its proof that the
 * address really is the provider, the state cookie, the code exchange, the sealed
 * session, the rotation and its re-sealing, the credential queue, the permission
 * checks, the five routes, the error mapping, and the realtime socket with its two
 * credentials and its close codes.
 *
 * What stays the application's: its signer, its own address, and its handlers.
 *
 * A FACADE, and only that. Four files hold what it does: `bridge/contract.ts` is
 * what an application decides and lends, `bridge/wiring.ts` builds the services,
 * `bridge/boot.ts` is everything a boot owes, `bridge/stand-in.ts` and
 * `bridge/access.ts` are the two ways a reader is answered. Nothing here decides
 * anything: it holds the state those need and hands it to them.
 */
export class XcoreBridge {
  /** Which directory answers "who is this", as the application decided. */
  readonly mode: XcoreMode;

  /** The four addresses in use: the API as written, the other three derived. */
  readonly provider: ProviderAddresses;

  readonly http: SsoHttpClient;
  readonly config: SsoConfigService;
  readonly auth: SsoAuthService;
  /** The session machinery. `session()` below is what a handler actually calls. */
  readonly sessions: SsoSessionService;
  /** The five routes, the two guards and the error mapping. */
  readonly middleware: SsoMiddleware;
  /** The socket the browser dials, bridged to the provider's. */
  readonly realtime: SsoRealtimeBridge;
  /** The accounts followed over the socket, empty when `live` is off. */
  readonly live: SsoLiveAccounts | null;

  /**
   * What the application's store said, read once by `start()` and held after.
   *
   * Everything above reads THROUGH it rather than being handed values at
   * construction: at construction there is nothing to hand - the identity, the
   * declaration and the sealing password all arrive from the store, and the store is
   * read inside `start()`.
   */
  private readonly identity = new SsoEnvironment();

  /**
   * The state the boot and the guarded read work on, held in one place.
   *
   * Handed to them rather than reached for: neither is a method of anything, and
   * what they touch is exactly what is named here.
   */
  private readonly ctx: access.AccessContext & boot.BootContext;

  /** What the last `start()` concluded, for a handler that wants to know. */
  private started: XcoreStartResult = {
    ok: false,
    status: "not-paired",
    paired: false,
    declared: false,
    reason: "start() has not run yet",
  };

  /**
   * The credential queue, opened by `start()` and closed with the bridge.
   *
   * Null when there was nothing to open - a store with no broker in it, or a broker
   * that would not answer. Both are logged loudly rather than thrown: the
   * application keeps signing with what it already holds, and what it loses is the
   * NEXT rotation, which is a failure that surfaces days later.
   */
  private propagation: Awaited<ReturnType<typeof startPropagation>> = null;

  constructor(private readonly options: XcoreBridgeOptions) {
    this.mode = options.mode;
    this.provider = addressesOf(options.provider, options.logger);

    const services = buildServices(options, this.identity, this.provider, {
      serving: () => this.serving,
      portalUrl: () => this.portalUrl,
      resolve: (req, res) => this.sessionOf(req, res),
      signIn: (req, res, credentials) => this.signInLocally(req, res, credentials),
      logout: (req, res) => this.logout(req, res),
    });

    this.http = services.http;
    this.config = services.config;
    this.auth = services.auth;
    this.sessions = services.sessions;
    this.live = services.live;
    this.realtime = services.realtime;
    this.middleware = services.middleware;

    this.ctx = {
      options,
      identity: this.identity,
      config: this.config,
      provider: this.provider,
      sessions: this.sessions,
      live: this.live,
      serving: () => this.serving,
      portalUrl: () => this.portalUrl,
    };
  }

  /**
   * End THIS application's session, and say where the reader goes next.
   *
   * On the INSTANCE, beside `session()`, because that is where an application looks
   * for it: a handler that signs somebody out has a request and a response in hand
   * and should not have to know which path this library mounts to do it.
   */
  logout(req: WebRequest, res: WebResponse) {
    return access.logout(this.ctx, req, res);
  }

  /** Sign a reader in against the lent directory, sealing the cookie the SSO seals. */
  signInLocally(req: WebRequest, res: WebResponse, credentials: { email: string; password: string }) {
    return signInLocally(this.ctx, req, res, credentials);
  }

  /**
   * STANDING IN: `mode` is `"local"` and this application lent a directory.
   *
   * Not a degraded mode and not a stand-aside. The library holds real sessions, the
   * guards enforce, a missing right is a `403` - only the answer to "who is this"
   * comes from a list in the application's own source instead of from x-core.
   */
  get standingIn() {
    return isStandingIn(this.options);
  }

  /**
   * Whether this library is actually holding sessions right now.
   *
   * Either the switch is on and the pairing is done - the store read, an identity in
   * it - or it is off and a directory was lent. Both hold sessions, seal the same
   * cookie and enforce the same way; they differ only in who answers "who is this".
   *
   * Anything less and there is nothing to read a session with, and every door shuts:
   * an application that says it uses the SSO and cannot reach it has no business
   * serving what sits behind a guard, and one that lent no directory either has
   * nobody it could ever let in.
   */
  get serving() {
    return this.standingIn || (this.mode === "sso" && this.identity.hydrated && this.identity.installed);
  }

  /** What the last `start()` concluded. */
  get state() {
    return this.started;
  }

  /** Where a signed-out browser goes: what the provider said, or what was written. */
  get portalUrl() {
    const held = this.identity.hydrated ? this.identity.portalUrl : null;
    return held ?? this.provider.portalUrl;
  }

  /**
   * The session behind a request: the account, its details and its rights, as the
   * provider answered them a moment ago.
   *
   * The one method a console calls. It reads the sealed cookie, asks the provider,
   * rotates the pair if it had to and re-seals it, then hands back the three
   * blocks - so a caller never sees a token, never caches an answer, and never has a
   * stale permission to reason about.
   *
   * Null means signed out. A provider that cannot be reached raises instead.
   */
  async session(req: WebRequest, res: WebResponse) {
    const resolved = await this.sessionOf(req, res);
    return resolved?.me ?? null;
  }

  /** The same read, keeping the pair and the account id for whoever needs them. */
  sessionOf(req: WebRequest, res: WebResponse) {
    return access.sessionOf(this.ctx, req, res);
  }

  /**
   * Reading and writing this exchange's cookies, on raw headers.
   *
   * For a handler that needs the sealed session itself rather than the account - the
   * access token behind a socket it opens of its own, typically.
   */
  jar(req: WebRequest, res: WebResponse) {
    return jarOf(req, res);
  }

  /**
   * A socket of one's own, following ONE account.
   *
   * The bridge already follows every account it holds a session for, and that is
   * what makes the reads reactive - this is for a caller wanting the frames
   * themselves: pushing into its own store, fanning out to its own browsers,
   * emptying a cache the library knows nothing about.
   *
   * The caller owns what comes back and closes it. Nothing here is torn down with
   * `close()`, which only lets go of what the bridge itself opened.
   */
  async follow(params: { accessToken: string; onAccount?(me: SsoMe): void; onSignedOut?(): void; topics?: string[] }) {
    const client = new SsoRealtimeClient({
      auth: this.auth,
      url: this.provider.realtimeUrl,
      // Called on the caller's own object, so a listener that is a method keeps
      // whatever `this` it was written against.
      onAccount: (me) => params.onAccount?.(me),
      onSignedOut: () => params.onSignedOut?.(),
      topics: params.topics,
      logger: this.options.logger,
    });
    await client.connect(params.accessToken);
    return client;
  }

  /**
   * What the account may do, as the provider recomputed it for THIS request.
   *
   * The three keys `me` carries: the flat `resource:action` list, the root flag and
   * the groups the rights come through. Nothing to declare and nothing to keep in
   * step - the catalogue is the provider's, and this is a read of it.
   */
  permissions(req: WebRequest) {
    return req.me?.permissions ?? null;
  }

  /**
   * The actions of THIS application the account holds, without their prefix.
   *
   * What a console draws its screens from: `["view-queues", "open-server-shell"]`
   * rather than the whole ecosystem's list. Rights granted on another application
   * are in `permissions()` and invisible here, on purpose.
   */
  actions(req: WebRequest) {
    return this.auth.permissions.held(req.me?.permissions);
  }

  /** Holds this one. `isRoot` needs no case: root comes back holding the lot. */
  can(req: WebRequest, action: string) {
    return this.auth.can(req.me?.permissions, action);
  }

  canAll(req: WebRequest, ...actions: string[]) {
    return this.auth.canAll(req.me?.permissions, ...actions);
  }

  canAny(req: WebRequest, ...actions: string[]) {
    return this.auth.canAny(req.me?.permissions, ...actions);
  }

  /** Refuses unless every action is held, naming what is missing. */
  assert(req: WebRequest, ...actions: string[]) {
    this.auth.assert(req.me?.permissions, ...actions);
  }

  /**
   * Everything a boot owes: read the store, pair if it must, open the queue, declare.
   *
   * Four steps and the order is the whole of it.
   *
   * READ FIRST. `di.environment.load()` is what says whether this application is
   * paired, what identity it signs as, and what password opens its cookies. Nothing
   * above can act before it: an application that signed before reading would sign as
   * nobody and collect a `401` naming nothing.
   *
   * PAIR ONLY IF `INSTALLED` SAYS SO. Not "if a token was given" - the token stays in
   * the configuration for the life of the application, and it is that key which
   * decides. Once it reads true the token is not looked at again, so a deployment
   * that keeps it does not spend it a second time.
   *
   * OPEN THE QUEUE BEFORE DECLARING, because declaring is signed and the credential
   * arrives on the queue. A freshly paired application holds nothing it can sign with
   * until the broker has delivered, which is why `declare()` retries on
   * `NO_CREDENTIAL` rather than failing.
   *
   * DECLARE ALWAYS. Idempotent, and it belongs on every boot: it is what keeps the
   * callback, the login screen and the gate in step with what the console holds.
   *
   * AND IT NEVER THROWS. Every outcome comes back as `XcoreStartResult`, said in one
   * loud line in the log. An application whose token was spent, whose broker is down
   * or whose provider is still starting stands up anyway and is repaired by an
   * operator looking at it, rather than by a container that will not stay alive.
   */
  async start() {
    // LOCAL. Which of the two that means depends on whether a directory was lent.
    if (this.mode === "local") return this.conclude(await boot.standIn(this.ctx));

    try {
      await this.load();
    } catch (error) {
      return this.conclude({
        ok: false,
        status: "not-paired",
        paired: false,
        declared: false,
        reason: `this application's own store could not be read: ${boot.message(error)}`,
      } satisfies XcoreStartResult);
    }

    if (!this.identity.installed) {
      const paired = await boot.pair(this.ctx);
      if (!paired.ok) return this.conclude(paired);
    }

    await boot.ensureSessionPassword(this.ctx);

    this.propagation = await startPropagation({
      identity: this.identity,
      hmac: this.options.di.hmac,
      environment: this.options.di.environment,
      logger: this.options.logger,
    });

    return this.conclude(await boot.declareOnce(this.ctx));
  }

  /** Read the store and hold what it said. Idempotent, and safe on every worker. */
  load() {
    return boot.load(this.ctx);
  }

  /** Declare this application at boot, and prove the address first. */
  declare() {
    return this.config.declare();
  }

  /** Every socket, for a process shutting down. */
  async close() {
    this.live?.close();
    // The queue is the bridge's own: it opened it, it lets it go. A process that
    // exits without closing leaves a consumer registered on the broker until the
    // heartbeat times out, and the next boot finds two.
    await this.propagation?.close?.();
    this.propagation = null;
  }

  /** Everything this application holds in its own store, for whoever wires anything. */
  get environment() {
    return this.identity.hydrated ? this.identity.all : {};
  }

  /** Hold the outcome, and say it once in the log. */
  private conclude(result: XcoreStartResult) {
    this.started = result;
    return boot.announce(this.ctx, result);
  }
}

export const createXcoreBridge = (options: XcoreBridgeOptions) => new XcoreBridge(options);
