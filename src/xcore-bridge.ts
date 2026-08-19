import { SsoAuthService } from "./auth.service.js";
import { SsoConfigService } from "./config.service.js";
import { clientContextOf, jarOf } from "./http/web.js";
import { SsoMiddleware } from "./http/middleware.js";
import { SsoRealtimeBridge } from "./realtime/bridge.js";
import { SsoRealtimeClient } from "./realtime/realtime.client.js";
import type { TicketStore } from "./realtime/tickets.js";
import { SsoHttpClient, type FetchLike, type SsoHmacRuntime } from "./http.js";
import type { WebRequest, WebResponse } from "./http/web.js";
import { SsoLiveAccounts } from "./session/live-accounts.js";
import { SsoSessionService } from "./session/session.service.js";
import { providerFor, type ProviderAddresses, type ProviderEnvironment, type ProviderOverride } from "./providers.js";
import type { SsoConsumerDeclaration, SsoLogger, SsoMe } from "./types.js";

export interface XcoreBridgeOptions {
  /**
   * This application's SSO identity.
   *
   * There is no client_id/client_secret pair in this protocol: the HMAC clientId
   * IS the identity, and a code minted for it can only be redeemed by a caller
   * signing as it. Written down rather than configured, for the same reason the
   * API is: an operator changing it would only be renaming this application into a
   * consumer that does not exist.
   */
  clientId: string;
  /**
   * The HMAC runtime of the service that owns this application's credential store.
   * Injected whole: this library signs with it and holds nothing of its own.
   */
  hmac: SsoHmacRuntime;
  /**
   * Which set of provider addresses to run against. They are written down rather
   * than configured: they vary per environment and not per deployment, and the one
   * mistake they invite - the login window instead of the API - fails silently.
   *
   * Naming `prod` while deploying to dev is legitimate and is how an application
   * deliberately shares one account list across both of its own environments.
   */
  environment: ProviderEnvironment;
  /**
   * The API, written down beside the code that uses it. A bare string is enough;
   * an object overrides the other three addresses too, for another ecosystem.
   *
   * REQUIRED, although the environment above already carries a default, and
   * deliberately: this is the one address whose mistake is silent, so it is the
   * one an integrator has to have looked at and typed. The rest can be inherited.
   */
  provider: ProviderOverride;
  /**
   * How this application plugs in, re-declared at every boot.
   *
   * Named for what the protocol names it: the row is `sso_consumer`, the route is
   * `PUT /sso/consumer/config`, and what is written here IS that consumer.
   */
  consumer: SsoConsumerDeclaration;
  session: {
    /** 32 characters or more. Changing it signs everyone out. */
    password: string;
    cookie?: SsoSessionServiceCookie;
  };
  /**
   * The pairing code that installs this application, once.
   *
   * Given it, `start()` needs nothing else: it redeems the code, writes the
   * credential it brings back into the store, and declares the configuration - so
   * an application goes from nothing to signing in the time of one boot, with no
   * operator step in between. Absent, the credential is expected to be there
   * already, delivered over the broker as it is for an application already paired.
   *
   * Nothing is created by redeeming it. The queue, the broker account, the SSO
   * consumer and the credential were all built when the code was MINTED, on
   * x-core's console, in front of whoever minted it - so a boot either finds its
   * credential waiting or finds nothing at all, and never fails half way.
   *
   * `install(code)` REQUIRES one and reads nothing from here: it is the call that
   * does the installing, and one able to run without a code would be a call whose
   * argument reads as decoration. This option is what `start()` falls back on.
   */
  installToken?: string;
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
   * On by default, and it is what makes the reads below reactive: a permission
   * granted or revoked from anywhere lands here within seconds, instead of at the
   * reader's next navigation. Off, every read asks the provider again - correct,
   * chatty, and late.
   *
   * `staleAfterMs` is the ceiling on how long a followed account is served without
   * asking anyway: the socket says what CHANGED, and this is what re-proves the
   * session is still there when nothing has.
   */
  live?: {
    enabled?: boolean;
    staleAfterMs?: number;
    /**
     * What the provider pushed, as it arrives, for whoever else has to hear it:
     * the application's own store, the browser sockets it holds, a cache it keeps.
     *
     * The reads below are already reactive without this - it is for what this
     * library cannot know about.
     */
    onAccount?(userId: string, me: SsoMe): void;
    /** The session is over: empty whatever was kept for this account. */
    onSignedOut?(userId: string): void;
  };
  /**
   * What runs once per DEPLOYMENT rather than once per process.
   *
   * Declaring is idempotent, so several workers declaring the same thing at boot
   * is noise rather than a fault - but it is one call per worker per boot against
   * a provider with better things to do. Given an election, only the worker that
   * wins it declares and the others skip straight past.
   *
   * Pairing is elected too, and there it is not noise: the code is single-use, so
   * a second worker's attempt is refused and its boot fails on a credential the
   * first one has already written.
   */
  bootstrap?: { elect?(): boolean | Promise<boolean> };
  logger?: SsoLogger;
  /** Injectable so a test drives everything without a network. */
  fetch?: FetchLike;
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

  constructor(private readonly options: XcoreBridgeOptions) {
    this.provider = providerFor(options.environment, options.provider);

    this.http = new SsoHttpClient({
      apiBase: this.provider.apiBase,
      clientId: options.clientId,
      hmac: options.hmac,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      logger: options.logger,
    });

    this.config = new SsoConfigService({
      http: this.http,
      frontUrl: this.provider.frontUrl,
      declaration: options.consumer,
      retry: options.retry,
      logger: options.logger,
    });

    // The resource this application IS, taken from the gate it already declares
    // rather than named a second time. What it may DO is never declared here: the
    // provider recomputes that per account and sends it back with every `me`.
    this.auth = new SsoAuthService({
      http: this.http,
      resource: options.consumer.dependGlobalRessource[0],
      logger: options.logger,
    });

    this.sessions = new SsoSessionService({
      auth: this.auth,
      password: options.session.password,
      cookie: options.session.cookie,
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
            onAccount: (userId, me) => options.live?.onAccount?.(userId, me),
            onSignedOut: (userId) => {
              // Proven-at is cleared with the account, or a later session for the
              // same reader would be served from a stamp nothing stands behind.
              this.provenAt.delete(userId);
              options.live?.onSignedOut?.(userId);
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
      portalUrl: this.provider.portalUrl,
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
   * Everything a boot owes: pair if it must, then declare.
   *
   * With a pairing code and an empty store, this is the whole installation - the
   * code is redeemed, the credential it brings back is written in, and the
   * configuration is declared with it. Without one, or with a credential already
   * there, it is just the declaration, which is idempotent and belongs on every
   * boot anyway.
   *
   * Call it once everything else is up, and await it before serving: an
   * application that failed to declare itself boots perfectly and refuses every
   * sign-in afterwards.
   *
   * The pairing code can be given here instead of in the config, and it is handed
   * straight to `install()`: an application reading it from a prompt or a secret
   * store has one call to make rather than two.
   */
  async start(installToken?: string) {
    // The election is asked ONCE and covers both halves. Asking twice would let a
    // worker lose the pairing and win the declaration, which is a worker declaring
    // with a credential it has not got yet.
    const elected = (await this.options.bootstrap?.elect?.()) ?? true;
    if (!elected) {
      this.options.logger?.info?.("[sso] another worker is pairing and declaring; skipping");
      return null;
    }

    // The config is read HERE and not in `install()`: a boot with no code at all is
    // the ordinary case - every application already installed - and it must not
    // read as a failure.
    const token = installToken?.trim() || this.options.installToken?.trim();
    if (token) await this.install(token);

    return this.declare();
  }

  /**
   * The whole installation, from a code typed into a config to an application the
   * provider knows about.
   *
   * ONE call, and it CREATES NOTHING: the code goes to the route that exists for
   * it, and what comes back is the AMQP queue, the broker account and the
   * credential that were all made when the code was minted on the provider's
   * console. The row over there is deleted in the same breath, which is what makes
   * the code single-use. What comes back is written into the credential store here
   * - and from that moment this application signs for itself, exactly as every
   * application already installed does.
   *
   * The code is REQUIRED here, and it is the only argument. It comes off a screen,
   * it is read once, and it is what the whole call is about - a version of this
   * taking nothing and reaching into the config for it reads as if it could do
   * something without one, which it cannot. `start()` is the one that goes looking
   * in the config, because a boot has to be able to run with no code at all.
   *
   * Skipped in silence only when there is nothing left to do: a credential already
   * in the store. Pairing twice is not a repair - the code is single-use and the
   * second attempt is refused - so that check is what makes `start()` safe to leave
   * in place forever, in the config, for the life of the application.
   */
  async install(installToken: string) {
    const token = installToken?.trim();
    // Loud rather than silent: something called this on purpose, with a value it
    // believed in. An empty one is an environment variable that never got set, and
    // returning `null` here would look like "already installed".
    if (!token) throw new Error("install() needs the pairing code minted on x-core's manager: it was given an empty one");

    const held = await this.options.hmac.clients.getSecretHash(this.options.clientId);
    if (held) return null;

    const clients = this.options.hmac.clients;
    if (!clients.setSecret) {
      throw new Error("An install token was given but this HMAC runtime cannot write a credential: it can only receive one");
    }

    const paired = await this.config.pair({ token, clientId: this.options.clientId });
    // Called on its own object, so a runtime keeping state on `this` still works.
    await clients.setSecret(paired.clientId, paired.secret);
    this.options.logger?.info?.(`[sso] installed as ${paired.clientId}; the install token is spent`);
    // `answer` carries the queue and the secret its propagation consumer verifies
    // inbound events with. Handed back rather than acted on: this library holds no
    // broker, and the application that does is the one entitled to wire it.
    return paired;
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

  /** Redeem a pairing code, once, to bring this application into existence. */
  pair(params: Parameters<SsoConfigService["pair"]>[0]) {
    return this.config.pair(params);
  }
}

export const createXcoreBridge = (options: XcoreBridgeOptions) => new XcoreBridge(options);
