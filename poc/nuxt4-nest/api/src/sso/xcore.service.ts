import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { createXcoreBridge, type XcoreBridge } from "@gestionpratique/node-sso-consumer";
import { CredentialsStore } from "./credentials.store";
import { SettingsStore } from "./settings.store";

/**
 * The bridge, and the only thing in this ecosystem that talks to x-core.
 *
 * ONE instance for the whole application: several would each open their own sockets
 * for the same accounts. Built in the constructor rather than as a field, so what it
 * is handed is unambiguously the two stores Nest just injected.
 *
 * What this application DECIDES is short, and what it LENDS is shorter. What it IS
 * towards x-core - identity, callback URL, cancel URL, template, gate - is not here:
 * it is entered on x-core's console at the "L'application" step of the form that
 * mints the install token, and the pairing brings it back. There is one place that
 * decides it, and this file is not it.
 *
 * Nothing comes from a `.env` either, not even the password that seals the cookie:
 * it is minted at the first boot and kept in `app_settings`.
 */
@Injectable()
export class XcoreService implements OnApplicationBootstrap, OnModuleDestroy {
  readonly bridge: XcoreBridge;

  private readonly logger = new Logger("Sso");

  constructor(settings: SettingsStore, credentials: CredentialsStore) {
    this.bridge = createXcoreBridge({
      // ── WHICH DIRECTORY ANSWERS ───────────────────────────────────────────
      //
      // `"sso"` in hard, and deliberately. The usual line is
      // `NODE_ENV === "production" ? "sso" : "local"`, which reads the local
      // directory wherever the ecosystem is not up - and this POC exists for
      // exactly the opposite reason: to run the real chain, the real pairing, the
      // real propagation and a revocation that genuinely arrives over the socket.
      //
      // At `"local"` the library does NOT step back: it stands in for x-core against
      // `di.local_accounts` below. Real sessions, guards that enforce, and a session
      // shaped exactly as the provider answers one - only the answer to "who is
      // this" comes from a list in this file instead of from over there.
      mode: "sso",

      // ── WHERE IT CALLS ────────────────────────────────────────────────────
      //
      // The API of ONE x-core, WITH its port. THE PORT IS THE TRAP: the login window
      // lives on the same names without one and answers `204 No Content` to anything
      // it does not know, unsigned calls included, so an application pointed at it
      // declares itself "successfully" at every boot with nothing on the other side.
      // `start()` proves the address first.
      //
      // `frontUrl` is STATED, and it is a BELT: the login window is a different host
      // from the API - `x-sso` where the API is `x-core` - and a library guessing
      // "the same name without the port" builds an address that does not exist.
      // x-core answers it in the handover now and the stored value wins over this
      // one, so this line only covers the window before that reaches every
      // deployment.
      provider: {
        baseUrl: "https://x-core.gestionpratique.ovh:13001",
        frontUrl: "https://x-sso.gestionpratique.ovh",
      },

      // ── THE ONE VALUE COPIED BY HAND ──────────────────────────────────────
      //
      // Minted on x-core's console under « Portails applicatifs », against the
      // callback
      //
      //     https://tvx-gp3.gestionpratique.ovh/api/auth/sso/callback
      //
      // THE FRONT'S ADDRESS, not this API's. This process publishes no port and is
      // never reached directly: the browser only ever knows the console, and the
      // callback is a NAVIGATION - the browser walks it. Declared against this
      // container the pairing goes green, the declaration succeeds, and the first
      // sign-in dies on an address nothing can resolve.
      //
      // It stays here for the life of the application. What decides whether the
      // exchange happens is not its presence but the `INSTALLED` key of
      // `di.environment`: until that reads true the boot exchanges it, and once it
      // does the boot never looks at it again. So there is no `install()` to call and
      // nothing to remove afterwards - and it opens nothing anyway: x-core deleted
      // its row the moment it was spent.
      installToken: "YDjmkwL0fbjxuCcdlRDH74uA3GFSZdd97wDwtU2E4a8",

      session: {
        // No password and no name here: the first is minted at the first boot and
        // kept in `app_settings`, the second is derived from the identity by x-core.
        //
        // `secure: true`, unlike the `nuxt4-nitro` POC, and it depends on ONE thing:
        // that the console is published over HTTPS. Nothing else - this line is the
        // whole decision. The library never asks the request what protocol it
        // arrived on: it writes the `Secure` attribute from this value with
        // `setHeader`, by hand. So `trust proxy` on this API has no bearing on it,
        // whatever `main.ts` used to claim.
        //
        // What it costs to get wrong is silent either way: `true` on a console served
        // in plain HTTP is a cookie the browser drops at every navigation, and
        // `false` behind HTTPS is a session cookie travelling on any downgrade.
        cookie: { secure: true, sameSite: "lax", maxAgeDays: 30 },
      },

      // `basePath` is what the console's allowlist relays, and the two have to agree:
      // a route moved here without being moved in `server/proxy.config.ts` is a 404
      // from the console that never reaches this process.
      //
      // `loginPath` is read only while standing in: in `"sso"`, the portal is
      // the one place anybody signs in.
      routes: { basePath: "/api/auth", afterLogin: "/", loginPath: "/login" },
      realtime: { path: "/_ws/realtime" },

      // ── OFF, AND THAT IS THE CORRECTION ───────────────────────────────────
      //
      // `live` follows every account this process holds a session for and hands what
      // arrives to `di.onAccount` and `di.onSignedOut`. NEITHER IS LENT HERE, so
      // every one of those sockets would carry frames to nowhere - one socket per
      // signed-in reader, against x-core, for nothing.
      //
      // The realtime the reader actually sees does not come from here. It is the
      // ticket bridge above: the browser dials the console, the console relays to
      // this process, and this process holds the pair. Turning `live` off costs that
      // nothing.
      //
      // Turn it on the day this API keeps a cache of its own to empty, or fans an
      // account out to something that is not a browser.
      live: { enabled: false },

      di: {
        // TWO STORES, and neither crosses. The library names no method of any
        // credential package: it knows three moments - "give me the current hash",
        // "store this one", "this identity is gone" - and these three lines know how.
        // The day the store changes, what breaks is here, in this file.
        hmac: {
          getCredential: (clientId) => credentials.get(clientId),
          setCredential: (clientId, secretHash) => credentials.set(clientId, secretHash),
          deleteCredential: (clientId) => credentials.remove(clientId),
        },

        // The nineteen keys the pairing writes, and the whole of what used to be
        // hand-copied into a `.env` from the console's screen.
        environment: {
          load: () => settings.all(),
          save: (values) => settings.upsertAll(values),
        },

        // ── L'ANNUAIRE LOCAL, LU SEULEMENT À `mode: "local"` ───────────────
        //
        // A LIST, and nothing more. No sign-in function, no password comparison, no
        // form: the login is the library's work, exactly as it is in
        // `"sso"`. What is lent here is the DIRECTORY, never the procedure.
        //
        // The library fills the rest out to the exact shape x-core answers, so a
        // screen reading `me.profile.city` renders here and renders there.
        //
        // A record carries `passwordHash`, scrypt, produced by the library's own
        // `hashPassword` and never written by hand. Empty here: this POC has no
        // local login and never had one.
        local_accounts: [],

        // ── NOTHING IS LENT FOR THE REFUSALS, AND THAT IS THE NEST ANSWER ──
        //
        // `di.errors` is where a refusal is SPOKEN, and under Nitro it had to be
        // lent: the pages were guarded by the library's own middleware, so the only
        // way to turn a refusal into an `H3Error` was from inside it.
        //
        // Here the pages are not on this side at all. What refuses on this process is
        // the guard, it throws `SsoError`, and `XcoreExceptionFilter` is where every
        // refusal is turned into an answer - one place rather than two that would
        // have to agree. What is left for `di.errors` is the library's own six
        // routes, and the plain answer it writes when nothing is lent is already the
        // right one: a `302` to the portal, or JSON with the status.
      },

      logger: console,
      timeoutMs: 10_000,
      // x-core may start after this POC does.
      retry: { attempts: 5, delayMs: 3_000 },
    });
  }

  /**
   * `onApplicationBootstrap` and not `onModuleInit`: everything the declaration needs
   * - the credential store and its table - is up by then, because `DatabaseService`
   * builds the schema in ITS `onModuleInit` and Nest awaits every one of those first.
   *
   * `start()` reads the store, exchanges the install token if `INSTALLED` is not
   * there, opens the credential queue and declares. IT NEVER THROWS: what it did
   * comes back as a value. A boot that died because a token was spent or because
   * x-core was still starting would take this whole API with it.
   */
  async onApplicationBootstrap() {
    const started = await this.bridge.start();

    if (started.ok) return;

    // Said again, in this application's own words, because the state it leaves
    // behind is worth being unambiguous about: everything behind the guard answers
    // `401` until an operator fixes the line above.
    this.logger.error(
      `the SSO is not serving (${started.status}). ` +
        "Mint an install token on x-core, under « Portails applicatifs », with the callback " +
        `${process.env.PUBLIC_URL ?? "<public url>"}/api/auth/sso/callback, put it in ` +
        "`src/sso/xcore.service.ts` and boot again."
    );
  }

  /**
   * A process that exits without letting go leaves a consumer registered on the
   * broker until its heartbeat times out, and the next boot finds two. Reached only
   * because `main.ts` calls `enableShutdownHooks()`.
   */
  onModuleDestroy() {
    this.bridge.close();
  }
}
