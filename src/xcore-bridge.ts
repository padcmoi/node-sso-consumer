import { SsoAuthService } from "./auth.service.js";
import { SsoError, type SsoErrorCode } from "./errors.js";
import { findById, meOf, signIn, type StandInAccount } from "./session/local-accounts.js";
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

/**
 * What an application calls itself while it stands in for the provider.
 *
 * Written into the store like everything the pairing writes, so the session code
 * reads it the same way and does not know the difference. `local` rather than a
 * borrowed-looking identity, because nothing signs with it: there is no provider to
 * sign to, and a name that looked like a real clientId would be read as one in a log.
 */
const LOCAL_CLIENT_ID = "local";

/**
 * The cookie a stand-in session is sealed into.
 *
 * Its own name, distinct from `sso_<clientId>`: a machine that runs an application
 * offline and then pairs it holds two cookies that mean different things, and one
 * opened with the other's password is a reader signed out with no explanation.
 */
const LOCAL_COOKIE_NAME = "sso_local";

export interface XcoreInjection {
  hmac: XcoreHmacInjection;
  environment: XcoreEnvironmentStore;
  /**
   * The readers this application holds ITSELF, for when the provider is not the one
   * answering - `mode: "local"`.
   *
   * A LIST, and nothing more. No sign-in function to write, no password comparison,
   * no form: the login is this library's work, exactly as it is when the switch is
   * on. What an application lends is the DIRECTORY, never the procedure - the same
   * rule as every other key here, which lends a store or an access and never a
   * decision.
   *
   * A `signIn` lent instead would be two logins in the ecosystem, a real one and one
   * hand-written in each application, and the second always drifts: a comparison
   * that does not fold the case of an address, a session sealed some other way, a
   * missing account that throws instead of refusing. What is wanted from this mode is
   * precisely that it behaves like the other one.
   *
   * WHAT THIS LIBRARY DOES WITH IT: it answers the sign-in route, compares, seals the
   * SAME cookie with the same password it drew and stored, re-reads the account here
   * on every request - so a right removed from this list applies on the next refresh,
   * the way a revocation arrives from x-core - and fills the session out to the exact
   * shape `/sso/me` answers.
   *
   * Read ONLY at `mode: "local"`. In `"sso"` this is never looked at: who is there
   * is x-core's answer and nothing else can give it.
   */
  local_accounts?: StandInAccount[];
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
 * Which directory answers "who is this".
 *
 * Not a level of service: both hold real sessions and both enforce. `"local"` is the
 * application's own list standing in for the provider, not the provider turned off.
 */
export type XcoreMode = "sso" | "local";

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
   * WHICH DIRECTORY ANSWERS "who is this". The first key, because it decides every
   * other one.
   *
   * `"sso"`      the provider answers. Pairing, declaration, sessions, socket.
   * `"local"`    this library answers, out of `di.local_accounts`. No pairing, no
   *              declaration, no broker and no socket, because there is nothing on
   *              the other side to do any of it with.
   *
   * NEITHER IS A BYPASS, and that is the thing to read twice. In `"local"` the
   * library holds real sessions, seals the same cookie, and the guards enforce
   * exactly as they do in `"sso"` - a missing right is a `403`. What changes is who
   * is asked, and nothing else. Lending no directory in `"local"` is the one state
   * where nobody can ever sign in, and every door shuts rather than opening.
   *
   * IT WAS A BOOLEAN, `enabled`, and the word was wrong: `false` never turned
   * anything off, it named the other directory. A key that reads "off" and means
   * "the local one" is the kind of thing that gets flipped in production by somebody
   * who thinks it is a feature switch.
   *
   * NO DEFAULT. `enabled` treated an absent key as `true`, so a typo in the key name
   * silently chose the provider. This one is required and the type says so.
   *
   * PASSED, NOT READ, and that is this library's rule rather than a detail: it reads
   * no `process.env`. Read from in here the value would not even be reliable - a
   * bundler (Nitro, Vite, esbuild) replaces `process.env.NODE_ENV` with a constant
   * at build time, so the bundled code carries what was true on the machine that
   * built the image rather than what is true at boot. The application's own line
   * sits in the application's own build, which knows.
   *
   * ```ts
   * mode: NODE_ENV === "production" ? "sso" : "local",
   * ```
   *
   * Nothing forces that line. An application with no local login of its own writes
   * `"sso"` in hard, in every environment, and a development machine that wants the
   * real chain - real pairing, real propagation, a revocation that genuinely arrives
   * over the socket - does the same. Those things do not simulate credibly.
   */
  mode: XcoreMode;

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
    /**
     * The application's OWN sign-in screen, used only while standing in.
     *
     * In `"sso"` there is no such thing: the portal is the one place anybody
     * signs in, and this library never renders a login page. Standing in there is no
     * portal, so a reader with no session has to be sent somewhere - and it has to be
     * a page of THIS application, because the screen belongs to its design and its
     * framework, not to a library.
     *
     * So the split is: this library owns the LOGIN - it compares, it seals, it holds
     * the session - and the application owns the SCREEN, which posts to
     * `<basePath>/sso/sign-in`.
     */
    loginPath?: string;
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
   * A RELAY, and only a relay: what arrives is handed to `di.onAccount` and
   * `di.onSignedOut` so an application can push it into its own store, empty its own
   * cache, or fan it out to browsers it holds. NO GUARD EVER READS FROM IT.
   *
   * It used to. A followed account was served straight out of this for five minutes
   * before the provider was asked again, on the reasoning that the socket says what
   * changed. The reasoning is wrong for one case and it is the case that matters: a
   * session revoked from the portal closes NOTHING over there - x-core re-checks a
   * live socket against the IdP session and the account's access, deliberately not
   * against the consumer session row, because that row is replaced at every rotation.
   * So the frame never comes, and what this held was a session the provider had
   * already refused, served for five more minutes.
   */
  live?: {
    enabled?: boolean;
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
      options.live?.enabled === false || this.mode === "local"
        ? null
        : new SsoLiveAccounts({
            auth: this.auth,
            realtimeUrl: this.provider.realtimeUrl,
            // Called through the options object rather than handed over as a
            // reference, so a listener kept on its own `this` still finds it.
            onAccount: (userId, me) => options.di.onAccount?.(userId, me),
            onSignedOut: (userId) => options.di.onSignedOut?.(userId),
            logger: options.logger,
          });

    this.realtime = new SsoRealtimeBridge({
      auth: this.auth,
      upstreamUrl: this.provider.realtimeUrl,
      path: options.realtime?.path,
      tickets: options.realtime?.tickets,
      // NOT `serving`. Standing in, this library holds real sessions but there is no
      // provider at the other end of a socket: nothing pushes an account that changed
      // because nothing over there knows it changed. So the upgrade is left alone,
      // the ticket route refuses, and a browser stays on plain reads - which is the
      // honest picture rather than a stream that opens onto nothing.
      serving: () => this.mode === "sso" && this.serving,
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
      serving: () => this.serving,
      // Lent, never assumed: the library decides the refusal, this speaks it in
      // whatever the framework underneath expects.
      errors: options.di.errors ? (refusal, req, res) => options.di.errors?.(refusal, req, res) : undefined,
      resolve: (req, res) => this.sessionOf(req, res),
      forget: (userId) => this.live?.forget(userId),
      // Read through, never captured: the provider sends its own portal address at
      // pairing, and what is configured is only what answers before it has.
      portalUrl: () => this.portalUrl,
      basePath: options.routes?.basePath,
      afterLogin: options.routes?.afterLogin,
      loginPath: options.routes?.loginPath,
      // Standing in, a refusal cannot go to a portal that does not exist: it goes to
      // this application's own sign-in screen.
      standingIn: () => this.standingIn,
      signIn: (req, res, credentials) => this.signInLocally(req, res, credentials),
      logout: (req, res) => this.logout(req, res),
      logger: options.logger,
    });
  }

  /**
   * End THIS application's session, and say where the reader goes next.
   *
   * On the INSTANCE, beside `session()`, because that is where an application looks
   * for it: a handler that signs somebody out has a request and a response in hand
   * and should not have to know which path this library mounts to do it.
   *
   * Asymmetric on purpose, and it is the whole shape of this protocol: it closes the
   * session HERE and leaves the reader signed into the SSO and into every other
   * application. Signing out of the provider is done at the portal, by them.
   *
   * Answers the address to send them to rather than redirecting: the caller knows
   * whether it is answering a form or a fetch, and a redirect written into a fetch
   * is a response a browser never follows.
   */
  async logout(req: WebRequest, res: WebResponse) {
    const jar = jarOf(req, res);
    // Read before ending: whatever follows this account has to be dropped with it,
    // or the process keeps a stream open for a session nobody holds.
    const sealed = this.sessions.read(jar);

    // Standing in there is no provider to tell, and nothing to tell it: the session
    // never existed anywhere but in this cookie. Clearing it IS the sign-out.
    if (this.standingIn) this.sessions.clear(jar);
    else await this.sessions.end(jar);

    if (sealed) this.live?.forget(sealed.userId);

    return this.standingIn ? (this.options.routes?.loginPath ?? "/login") : this.portalUrl;
  }

  /**
   * The reader behind the cookie, out of this application's own directory.
   *
   * No provider is called and none exists to call: the seal is opened, the id in it
   * is looked up AGAIN in the list, and what comes back is built into the same shape
   * `/sso/me` answers. An id nobody holds any more - an account deleted from the
   * source - clears the cookie rather than being tolerated, so the next request is
   * simply signed out instead of carrying a ghost.
   *
   * The tokens are empty strings, and that is honest rather than a placeholder:
   * there IS no token pair here, because there is no provider holding a session at
   * the other end. Nothing in this mode has one to spend - the socket does not open
   * and there is no rotation to make - and a caller reaching for one gets an empty
   * value rather than a convincing forgery.
   */
  private localSessionOf(req: WebRequest, res: WebResponse) {
    const accounts = this.options.di.local_accounts ?? [];
    const jar = jarOf(req, res);
    const sealed = this.sessions.read(jar);
    if (!sealed) return null;

    const account = findById(accounts, sealed.userId);
    if (!account) {
      this.options.logger?.warn?.(`[sso] a local session pointed at ${sealed.userId}, which is no longer in the directory`);
      this.sessions.clear(jar);
      return null;
    }

    return {
      me: meOf(account, this.identity.resource ?? ""),
      tokens: { accessToken: "", accessTokenExpiresAt: "", refreshToken: "", refreshTokenExpiresAt: "" },
      userId: sealed.userId,
    };
  }

  /**
   * Sign a reader in against the lent directory, and seal the SAME cookie the SSO
   * seals.
   *
   * The same cookie name, the same password, the same shape inside: that is what
   * makes the switch a switch rather than a migration. A session opened here is read
   * back by exactly the code that reads an SSO one.
   *
   * Refuses with `null` and says nothing about which half was wrong. Telling a wrong
   * address from a wrong password tells whoever is asking which addresses exist.
   */
  signInLocally(req: WebRequest, res: WebResponse, credentials: { email: string; password: string }) {
    if (!this.standingIn) {
      throw new SsoError("NOT_CONFIGURED", "There is no local directory here: signing in goes through the provider");
    }

    const account = signIn(this.options.di.local_accounts ?? [], credentials.email, credentials.password);
    if (!account) return Promise.resolve(null);

    const resolved = meOf(account, this.identity.resource ?? "");
    this.sessions.write(jarOf(req, res), {
      userId: resolved.user.id,
      tokens: { accessToken: "", accessTokenExpiresAt: "", refreshToken: "", refreshTokenExpiresAt: "" },
    });
    this.options.logger?.info?.(`[sso] ${resolved.user.email} signed in against this application's own directory`);
    return Promise.resolve(resolved);
  }

  /**
   * STANDING IN: `mode` is `"local"` and this application lent a directory.
   *
   * Not a degraded mode and not a stand-aside. The library holds real sessions, the
   * guards enforce, a missing right is a `403` - only the answer to "who is this"
   * comes from a list in the application's own source instead of from x-core.
   *
   * Off with NOTHING lent is the one case where there is nothing anybody can do:
   * no provider to ask and no directory to read, so nobody can ever sign in.
   */
  get standingIn() {
    return this.mode === "local" && (this.options.di.local_accounts?.length ?? 0) > 0;
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

  /**
   * The same read, keeping the pair and the account id for whoever needs them.
   *
   * IT ASKS THE PROVIDER, EVERY TIME. There is no held view to answer from and no
   * ceiling under which one is trusted, because the only thing entitled to say
   * whether a reader is still a reader is x-core, and the only moment its answer is
   * true is the moment it gives it.
   *
   * It did hold one - a followed account served for five minutes between proofs, on
   * the reasoning that the socket pushes what changes. A session revoked from the
   * portal pushes nothing: x-core re-checks a live socket against the IdP session and
   * the account's access, not against the consumer session row, because that row is
   * replaced at every rotation. So a reader whose session had been ended kept every
   * door open for five more minutes, which is exactly the forced access this library
   * exists to close.
   *
   * The socket keeps its job, and it is a real one: it repaints screens the instant a
   * right moves. It is not, and cannot be, what a door is opened on.
   */
  async sessionOf(req: WebRequest, res: WebResponse) {
    // STANDING IN: the reader is in this application's own directory, and the
    // account is READ AGAIN here rather than taken from the seal. The seal holds an
    // id and nothing else, deliberately - a permission copied into a cookie is a
    // permission that survives being taken away, which is the one thing this whole
    // library exists not to do. Removing a right from the list therefore applies on
    // the next request, exactly as a revocation from x-core does.
    if (this.standingIn) return this.localSessionOf(req, res);

    // LOCAL, and nothing lent. Nobody can sign in here at all: there is no provider to
    // ask and no directory to read. It is a misconfiguration rather than a signed-out
    // reader, so it throws like every other one.
    if (this.mode === "local") {
      throw new SsoError("NOT_CONFIGURED", "This application has no identity provider and no local accounts: nobody can sign in");
    }

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
      throw new SsoError(
        "NOT_CONFIGURED",
        "This application cannot reach its identity provider: nothing behind a guard is served"
      );
    }

    const jar = jarOf(req, res);
    const sealed = this.sessions.read(jar);
    if (!sealed) return null;

    const resolved = await this.sessions.resolve(jar, clientContextOf(req));

    if (!resolved) {
      this.live?.forget(sealed.userId);
      return null;
    }

    // Signed in, and not entitled to be HERE. The cookie is cleared rather than
    // left standing: it opens nothing any more, and a reader carrying one that is
    // refused on every request would be sent back to the portal by every page
    // without ever being told the session is over.
    if (!this.admitted(resolved.me)) {
      this.options.logger?.warn?.(
        `[sso] ${resolved.me.user.email} does not hold ${resolved.me.permissions.portail.join(", ")}: the session is over for this application`
      );
      this.sessions.clear(jar);
      this.live?.forget(resolved.userId);
      return null;
    }

    this.live?.remember(resolved.userId, resolved.me, resolved.tokens.accessToken);
    return resolved;
  }

  /**
   * May this account be here AT ALL - which is a different question from what it may
   * do once it is.
   *
   * ONE COMPARISON, between two lists the provider answered in the same breath:
   * `portail` is what THIS application requires, `global` is what this account
   * holds, and holding all of the first is the door. Nothing is parsed, split or
   * namespaced - both speak `resource:action`, which is what makes this a subset
   * test and not a convention two ends could read differently.
   *
   * EMPTY REQUIRES NOTHING and everybody passes. That is the common case and it has
   * to stay cheap: an application that declares no requirement, and one that gates
   * itself, both answer an empty list.
   *
   * Neither list is kept anywhere. It used to read the requirement out of what the
   * pairing wrote into this application's own store, which is a copy - so an
   * operator adding a requirement on the console changed it over there while this
   * application went on admitting whoever it had admitted the day it was installed.
   * Now it arrives with every `me`, for this application, and applies at once.
   *
   * Root needs no exception: the provider answers the whole catalogue in its
   * `global`, so the subset holds by construction.
   */
  private admitted(me: SsoMe) {
    const required = me.permissions.portail;
    if (required.length === 0) return true;

    const held = new Set(me.permissions.global);
    return required.every((permission) => held.has(permission));
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
    if (this.mode === "local") return this.conclude(await this.standIn());

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
   * Boot with the switch OFF.
   *
   * With a directory lent, this library stands in for the provider: it draws the
   * cookie password, names the cookie and serves sessions out of that list. No
   * pairing, no declaration, no broker and no socket - there is nothing on the other
   * side to do any of it with - but everything a reader touches behaves the same.
   *
   * With NOTHING lent, it is a misconfiguration and it says so. Not a stand-aside:
   * an application in that state has no provider to ask and no directory to read, so
   * nobody can ever sign in, and pretending otherwise would serve every guarded page
   * to anybody.
   */
  private async standIn() {
    if (!this.standingIn) {
      this.options.logger?.error?.(
        '[sso] NOT SERVING: `mode` is "local" and no `di.local_accounts` were lent, so there is no provider to ask ' +
          'and no directory to read. Nothing behind a guard is served. Set `mode: "sso"`, or lend a directory.'
      );
      return {
        ok: false,
        status: "not-paired",
        paired: false,
        declared: false,
        reason: 'mode is "local" and no local accounts were lent',
      } satisfies XcoreStartResult;
    }

    try {
      await this.load();
      await this.ensureSessionPassword();
      // The two values the pairing would have brought. Named locally and stored the
      // same way, so the session code that reads them does not know the difference -
      // and so a cookie survives a restart, which it would not if these were drawn
      // fresh each time.
      const missing: Record<string, unknown> = {};
      if (typeof this.identity.all[ENV.SSO_CLIENT_ID] !== "string") missing[ENV.SSO_CLIENT_ID] = LOCAL_CLIENT_ID;
      if (typeof this.identity.all[ENV.SSO_SESSION_COOKIE_NAME] !== "string") {
        missing[ENV.SSO_SESSION_COOKIE_NAME] = LOCAL_COOKIE_NAME;
      }
      if (Object.keys(missing).length) {
        await this.options.di.environment.save(missing);
        await this.load();
      }
    } catch (error) {
      return {
        ok: false,
        status: "not-paired",
        paired: false,
        declared: false,
        reason: `this application's own store could not be read: ${message(error)}`,
      } satisfies XcoreStartResult;
    }

    this.options.logger?.info?.(
      `[sso] standing in for the provider: ${this.options.di.local_accounts?.length ?? 0} local account(s), ` +
        "sessions held here, guards enforcing. No pairing, no propagation, no socket."
    );
    return { ok: true, status: "ready", paired: false, declared: false, reason: null } satisfies XcoreStartResult;
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
