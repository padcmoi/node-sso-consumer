import { createXcoreBridge } from '@gestionpratique/node-sso-consumer'

/**
 * The bridge, in `mode: "local"` - the one thing this POC exists to prove.
 *
 * There is NO PROVIDER here. Nothing is paired, nothing is declared, no broker is
 * opened and no socket is dialled, because there is nothing at the other end to do
 * any of it with. What is here instead is the directory below, and the library
 * answers "who is this" out of it.
 *
 * WHAT DOES NOT CHANGE is the point. The library holds a real session, sealed into
 * the same cookie with the same password it minted and stored, re-reads the account
 * on EVERY request, and the guards refuse exactly as they do against x-core. A page
 * reads `me.profile.city` and `can('read:note')` here and reads them the same way
 * in production. That is what makes `mode` a mode rather than a migration.
 *
 * Built once at module scope, under `server/utils/`, so Nitro auto-imports it and
 * every handler reaches the same instance.
 */
export const xcore = createXcoreBridge({
  // The whole subject of this POC. Nothing else in this file would change if it
  // said `"sso"` except the two lines below, which would then be real.
  mode: 'local',

  // ── REQUIRED, AND NEVER CALLED ──────────────────────────────────────────────
  //
  // `provider` and `di.hmac` are required by the type in both modes, and in this one
  // neither is ever reached: nothing signs, because there is nobody to sign to. The
  // address is still parsed at construction, so it has to be a real URL - which is
  // why this is an obviously fake one rather than an empty string.
  //
  // Worth writing down rather than working around: an application that only ever
  // stands in has to invent two values it does not have.
  provider: { baseUrl: 'https://provider.invalid:13001' },

  session: {
    // `secure: false` because this POC is published over plain HTTP on a port: a
    // Secure cookie is dropped by the browser there, and what one reads then is
    // "signed out" at every navigation with nothing in the logs.
    //
    // No password and no name: the first is minted at the first boot and kept in
    // `app_settings`, the second is `sso_local` - its own name, distinct from
    // `sso_<clientId>`, so a machine that runs this offline and then pairs it does
    // not open one cookie with the other's password.
    cookie: { secure: false, sameSite: 'lax', maxAgeDays: 30 },
  },

  // `loginPath` is read ONLY here, and it is what makes this mode usable: with no
  // portal to send anybody to, a reader without a session has to land on a page of
  // THIS application. The screen is the application's - a library cannot render one -
  // and it posts to `/api/auth/sso/sign-in`.
  routes: { basePath: '/api/auth', afterLogin: '/', loginPath: '/login' },

  di: {
    // Never called in this mode. Written as a refusal rather than as an empty
    // function, so that the day something DOES sign, it says so loudly instead of
    // signing with nothing and failing three files away as a `401`.
    hmac: {
      getCredential: () => {
        throw new Error('[poc] nothing signs in local mode: there is no provider to sign to')
      },
      setCredential: () => {
        throw new Error('[poc] nothing signs in local mode: there is no provider to sign to')
      },
    },

    // The shelf. Two keys are written here and no more: the password that seals the
    // cookie, and the name of the cookie. There is no pairing to bring nineteen
    // others back.
    environment: {
      load: () => settings.all(),
      save: (values) => settings.upsertAll(values),
    },

    // ── THE DIRECTORY, AND THE WHOLE OF WHAT THIS MODE NEEDS ──────────────────
    //
    // A LIST, and nothing more. No sign-in function to write, no password comparison
    // and no form handling: the login is the library's work, exactly as it is in
    // `"sso"`. What is lent is the DIRECTORY, never the procedure - which is what
    // stops a second, hand-written login drifting away from the real one.
    //
    // The passwords are HASHED, scrypt, produced by the library's own `hashPassword`
    // and never written by hand:
    //
    //   import { hashPassword } from '@gestionpratique/node-sso-consumer'
    //   console.log(await hashPassword('julien'))
    //
    // The parameters travel inside the hash, so a record written today stays
    // verifiable after they are raised.
    //
    // What is written is thin, and the library fills the rest out to the exact shape
    // `/sso/me` answers: `id` derived from the email so a cookie survives a restart,
    // `displayName` composed as `PRÉNOM NOM`, `profile` complete with its nulls,
    // permissions namespaced, and the `_sso_user_<email>` group.
    local_accounts: [
      {
        email: 'julien@example.test',
        // hashPassword('julien')
        passwordHash: 'scrypt$16384$8$1$y7JJNN14RY1ZHqSnn7c62Q$2eB9l5nxA8sovoichyC1Ay1AUqzVaEXxRb3aHdn012o',
        firstName: 'Julien',
        lastName: 'Example',
        // Namespaced or not: `read:note` becomes `<app>:read:note`, and a value that
        // already carries its prefix is left alone.
        permissions: ['read:note'],
      },
      {
        email: 'admin@example.test',
        // hashPassword('admin')
        passwordHash: 'scrypt$16384$8$1$yFRnQa8sB1nGvGe3fKpfiw$A-S-gEgk_y7TIamVQku_hubcTH4KlYz2wLicuzbXDAU',
        firstName: 'Admin',
        lastName: 'Example',
        // Empty, and `isRoot` instead: x-core answers `isRoot: true` for an account
        // that passes everything, and `can()` reads it before looking at the list.
        // Reproducing it here is what makes a screen tested as root behave the same
        // way in production.
        permissions: [],
        isRoot: true,
      },
    ],

    // HOW this application says "refused". The library decides WHETHER and WHY and
    // calls this with the refusal already settled.
    //
    // With no portal, `redirectTo` is `routes.loginPath` - this application's own
    // screen - and it has to be WRITTEN on the response rather than thrown: a thrown
    // 302 carries a body and no `Location`, and the browser sits where it is.
    errors: (refusal, _req, res) => {
      if (refusal.redirectTo) {
        res.statusCode = 302
        res.setHeader('location', refusal.redirectTo)
        res.end()
        return
      }
      throw createError({ statusCode: refusal.status, statusMessage: refusal.message })
    },
  },

  logger: console,
})
