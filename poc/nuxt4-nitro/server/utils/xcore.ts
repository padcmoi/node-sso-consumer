import { createXcoreBridge } from '@gestionpratique/node-sso-consumer'

/**
 * What this POC DECIDES, and what it LENDS. Nothing else.
 *
 * What it IS towards x-core - identity, callback URL, cancel URL, template, gate -
 * is not here: it is entered on x-core's console at the "L'application" step of the
 * form that mints the install token, and the pairing brings it back. There is one
 * place that decides it, and this file is not it.
 *
 * Nothing comes from a `.env` either, not even the password that seals the cookie:
 * it is minted at the first boot and kept in `app_settings`.
 *
 * Built once at module scope, under `server/utils/`, so Nitro auto-imports it and
 * every handler reaches the SAME instance. Several would each open their own sockets
 * for the same accounts.
 */
export const xcore = createXcoreBridge({
  // ── WHICH DIRECTORY ANSWERS ─────────────────────────────────────────────────
  //
  // `"sso"` in hard, and deliberately. The usual line is
  // `NODE_ENV === "production" ? "sso" : "local"`, which reads the local directory
  // wherever the ecosystem is not up - and this POC exists for exactly the opposite
  // reason: to run the real chain, the real pairing, the real propagation and a
  // revocation that genuinely arrives over the socket. Those do not simulate
  // credibly.
  //
  // At `"local"` the library does NOT step back: it stands in for x-core against
  // `di.local_accounts` below. Real sessions, guards that enforce, and a session
  // shaped exactly as the provider answers one - only the answer to "who is this"
  // comes from a list in this file instead of from over there.
  mode: 'sso',

  // ── WHERE IT CALLS ──────────────────────────────────────────────────────────
  //
  // The API of ONE x-core, WITH its port, and the only address written here: the
  // other three are derived from it - the login window is this host without the
  // port, the socket is one port further, and the portal comes back with the
  // pairing.
  //
  // THE PORT IS THE TRAP. The login window lives on the same names without one and
  // answers `204 No Content` to anything it does not know, unsigned calls included,
  // so an application pointed at it declares itself "successfully" at every boot with
  // nothing on the other side. `start()` proves the address first: an unsigned call
  // that is not refused with a `401` means nothing is declared.
  //
  // IT GOES WITH THE TOKEN BELOW. A token is a row in THIS x-core's database, with
  // its queue, its broker account and its credential behind it.
  // `frontUrl` is STATED, and it is a BELT. The login window is a different host
  // from the API - `x-sso` where the API is `x-core` - and a library guessing "the
  // same name without the port" builds an address that does not exist. What that
  // produces is a `502` from a reverse proxy at the instant a reader clicks the
  // portal card, on an application that paired, declared and signs perfectly.
  //
  // x-core answers it in the handover now, and the stored value wins over this one,
  // so this line is what covers the window before that reaches every deployment.
  // Delete it once it has, and the token is the only value copied by hand again.
  provider: {
    baseUrl: 'https://x-core.gestionpratique.ovh:13001',
    frontUrl: 'https://x-sso.gestionpratique.ovh',
  },

  // ── THE ONE VALUE COPIED BY HAND ────────────────────────────────────────────
  //
  // Minted on x-core's console under « Portails applicatifs », and it stays here for
  // the life of the application. What decides whether the exchange happens is not
  // its presence but the `INSTALLED` key of `di.environment`: until that reads true
  // the boot exchanges it, and once it does the boot never looks at it again. So
  // there is no `install()` to remember to call, and nothing to remove afterwards.
  //
  // Until a VALID one is put here this POC boots, says so in one line, and serves
  // nothing behind the SSO - which is the state the log calls `not-paired`.
  installToken: 'MN2uEqQHJWS_SRinI3wOA7qhvUd5ygwa_R5rX9Zf7kc',

  session: {
    // No password and no name here: the first is minted at the first boot and kept
    // in `app_settings`, the second is derived from the identity by x-core. What is
    // left is the shape of the cookie.
    //
    // `secure: false` because this POC is published over plain HTTP on a port: a
    // Secure cookie is dropped by the browser there, and what one reads then is
    // "signed out" at every navigation with nothing in the logs.
    cookie: { secure: false, sameSite: 'lax', maxAgeDays: 30 },
  },

  // `loginPath` is read only while standing in: in `"sso"`, the portal is
  // the one place anybody signs in and this library never sends a browser to a page
  // of its own. Standing in there is no portal, so a reader with no session goes to
  // THIS application's screen - which posts to `/api/auth/sso/sign-in`.
  routes: { basePath: '/api/auth', afterLogin: '/', loginPath: '/login' },
  realtime: { path: '/_ws/realtime' },

  // Follow every account this POC holds a session for: a permission granted or
  // revoked anywhere lands here within seconds instead of at the next navigation.
  live: { enabled: true, staleAfterMs: 5 * 60 * 1000 },

  // ── EVERYTHING THAT IS INJECTED, AND NOTHING ELSE ───────────────────────────
  //
  // It is short, and that is the main fact about this library: it persists NOTHING.
  // No table of its own, no migration, no schema. The two tables below belong to
  // this application - one is its settings shelf, the other its credential store -
  // and neither holds a session, an account or a permission. The session is a sealed
  // cookie at the reader's end, and the account is asked of x-core on every request.
  di: {
    // TWO FUNCTIONS, and the store never crosses. The library names no method of
    // any credential package: it knows two moments - "give me the current hash",
    // "store this one" - and these two lines know how. The day the store changes,
    // what breaks is here, in this file.
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

    // ── L'ANNUAIRE LOCAL, LU SEULEMENT À `mode: 'local'` ─────────────────────
    //
    // A LIST, and nothing more. No sign-in function, no password comparison, no
    // form: the login is the library's work, exactly as it is in `"sso"`.
    // What is lent here is the DIRECTORY, never the procedure.
    //
    // What is written is thin. The library fills the rest out to the exact shape
    // x-core answers - `id` derived from the email so a cookie survives a restart,
    // `displayName` composed, `profile` complete with its nulls, permissions
    // namespaced, `isRoot`, and the `_sso_user_<email>` group. A screen reading
    // `me.profile.city` renders here and renders there.
    //
    // The password is HASHED, scrypt, and produced by the library's own
    // `hashPassword` - never written by hand. The hash below is `aaa`, which is what
    // this POC signs in with.
    //
    // Written out as a literal rather than computed at boot, and that is the point
    // of the format: the same string is what a row of a table will hold once the
    // directory moves out of this file, so nothing about the comparison changes when
    // it does.
    local_accounts: [
      {
        email: 'test@abc.fr',
        passwordHash: 'scrypt$16384$8$1$nKsZZsMHOMV934vPWFDjUA$bhPInhcyXB4-pP3uRphbQgHLs2kJ-oSf_cY0zDW6P8k',
        firstName: 'Juoien',
        lastName: 'Julien',
        permissions: ['read:user', 'write:user'],
      },
    ],

    // HOW this application says "refused" - ALL of it, in one function.
    //
    // The library decides WHETHER and WHY: it is the only thing that talks to
    // x-core, so it is the only thing that can. It then calls this from inside that
    // decision, handing over the refusal already settled along with the raw request
    // and response. Nothing is recomputed here - a second opinion on the status
    // would be a second table, and the day the two disagree a misconfigured
    // deployment starts telling readers to sign in to an application that cannot
    // sign anyone in.
    //
    // Every kind is answered HERE, which is the point of lending a function at all:
    //
    //   a portal to go to  a real `302`, written on the response. Thrown instead it
    //                      would carry a body and no `Location`, and the browser
    //                      would sit where it is on a page with no account.
    //   anything else      thrown, because that is how Nitro stops a handler.
    //                      `500` never paired, `401` nobody identified, `403`
    //                      identified and lacking the right.
    errors: (refusal, _req, res) => {
      if (refusal.redirectTo) {
        // `setHeader` and `statusCode`, not `writeHead`: the library hands over its
        // own minimal response shape - what every Node framework agrees on - and
        // `writeHead` is not part of it.
        res.statusCode = 302
        res.setHeader('location', refusal.redirectTo)
        res.end()
        return
      }
      throw createError({ statusCode: refusal.status, statusMessage: refusal.message })
    },
  },

  logger: console,
  timeoutMs: 10_000,
  // x-core may start after this POC does. Five attempts three seconds apart cover a
  // `docker compose up` where the two go up together.
  retry: { attempts: 5, delayMs: 3_000 },
})
