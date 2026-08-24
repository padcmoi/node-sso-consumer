import type { SsoErrorCode } from "../errors.js";
import type { StandInAccount } from "../session/local-accounts.js";
import type { SsoSessionService } from "../session/session.service.js";
import type { TicketStore } from "../realtime/tickets.js";
import type { XcoreHmacInjection } from "../http.js";
import type { XcoreEnvironmentStore } from "../environment.js";
import type { WebRequest, WebResponse } from "../http/web.js";
import type { ProviderEndpoint } from "../provider.js";
import type { SsoLogger, SsoMe } from "../types.js";

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
 * The four ways this library reaches an application's own directory.
 *
 * Data access, and nothing above it. The library decides who may in, what a wrong
 * password answers and what a record has to contain; these say where the rows are.
 *
 * Every one may answer a promise or a value, because a directory is a table for one
 * application and a literal for the next, and neither should have to pretend.
 *
 * `create` and `update` are OPTIONAL, and an application that only reads a directory
 * somebody else seeded lends neither. They exist so that a hash is never produced
 * outside this library: `xcore.accounts.signUp` hashes and calls `create`, and an
 * application that wrote the hash itself would have to reproduce the scrypt
 * parameters - which does not fail loudly the day they drift, it fails as every
 * password being wrong at once.
 */
export interface XcoreAccountStore {
  /** The sign-in read. Matched case-insensitively: an address is. */
  findByEmail(email: string): Promise<StandInAccount | null> | StandInAccount | null;
  /** The per-request read, from the id inside the sealed cookie. */
  findById(id: string): Promise<StandInAccount | null> | StandInAccount | null;
  /** Write a record whose `passwordHash` this library has just produced. */
  create?(account: StandInAccount): Promise<StandInAccount> | StandInAccount;
  /** Change what one holds - a password, a name, a right. */
  update?(id: string, patch: Partial<StandInAccount>): Promise<void> | void;
}

export interface XcoreInjection {
  hmac: XcoreHmacInjection;
  environment: XcoreEnvironmentStore;
  /**
   * How to REACH the readers this application holds itself, for when the provider is
   * not the one answering - `mode: "local"`.
   *
   * ACCESS FUNCTIONS, never business verbs, and that is the rule the other two
   * injections already follow: `hmac` is get/set/delete, `environment` is load/save,
   * and neither is called "rotate the credential" or "install". A `login` or a
   * `register` lent here would be the DECISION leaving the library - and the decision
   * is the one thing it must keep, because in this mode it is the only thing that
   * knows the hash format.
   *
   * It used to be an ARRAY, and that was its ceiling: a directory written as a
   * literal cannot be added to without a deploy, and a scrypt hash typed by hand into
   * a source file is no better protected than the clear password it replaced. What
   * makes the hash mean something is a table, and a table is read through a function.
   *
   * WHAT THIS LIBRARY DOES WITH IT: it answers the sign-in route, compares with
   * `verifyPassword`, seals the SAME cookie with the same password it drew and
   * stored, re-reads the account through `findById` on EVERY request - so a right
   * removed from the table applies on the next one, the way a revocation arrives from
   * x-core - and fills the session out to the exact shape `/sso/me` answers.
   *
   * Read ONLY at `mode: "local"`. In `"sso"` this is never looked at: who is there
   * is x-core's answer and nothing else can give it.
   *
   * LENDING IT IS THE DECLARATION that a directory exists. An empty table is a
   * legitimate state - an application whose first account has not been created yet -
   * and it refuses every sign-in without pretending to be misconfigured. Lending
   * nothing at all in `"local"` is the misconfiguration, and every door shuts.
   */
  accounts?: XcoreAccountStore;
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
   * `"local"`    this library answers, out of `di.accounts`. No pairing, no
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
    /**
     * Whether `<base>/sso/sign-up` answers at all. OFF unless this says otherwise.
     *
     * Opt-in rather than implied by `di.accounts.create`, because an application may
     * lend that for an administration screen and want nothing open to the internet.
     * A route that appeared the moment `create` existed would be a public sign-up
     * nobody asked for, on a deployment whose author never read this line.
     *
     * `"local"` only: in `"sso"` there is nothing here to create an account in.
     */
    signUp?: boolean;
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
