import { AsyncLocalStorage } from "node:async_hooks";
import {
  createXcoreBridge,
  type SsoMe,
  type WebRequest,
  type WebResponse,
  type XcoreBridge,
} from "@gestionpratique/node-sso-consumer";
import type { Pool } from "mysql2/promise";
import { accountsOf, createPool, credentialsOf, settingsOf } from "./store";

/**
 * ── WHY THIS FILE EXISTS, AND IT IS THE FINDING OF THIS POC ─────────────────────
 *
 * A Next.js application with a custom server is TWO MODULE GRAPHS in one process.
 * `server.ts` is compiled by `tsc` and loaded by node; `src/app/**` is compiled and
 * loaded by Next. Import the same file from both and you get two evaluations of it,
 * so two bridges, two AsyncLocalStorage instances and two connection pools - which
 * fails in the least readable way possible: the server resolves a session into ITS
 * store, the page reads ITS OWN, finds nothing, and every reader is signed out on a
 * request that was perfectly authenticated. Nothing logs anything.
 *
 * In development it is worse: Next re-evaluates modules on every edit, so the count
 * grows with the number of saves.
 *
 * So there is ONE instance, pinned on `globalThis`, which is the one thing both
 * graphs genuinely share. It is the same reason a Prisma client is pinned there in
 * every Next application that has one, and it is not a workaround: two graphs is
 * what the framework IS.
 */
declare global {
  // eslint-disable-next-line no-var
  var __xcoreRuntime__: XcoreRuntime | undefined;
}

/**
 * What one HTTP request carries, put there by the custom server and read by Server
 * Components and Server Actions.
 *
 * The RAW `req` and `res` travel, and that is deliberate. A Server Action can then
 * hand them to the library exactly as an Express handler would - `xcore.logout(req,
 * res)` writes its `Set-Cookie` on a real `ServerResponse` that has not been sent
 * yet. The alternative, adapting `next/headers`' `cookies()` into a `WebResponse`,
 * is possible and is about twenty lines, but it only works where Next allows a
 * cookie to be written: an Action or a Route Handler, never a Server Component. And
 * the session read ROTATES the token pair and re-seals the cookie, so doing it from
 * a component would break every session at the first rotation, a quarter of an hour
 * in, silently.
 */
export interface RequestScope {
  req: WebRequest;
  res: WebResponse;
  /** Resolved by the custom server before Next ever sees the request. */
  me: SsoMe | null;
}

interface XcoreRuntime {
  pool: Pool;
  bridge: XcoreBridge;
  requests: AsyncLocalStorage<RequestScope>;
}

const build = (): XcoreRuntime => {
  const pool = createPool();
  const settings = settingsOf(pool);
  const credentials = credentialsOf(pool);

  const bridge = createXcoreBridge({
    // ── WHICH DIRECTORY ANSWERS ─────────────────────────────────────────────
    //
    // `"sso"` in hard, and deliberately. This POC exists to run the real chain: the
    // real pairing, the real propagation and a revocation that genuinely arrives
    // over the socket. Those do not simulate credibly.
    //
    // At `"local"` the library does NOT step back: it stands in for x-core against
    // `di.accounts`. Real sessions, guards that enforce, and a session shaped
    // exactly as the provider answers one.
    mode: "sso",

    // The API of ONE x-core, WITH its port. THE PORT IS THE TRAP: the login window
    // lives on the same names without one and answers `204` to anything it does not
    // know, unsigned calls included, so an application pointed at it declares itself
    // "successfully" at every boot with nothing on the other side.
    provider: {
      baseUrl: "https://x-core.gestionpratique.ovh:13001",
      frontUrl: "https://x-sso.gestionpratique.ovh",
    },

    // ── THE ONE VALUE COPIED BY HAND ────────────────────────────────────────
    //
    // Minted on x-core's console under « Portails applicatifs », with the callback
    //
    //     https://sync-gp3.gestionpratique.ovh/api/auth/sso/callback
    //
    // The browser WALKS that address, so it is the public one - not a container name
    // and not the port on the loopback the reverse proxy forwards to.
    //
    // It stays here for the life of the application. What decides whether the
    // exchange happens is not its presence but the `INSTALLED` key of
    // `di.environment`: until that reads true the boot exchanges it, and once it does
    // the boot never looks at it again - and it opens nothing anyway, x-core having
    // deleted its row the moment it was spent.
    installToken: "F3ovisiVjsE5xIiezqOeqqdSZGbhMazU3Pb58_xkV90",

    session: {
      // No password and no name here: the first is minted at the first boot and kept
      // in `app_settings`, the second is derived from the identity by x-core.
      //
      // `secure: true` because this POC is meant to be published over HTTPS. It is
      // the WHOLE decision: the library writes the attribute from this value with
      // `setHeader` and never asks the request what protocol it arrived on.
      cookie: { secure: true, sameSite: "lax", maxAgeDays: 30 },
    },

    routes: { basePath: "/api/auth", afterLogin: "/", loginPath: "/login" },
    realtime: { path: "/_ws/realtime" },

    // OFF: `live` follows every account this process holds a session for and hands
    // what arrives to `di.onAccount` and `di.onSignedOut`. Neither is lent here, so
    // every one of those sockets would carry frames to nowhere - one against x-core
    // per signed-in reader. The realtime a reader sees is the ticket bridge, and it
    // is untouched by this.
    live: { enabled: false },

    di: {
      // THREE MOMENTS, and the store never crosses: "give me the current hash",
      // "store this one", "this identity is gone". The library names no method of
      // any credential package.
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

      // ONE function of `di.accounts`, and the only one that means anything in
      // `"sso"`: the projection. The four others read a directory this mode does not
      // have. What `seen` writes is a row to hang a foreign key on - a key cannot
      // cross two databases, and the account lives in x-core's.
      accounts: accountsOf(pool),

      // ── HOW THIS APPLICATION SAYS "REFUSED" ─────────────────────────────
      //
      // Lent here, where the NestJS POC used an exception filter instead, because
      // under Next the two kinds of caller are told apart by a header rather than by
      // an exception type - and this is the only place that sees it.
      //
      //   a Server Action  arrives as a POST carrying `next-action`, and its client
      //                    is a script. A `302` written into that is a response
      //                    nothing follows: the action appears to hang and the page
      //                    keeps its stale account. It gets a status.
      //   a navigation     is a browser, and a browser goes to the portal - the one
      //                    thing in this ecosystem that signs a human in.
      //
      // Nothing is recomputed here: the library decided WHETHER and WHY, and this
      // says HOW. A second opinion on the status would be a second table, and the
      // day the two disagree a misconfigured deployment starts telling readers to
      // sign in to an application that cannot sign anyone in.
      errors: (refusal, req, res) => {
        const isAction = Boolean(req.headers["next-action"]);

        if (refusal.redirectTo && !isAction) {
          res.statusCode = 302;
          res.setHeader("location", refusal.redirectTo);
          res.end();
          return;
        }

        res.statusCode = refusal.status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: refusal.message }));
      },
    },

    logger: console,
    timeoutMs: 10_000,
    // x-core may start after this POC does.
    retry: { attempts: 5, delayMs: 3_000 },
  });

  return { pool, bridge, requests: new AsyncLocalStorage<RequestScope>() };
};

const runtime = () => (globalThis.__xcoreRuntime__ ??= build());

export const xcore = () => runtime().bridge;
export const pool = () => runtime().pool;
export const requests = () => runtime().requests;
