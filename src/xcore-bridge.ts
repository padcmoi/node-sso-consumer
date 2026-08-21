import { SsoAuthService } from "./auth.service.js";
import { SsoError, type SsoErrorCode } from "./errors.js";
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
import { addressesOf, type ProviderAddresses, type ProviderEndpoint } from "./provider.js";
import { startPropagation } from "./propagation.js";
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
 * What is left comes down to one thing: signing. And that is not written here
 * either - `@naskot/node-hmac-auth` already signs for the whole application, with
 * its own store, and the two functions below are the only door onto it. No secret
 * ever crosses this library.
 */
/**
 * A refusal, fully decided, handed to whatever the application lends to express it.
 *
 * Everything here is the library's conclusion, never a hint: `status` is its own
 * table, `redirectTo` is the portal when there is one and `null` when this
 * application was never paired and has nowhere to send anybody.
 */
export interface SsoRefusal {
  /** 500 never paired, 401 nobody identified, 403 identified and lacking the right. */
  status: number;
  /** Which of the library's causes it was, for a log or a branch. */
  code: SsoErrorCode;
  /** One sentence, safe to show: it names no internal state. */
  message: string;
  /** Where a browser should go, or null when there is nowhere. */
  redirectTo: string | null;
}

export interface XcoreInjection {
  hmac: XcoreHmacInjection;
  environment: XcoreEnvironmentStore;
  /**
   * How THIS application says "refused", lent to the library.
   *
   * The library decides WHETHER and WHY - it is the only thing that talks to the
   * provider, so it is the only thing that can. It does not decide HOW, because how
   * a refusal is expressed belongs to the framework underneath: Nitro wants an
   * `H3Error` thrown, Nest wants an exception of its own, Express wants `next` with
   * something on it. A library that wrote the response itself would be writing over
   * whatever those do with it.
   *
   * So it is injected, and it is called from inside the refusal rather than around
   * it: one function, handed everything already decided - the status, the code, the
   * sentence, and the address to send a browser to when there is one.
   *
   * It is handed the raw request and response WITH the refusal, so that it can
   * answer EVERY kind on its own: `403` and `500` as a body, and the `401` that
   * sends a browser to the portal as a redirect. Without them the redirect could not
   * be expressed - a thrown `302` carries a body and no `Location` - and this would
   * be a door that handles some refusals and leaves the rest to the library, which
   * is two places deciding one thing.
   *
   * Answer however the framework wants: write on `res`, or THROW - the throw
   * travels untouched, which is what Nitro and Nest both want.
   *
   * OPTIONAL. Lend nothing and the library writes the plain answer itself: a
   * redirect when there is a portal, a JSON body otherwise. It never leaves a
   * request hanging, whatever this does.
   */
  errors?(refusal: SsoRefusal, req: WebRequest, res: WebResponse): void;
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
 * form that mints the install token, and the pairing brings them back. There is
 * therefore one place that decides it, and this file is not it.
 *
 * Nothing comes from a `.env` either - not even the password that seals the cookie.
 */
export interface XcoreBridgeOptions {
  /**
   * ON, OR WITHDRAWN. The first key, because it decides every other one.
   *
   * At `false` this library WITHDRAWS: no pairing, no declaration, no session, no
   * socket. `start()` hands back without doing anything, the guards let everything
   * through, and what signs anybody in is the application's own affair - a hardcoded
   * login, an account in a table, whatever it had before. It is a decision rather
   * than a fault: it does not throw and says no more than one line in the log.
   *
   * IT IS NOT A "DEV MODE", it is a switch, and the application computes it. The
   * usual line turns it on in production and off elsewhere, because the usual case
   * is a screen being built without the ecosystem behind it. Nothing forces that
   * line: a development machine that wants the real chain - real pairing, real
   * propagation, a revocation that genuinely arrives over the socket - writes
   * `enabled: true` and never looks at it again. Those things do not simulate
   * credibly.
   *
   * PASSED, NOT READ, and that is this library's rule rather than a detail: it reads
   * no `process.env`. Read from in here the value would not even be reliable - a
   * bundler (Nitro, Vite, esbuild) replaces `process.env.NODE_ENV` with a constant
   * at build time, so the bundled code carries what was true on the machine that
   * built the image rather than what is true at boot. The application's own line
   * sits in the application's own build, which knows.
   *
   * ```ts
   * enabled: NODE_ENV == "production" ? true : false,
   * ```
   *
   * OFF BY MISTAKE IN PRODUCTION it does not fall over: it leaves a production
   * offering its fallback login to the internet, cleanly and without a word. That is
   * why it is the first key of the object.
   */
  enabled: boolean;

  /**
   * The provider: ONE x-core, named by its API with its port.
   *
   * It is the only address an application writes itself, and it cannot be otherwise:
   * everything else comes back from the pairing, but one does not learn where to
   * reach the provider from the provider. It has to be known before there is any
   * right to call.
   *
   * THE PORT IS THE TRAP. The login window lives on the same names without one and
   * answers `204 No Content` to anything it does not know, unsigned calls included -
   * so an application pointed at it declares itself "successfully" at every boot and
   * nothing exists on the other side. `start()` refuses that by proving the address
   * first: an unsigned call that is not answered `401` means nothing is declared.
   *
   * IT GOES WITH THE INSTALL TOKEN below. A token is a row in THIS x-core's database,
   * with its queue, its broker account and its credential behind it; presented to
   * another it finds nothing. The two keys are a couple, and writing one under the
   * other is what makes the day they point apart visible.
   */
  provider: ProviderEndpoint;

  /**
   * The install token minted on the console, and the ONE value an operator copies
   * out of this whole flow.
   *
   * It stays here for the life of the application, and that is not an oversight:
   * what decides whether the installation happens is not its presence but the
   * `INSTALLED` key of `di.environment`. Until that reads true the boot exchanges
   * it; once it does, the boot does not even look at it. The token is therefore
   * never spent twice, there is nothing to remove from a configuration afterwards -
   * the gesture people forget - and nothing to remember to call on the right boot.
   *
   * NOTHING IS CREATED by exchanging it. The queue, the broker account, the SSO
   * consumer and the HMAC credential were all built when it was MINTED, on the
   * console, in front of whoever minted it. A boot either finds its reservation
   * waiting or finds nothing at all, and never half of it.
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
  /**
   * The provider may start after this application does. Five attempts three seconds
   * apart cover a `docker compose up` where the two go up together.
   */
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
 * What a boot did, said as a value rather than as an exception.
 *
 * `start()` NEVER THROWS, and that is deliberate rather than lax. A boot that dies
 * because a token was spent, because the broker is not up yet or because the
 * provider is still starting takes the whole application with it - including the
 * pages that have nothing to do with the SSO and including whatever an operator
 * would use to look at the problem. What is wanted instead is an application that
 * stands up, says loudly and in one line what is not working, and is repaired by a
 * token in a configuration rather than by a container that will not stay alive.
 *
 * The caller may still refuse to serve on it. `ok` is the one field to branch on.
 */
export interface XcoreStartResult {
  /** Nothing is broken: either it is paired and declared, or it withdrew on purpose. */
  ok: boolean;
  status: "withdrawn" | "ready" | "not-paired" | "not-declared";
  /** Whether the store says this application holds an identity. */
  paired: boolean;
  /** Whether the provider was told how this application plugs in, on this boot. */
  declared: boolean;
  /** One sentence, in plain words, when something did not happen. */
  reason: string | null;
}

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
 */
export class XcoreBridge {
  /** Whether this library runs at all, as the application decided. */
  readonly enabled: boolean;

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
    this.enabled = options.enabled !== false;
    this.provider = addressesOf(options.provider, options.logger);

    this.http = new SsoHttpClient({
      apiBase: this.provider.apiBase,
      identity: this.identity,
      hmac: options.di.hmac,
      timeoutMs: options.timeoutMs,
      logger: options.logger,
    });

    this.config = new SsoConfigService({
      http: this.http,
      // Read through, never captured: the provider may name its login window at
      // pairing, and the pairing happens inside `start()`.
      frontUrl: () => (this.identity.hydrated ? (this.identity.frontUrl ?? this.provider.frontUrl) : this.provider.frontUrl),
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
      options.live?.enabled === false || !this.enabled
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
      serving: () => this.serving,
      logger: options.logger,
    });

    this.middleware = new SsoMiddleware({
      auth: this.auth,
      config: this.config,
      session: this.sessions,
      realtime: this.realtime,
      // Withdrawn, or standing up, or unpaired, or the provider unreachable: the
      // guards SHUT. This library is the bridge, and what sits behind a guard needs
      // to know who is asking - so an application that cannot ask serves none of it.
      // OFF is a decision, not a fault: the guards stand aside and the application's
      // own login is what holds the door. Everything else is a fault, and shuts.
      withdrawn: () => !this.enabled,
      serving: () => this.serving,
      // Lent, never assumed: the library decides the refusal, this speaks it in
      // whatever the framework underneath expects.
      errors: options.di.errors ? (refusal, req, res) => options.di.errors?.(refusal, req, res) : undefined,
      resolve: (req, res) => this.sessionOf(req, res),
      forget: (userId) => {
        this.live?.forget(userId);
        this.provenAt.delete(userId);
      },
      // Read through, never captured: the provider sends its own portal address at
      // pairing, and what is configured is only what answers before it has.
      portalUrl: () => this.portalUrl,
      basePath: options.routes?.basePath,
      afterLogin: options.routes?.afterLogin,
      logger: options.logger,
    });
  }

  /**
   * Whether this library is actually holding sessions right now.
   *
   * Three conditions and they are not the same one: the application turned it on,
   * the store has been read, and the store says this application has an identity.
   * Anything less and there is nothing to read a session with - no cookie name, no
   * sealing password, nothing to sign as - so every door stands aside rather than
   * refusing a reader for a reason that is not theirs.
   */
  get serving() {
    return this.enabled && this.identity.hydrated && this.identity.installed;
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

  /**
   * The same read, keeping the pair and the account id for whoever needs them.
   *
   * Served from what the socket last pushed when this account is being followed and
   * was proven recently enough - so a page load costs one round trip and the
   * navigations behind it cost none, while a permission changed anywhere lands in
   * seconds. Past the ceiling, or with nothing followed, it asks the provider, which
   * is also what rotates the pair and re-seals it.
   */
  async sessionOf(req: WebRequest, res: WebResponse) {
    // WITHDRAWN is not a fault, so it is not an error. `enabled: false` says this
    // deployment does not use the SSO at all, and the honest answer to "who is
    // signed in here" is then nobody - which is what `null` means everywhere else
    // in this library. Its own login is what holds the door.
    if (!this.enabled) return null;

    // ON, and unable to ask. THAT throws rather than answering "no reader", and the
    // difference is the whole point: `null` means nobody is signed in, which a
    // caller answers with a `401` and a way to sign in. This means the provider
    // cannot be reached at all, so there is no way to sign in and nothing that could
    // ever answer `401` usefully.
    //
    // Returned as `null` - which is what this did - the two collapsed, every caller
    // read "not signed in", and an application nobody had configured served the
    // shell of every protected page to anyone who asked.
    if (!this.serving) {
      throw new SsoError("NOT_CONFIGURED", "This application cannot reach its identity provider: nothing behind a guard is served");
    }

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

  private isProven(userId: string) {
    const at = this.provenAt.get(userId);
    if (at === undefined) return false;
    return Date.now() - at < (this.options.live?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
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
    // WITHDRAWN. Not a failure and not a refusal: it is how an application says
    // "not here", and what it does instead about signing anybody in is its own.
    if (!this.enabled) {
      this.options.logger?.info?.(
        "[sso] withdrawn (`enabled: false`): no pairing, no declaration, no session and no socket. " +
          "Whatever signs a reader in is this application's own."
      );
      return this.conclude({
        ok: true,
        status: "withdrawn",
        paired: false,
        declared: false,
        reason: null,
      } satisfies XcoreStartResult);
    }

    try {
      await this.load();
    } catch (error) {
      return this.conclude({
        ok: false,
        status: "not-paired",
        paired: false,
        declared: false,
        reason: `this application's own store could not be read: ${message(error)}`,
      } satisfies XcoreStartResult);
    }

    if (!this.identity.installed) {
      const paired = await this.pair();
      if (!paired.ok) return this.conclude(paired);
    }

    await this.ensureSessionPassword();

    this.propagation = await startPropagation({
      identity: this.identity,
      hmac: this.options.di.hmac,
      environment: this.options.di.environment,
      logger: this.options.logger,
    });

    return this.conclude(await this.declareOnce());
  }

  /**
   * Read the store and hold what it said. Idempotent, and safe on every worker.
   *
   * Its own method because a deployment running several processes elects ONE of them
   * to declare - PM2's instance 0, typically - and the others still have to know what
   * they sign as. Election belongs outside this library: it knows nothing of PM2, of
   * how many workers there are, or of how they are numbered.
   */
  async load() {
    this.identity.hydrate(await this.options.di.environment.load());
    return this.identity;
  }

  /** Declare this application at boot, and prove the address first. */
  declare() {
    return this.config.declare();
  }

  /** Every socket, for a process shutting down. */
  async close() {
    this.live?.close();
    this.provenAt.clear();
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

  /**
   * Exchange the install token, and record the whole of what comes back.
   *
   * NOTHING IS CREATED by this call. The queue, the broker account, the SSO consumer
   * and the HMAC credential were all made when the token was MINTED, on the console,
   * in front of whoever minted it. This collects them; x-core deletes its row in the
   * same breath. The manager key an operator lent to build it stays theirs and is
   * not touched: one key installs as many applications as they have to install.
   *
   * `INSTALLED` is written in the SAME `save` as everything else and never before
   * it. Written first, a boot falling between the two would believe itself paired
   * while holding none of what that announces - and would never try again, since it
   * no longer looks at the token.
   */
  private async pair() {
    const token = this.options.installToken?.trim();
    if (!token) {
      return {
        ok: false,
        status: "not-paired",
        paired: false,
        declared: false,
        reason:
          "this application is not paired and carries no install token. Mint one on x-core's console, under " +
          "Portails applicatifs, and put it in `installToken`.",
      } satisfies XcoreStartResult;
    }

    let paired: Awaited<ReturnType<SsoConfigService["pair"]>>;
    try {
      paired = await this.config.pair({ token });
    } catch (error) {
      // x-core's own words are what an operator needs here, and they are precise:
      // an unknown token, one withdrawn, one expired, one already redeemed, or one
      // still a draft - which is a form somebody left half finished, with no queue,
      // no broker account and no credential behind it to hand over.
      return {
        ok: false,
        status: "not-paired",
        paired: false,
        declared: false,
        reason: `the install token was refused by ${this.provider.apiBase}: ${message(error)}`,
      } satisfies XcoreStartResult;
    }

    // The secret this answer carries is NOT written anywhere, and that is not an
    // omission. x-core stores `hashClientSecret(secret, pepper)` and verifies against
    // that; the pepper is its own and never travels. An application that hashed this
    // secret itself would store something else, sign with it, and collect a
    // `401 BAD_SIGNATURE` on every call while holding the right secret.
    //
    // What signs is the hash x-core computed, and it only ever arrives on the
    // propagation queue - which is why that queue is not a convenience.
    const values = {
      ...paired.environment,
      // Minted here and never received: two applications sharing this password could
      // open each other's cookies, while each holds its own row on the provider,
      // revocable separately.
      [ENV.SSO_SESSION_PASSWORD]: this.identity.all[ENV.SSO_SESSION_PASSWORD] ?? mintSessionPassword(),
      [ENV.INSTALLED]: true,
    };

    try {
      await this.options.di.environment.save(values);
    } catch (error) {
      // The token is spent over there and the answer is gone with this process. It
      // has to be said in the loudest terms available: what repairs this is a new
      // token, not another boot.
      return {
        ok: false,
        status: "not-paired",
        paired: false,
        declared: false,
        reason:
          `paired as ${paired.clientId}, but this application's store refused to keep it: ${message(error)}. ` +
          "The install token is spent: mint a new one once the store is writable.",
      } satisfies XcoreStartResult;
    }

    this.identity.hydrate({ ...this.identity.all, ...values });
    this.options.logger?.info?.(`[sso] paired as ${paired.clientId}; the install token is spent`);

    return { ok: true, status: "ready", paired: true, declared: false, reason: null } satisfies XcoreStartResult;
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
    this.options.logger?.warn?.(
      "[sso] no session password in the store: a new one was minted, every existing cookie is now void"
    );
  }

  /** The declaration, with its outcome as a value rather than as an exception. */
  private async declareOnce() {
    try {
      await this.config.declare();
      return { ok: true, status: "ready", paired: true, declared: true, reason: null } satisfies XcoreStartResult;
    } catch (error) {
      return {
        ok: false,
        status: "not-declared",
        paired: true,
        declared: false,
        reason: `${this.provider.apiBase} was not told how this application plugs in: ${message(error)}`,
      } satisfies XcoreStartResult;
    }
  }

  /**
   * Hold the outcome, and say it once in the log.
   *
   * Loud on purpose: an application that failed to declare itself boots perfectly and
   * refuses every sign-in afterwards, which is the failure that costs an afternoon
   * to trace back to here.
   */
  private conclude(result: XcoreStartResult) {
    this.started = result;
    if (result.ok && result.status === "ready") {
      this.options.logger?.info?.(`[sso] ready against ${this.provider.apiBase} as ${this.identity.clientId}`);
    } else if (!result.ok) {
      this.options.logger?.error?.(
        `[sso] NOT SERVING (${result.status}): ${result.reason ?? "no reason given"}. ` +
          "This application is up, and nobody can sign in through the SSO until that line is fixed."
      );
    }
    return result;
  }
}

/** What went wrong, in one line, with the provider's own words when it gave any. */
const message = (error: unknown) => {
  if (error instanceof SsoError) return error.detail ? `${error.message} (${error.detail})` : error.message;
  return error instanceof Error ? error.message : String(error);
};

export const createXcoreBridge = (options: XcoreBridgeOptions) => new XcoreBridge(options);
