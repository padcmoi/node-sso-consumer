import { SsoAuthService } from "./auth.service.js";
import { SsoError } from "./errors.js";
import { SsoConfigService } from "./config.service.js";
import { clientContextOf, jarOf } from "./http/web.js";
import { SsoMiddleware } from "./http/middleware.js";
import { SsoRealtimeBridge } from "./realtime/bridge.js";
import { SsoRealtimeClient } from "./realtime/realtime.client.js";
import type { TicketStore } from "./realtime/tickets.js";
import { SsoHttpClient, type XcoreHmacInjection } from "./http.js";
import { ENV, SsoEnvironment, mintSessionPassword, type XcoreEnvironmentStore } from "./environment.js";
import type { WebRequest, WebResponse } from "./http/web.js";
import { SsoLiveAccounts } from "./session/live-accounts.js";
import { SsoSessionService } from "./session/session.service.js";
import { providerFor, type ProviderAddresses, type ProviderEnvironment, type ProviderOverride } from "./providers.js";
import type { SsoLogger, SsoMe } from "./types.js";

/**
 * Everything this application LENDS to the library, in one key and nowhere else.
 *
 * It is short, and that is the main fact about this library: it persists nothing. No
 * table, no migration, no schema - an application installing it creates none. The
 * session is a sealed cookie at the reader's end; the account, the profile and the
 * rights are asked of x-core on EVERY request and never cached, which is what makes
 * a permission revoked elsewhere apply here at once rather than at the next expiry
 * of something. The socket ticket lives thirty seconds in memory.
 *
 * What is left comes down to one thing: signing. And that is not to be written
 * either - `@naskot/node-hmac-auth` already signs for the whole application, and its
 * transport is handed over as it is. No secret ever crosses this library.
 */
export interface XcoreInjection {
  hmac: XcoreHmacInjection;
  environment: XcoreEnvironmentStore;
  /**
   * What the provider pushed, for whatever this application keeps that the library
   * cannot know about: its own store, its own sockets, a cache of its own. The reads
   * are already reactive without this.
   */
  onAccount?(userId: string, me: SsoMe): void;
  /** The session is over: empty whatever was kept for this account. */
  onSignedOut?(userId: string): void;
}

/**
 * What this application DECIDES, and what it LENDS. Nothing else.
 *
 * What it IS towards the provider is not here: identity, callback URL, cancel URL,
 * template and gate are entered on the console, at the "application" step of the
 * form that mints the pairing code, and the pairing brings them back. There is
 * therefore one place that decides it, and this file is not it.
 *
 * Nothing comes from a `.env` either - not even the password that seals the cookie.
 */
export interface XcoreBridgeOptions {
  /**
   * Which set of provider addresses to run against. Written down rather than
   * configured: they vary per environment and not per deployment, and the one
   * mistake they invite - the login window instead of the API - fails silently.
   */
  environment: ProviderEnvironment;

  /**
   * The API, WITH its port. Required although the environment above already carries
   * a default, and deliberately: the login window lives on the same names without
   * one and answers `204` to anything it does not know, so an application pointed at
   * it declares itself "successfully" at every boot while nothing exists on the
   * other side. It is the one address whose mistake is silent, so it is the one an
   * integrator has to have looked at and typed.
   */
  provider: ProviderOverride;

  /**
   * The pairing code minted on the console, and the ONE value an operator copies out
   * of the whole flow.
   *
   * It stays here for the life of the application, and that is not an oversight:
   * what decides whether the installation happens is not its presence but the
   * `INSTALLED` key of `di.environment`. Until that reads true the boot exchanges it;
   * once it does, the boot does not even look at it. The code is therefore never
   * spent twice, there is nothing to remove from a configuration afterwards - the
   * gesture people forget - and nothing to remember to call on the right boot.
   *
   * Only needed until the application is paired. One that already is may drop it.
   */
  installToken?: string;

  session?: {
    cookie?: SsoSessionServiceCookie;
  };

  routes?: {
    basePath?: string;
    afterLogin?: string;
  };

  realtime?: {
    /** The path the BROWSER dials on this application's own host. */
    path?: string;
    /** Where a ticket waits. In memory by default: fine for one process. */
    tickets?: TicketStore;
  };

  /**
   * Follow every account this application holds a session for, over the socket.
   *
   * On by default, and it is what makes the reads reactive: a permission granted or
   * revoked from anywhere lands here within seconds, instead of at the reader's next
   * navigation. Off, every read asks the provider again - correct, chatty, and late.
   *
   * `staleAfterMs` is the ceiling on how long a followed account is served without
   * asking anyway: the socket says what CHANGED, and this is what re-proves the
   * session is still there when nothing has.
   */
  live?: {
    enabled?: boolean;
    staleAfterMs?: number;
  };

  di: XcoreInjection;
  logger?: SsoLogger;
  timeoutMs?: number;
  retry?: { attempts?: number; delayMs?: number };
}

type SsoSessionServiceCookie = NonNullable<ConstructorParameters<typeof SsoSessionService>[0]["cookie"]>;

/**
 * How long a followed account is served without asking the provider anyway.
 *
 * Shorter than the access token's own life, so the pair is still rotated by an
 * ordinary read rather than by an expiry nobody saw coming.
 */
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * The bridge between an application and x-core: the API that holds the portal and
 * the SSO.
 *
 * Named for what it is rather than for what it talks to. It is not the SSO - it is
 * the one link to it, and everything an application used to copy to build that
 * link is behind it.
 *
 * Everything the integration used to be copied for is behind it: the signed calls,
 * the boot declaration and its proof that the address really is the provider, the
 * state cookie, the code exchange, the sealed session, the rotation and its
 * re-sealing, the permission checks, the four routes, the error mapping and the
 * realtime socket with its two credentials and its close codes.
 *
 * What stays the application's: the signer, its own addresses, and its handlers.
 */
export class XcoreBridge {
  /** The addresses this consumer actually runs against, resolved once. */
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
  /** When each followed account was last proven against the provider. */
  private readonly provenAt = new Map<string, number>();
  /**
   * What the application's store said, read once by `start()` and held after.
   *
   * Everything above reads THROUGH it rather than being handed values at
   * construction: at construction there is nothing to hand - the identity, the
   * declaration and the sealing password all arrive from the store, and the store is
   * read inside `start()`.
   */
  private readonly identity = new SsoEnvironment();

  constructor(private readonly options: XcoreBridgeOptions) {
    this.provider = providerFor(options.environment, options.provider);

    this.http = new SsoHttpClient({
      apiBase: this.provider.apiBase,
      identity: this.identity,
      hmac: options.di.hmac,
      timeoutMs: options.timeoutMs,
      logger: options.logger,
    });

    this.config = new SsoConfigService({
      http: this.http,
      frontUrl: this.provider.frontUrl,
      identity: this.identity,
      retry: options.retry,
      logger: options.logger,
    });

    // The resource this application IS, taken from the gate it already declares
    // rather than named a second time. What it may DO is never declared here: the
    // provider recomputes that per account and sends it back with every `me`.
    this.auth = new SsoAuthService({
      http: this.http,
      identity: this.identity,
      logger: options.logger,
    });

    this.sessions = new SsoSessionService({
      auth: this.auth,
      identity: this.identity,
      cookie: options.session?.cookie,
      logger: options.logger,
    });

    this.live =
      options.live?.enabled === false
        ? null
        : new SsoLiveAccounts({
            auth: this.auth,
            realtimeUrl: this.provider.realtimeUrl,
            // Called through the options object rather than handed over as a
            // reference, so a listener kept on its own `this` still finds it.
            onAccount: (userId, me) => options.di.onAccount?.(userId, me),
            onSignedOut: (userId) => {
              // Proven-at is cleared with the account, or a later session for the
              // same reader would be served from a stamp nothing stands behind.
              this.provenAt.delete(userId);
              options.di.onSignedOut?.(userId);
            },
            logger: options.logger,
          });

    this.realtime = new SsoRealtimeBridge({
      auth: this.auth,
      upstreamUrl: this.provider.realtimeUrl,
      path: options.realtime?.path,
      tickets: options.realtime?.tickets,
      logger: options.logger,
    });

    this.middleware = new SsoMiddleware({
      auth: this.auth,
      config: this.config,
      session: this.sessions,
      realtime: this.realtime,
      resolve: (req, res) => this.sessionOf(req, res),
      forget: (userId) => {
        this.live?.forget(userId);
        this.provenAt.delete(userId);
      },
      // Read through, never captured: the provider sends its own portal address at
      // pairing, and the address book is only what answers before it has.
      portalUrl: () => this.identity.portalUrl ?? this.provider.portalUrl,
      basePath: options.routes?.basePath,
      afterLogin: options.routes?.afterLogin,
      logger: options.logger,
    });
  }

  /**
   * The session behind a request: the account, its details and its rights, as the
   * provider answered them a moment ago.
   *
   * The one method a console calls. It reads the sealed cookie, asks the provider,
   * rotates the pair if it had to and re-seals it, then hands back the three
   * blocks - so a caller never sees a token, never caches an answer, and never has
   * a stale permission to reason about.
   *
   * Null means signed out. A provider that cannot be reached raises instead.
   */
  async session(req: WebRequest, res: WebResponse) {
    const resolved = await this.sessionOf(req, res);
    return resolved?.me ?? null;
  }

  /**
   * The same read, keeping the pair and the account id for whoever needs them.
   *
   * Served from what the socket last pushed when this account is being followed
   * and was proven recently enough - so a page load costs one round trip and the
   * navigations behind it cost none, while a permission changed anywhere lands in
   * seconds. Past the ceiling, or with nothing followed, it asks the provider,
   * which is also what rotates the pair and re-seals it.
   */
  async sessionOf(req: WebRequest, res: WebResponse) {
    const jar = jarOf(req, res);
    const sealed = this.sessions.read(jar);
    if (!sealed) return null;

    const pushed = this.live?.view(sealed.userId) ?? null;
    if (pushed && this.isProven(sealed.userId)) {
      return { me: pushed, tokens: sealed.tokens, userId: sealed.userId };
    }

    const resolved = await this.sessions.resolve(jar, clientContextOf(req));

    if (!resolved) {
      this.live?.forget(sealed.userId);
      this.provenAt.delete(sealed.userId);
      return null;
    }

    this.provenAt.set(resolved.userId, Date.now());
    this.live?.remember(resolved.userId, resolved.me, resolved.tokens.accessToken);
    return resolved;
  }

  /**
   * Reading and writing this exchange's cookies, on raw headers.
   *
   * For a handler that needs the sealed session itself rather than the account -
   * the access token behind a socket it opens of its own, typically.
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

  private isProven(userId: string) {
    const at = this.provenAt.get(userId);
    if (at === undefined) return false;
    return Date.now() - at < (this.options.live?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  }

  /**
   * What the account may do, as the provider recomputed it for THIS request.
   *
   * The three keys `me` carries: the flat `resource:action` list, the root flag
   * and the groups the rights come through. Nothing to declare and nothing to keep
   * in step - the catalogue is the provider's, and this is a read of it.
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
   * Everything a boot owes: read the environment, pair if it must, then declare.
   *
   * Three steps, and the order is the whole of it.
   *
   * READ FIRST. `di.environment.load()` is what says whether this application is
   * paired, what identity it signs as, and what password opens its cookies. Nothing
   * above can act before it: an application that signed before reading would sign as
   * nobody and collect a `401` naming nothing.
   *
   * PAIR ONLY IF `INSTALLED` SAYS SO. Not "if a code was given" - the code stays in
   * the configuration for the life of the application, and it is this key that
   * decides. Once it reads true the code is not looked at again, so a deployment
   * that keeps it does not spend it a second time and there is nothing to remember
   * to remove.
   *
   * DECLARE ALWAYS. Idempotent, and it belongs on every boot: it is what keeps the
   * callback, the login screen and the gate in step with what the console holds.
   *
   * Await it before serving. An application that failed to declare itself boots
   * perfectly and refuses every sign-in afterwards, which is the longest failure to
   * trace back.
   */
  async start() {
    await this.load();
    if (!this.identity.installed) await this.pair();
    await this.ensureSessionPassword();

    return this.declare();
  }

  /**
   * Read the store and hold what it said. Idempotent, and safe on every worker.
   *
   * Its own method because a deployment running several processes elects ONE of them
   * to declare - PM2's instance 0, typically - and the others still have to know
   * what they sign as. Election belongs outside this library: it knows nothing of
   * PM2, of how many workers there are, or of how they are numbered.
   */
  async load() {
    this.identity.hydrate(await this.options.di.environment.load());
    return this.identity;
  }

  /**
   * Exchange the pairing code, write the credential, and record the whole of it.
   *
   * NOTHING IS CREATED by this call. The queue, the broker account, the SSO consumer
   * and the HMAC credential were all made when the code was MINTED, on the console,
   * in front of whoever minted it. This collects them, x-core deletes its row in the
   * same breath and revokes the infrastructure manager key it had borrowed.
   *
   * `INSTALLED` is written in the SAME `save` as everything else and never before
   * it. Written first, a boot falling between the two would believe itself paired
   * while holding none of what that announces - and would never try again, since it
   * no longer looks at the code.
   */
  private async pair() {
    const token = this.options.installToken?.trim();
    if (!token) {
      throw new SsoError(
        "NO_CREDENTIAL",
        "This application is not paired and carries no install token: mint one on x-core's console, under Portails applicatifs, and put it in `installToken`"
      );
    }

    const paired = await this.config.pair({ token });
    // Written into the store that signs with it, and nowhere else: a credential has
    // no business sitting in a key/value shelf beside a broker password.
    await this.options.di.hmac.setSecret(paired.clientId, paired.secret);

    const values = {
      ...paired.environment,
      // Minted here and never received: two applications sharing this password could
      // open each other's cookies, while each holds its own row on the provider,
      // revocable separately.
      [ENV.SSO_SESSION_PASSWORD]: this.identity.all[ENV.SSO_SESSION_PASSWORD] ?? mintSessionPassword(),
      [ENV.INSTALLED]: true,
    };

    await this.options.di.environment.save(values);
    this.identity.hydrate({ ...this.identity.all, ...values });
    this.options.logger?.info?.(`[sso] paired as ${paired.clientId}; the install token is spent`);

    return paired;
  }

  /**
   * A sealing password, minted if the store holds none.
   *
   * Deleting that key is how an operator signs everyone out at once - every existing
   * cookie stops opening - so a boot finding it gone mints a new one rather than
   * refusing to start. It is a tool, not a fault.
   */
  private async ensureSessionPassword() {
    if (typeof this.identity.all[ENV.SSO_SESSION_PASSWORD] === "string") return;

    const password = mintSessionPassword();
    await this.options.di.environment.save({ [ENV.SSO_SESSION_PASSWORD]: password });
    this.identity.hydrate({ ...this.identity.all, [ENV.SSO_SESSION_PASSWORD]: password });
    this.options.logger?.warn?.("[sso] no session password in the store: a new one was minted, every existing cookie is now void");
  }

  /**
   * Declare this application at boot, and prove the address first.
   *
   * Call it once everything else is up: the credential arrives over the broker,
   * and the propagator that receives it starts in the same boot.
   */
  declare() {
    return this.config.declare();
  }

  /** Every socket, for a process shutting down. */
  close() {
    this.live?.close();
    this.provenAt.clear();
  }

  /** Everything this application holds in its own store, for whoever wires the broker. */
  get environment() {
    return this.identity.all;
  }
}

export const createXcoreBridge = (options: XcoreBridgeOptions) => new XcoreBridge(options);
