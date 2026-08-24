# The service file

One call, one file. Everything this application is towards x-core, and everything it
lends the library, fits in `createXcoreBridge({ … })`. There is no second place:
nothing is re-read elsewhere and nothing is corrected afterwards by another file.

Two halves:

- **what the application decides** - the provider's address, where its routes mount,
  the shape of its cookie. Values, written in hard, not settings, and none of them
  comes from a `.env`;
- **what it lends**, under `di`, and nothing else is injection.

What the application **is** towards the provider is not here. Identity, callback URL,
cancel URL, template and gate are entered on x-core's console, at the "application"
step of the form that mints the install token, and the pairing brings them back. One
place decides it, and this file is not it.

**One value is copied by hand**, from the screen that mints the token, and it is
pasted here once for the life of the application:

```ts
installToken: "EXAMPLE_ONLY_yTgc9Qm2LbVx7Kd0Rf3PnW8sHjA6ZuE4",
```

A token belongs to the x-core that minted it, and that x-core's address is written
just above it. The two go together: a deployment that changes one changes the other,
and there is no state where one names a provider and the other names a second.

**There is no `install()` to call.** What decides whether the installation happens is
not the presence of the token but the `INSTALLED` key of `di.environment`: until it
reads true the boot exchanges the token, and once it does the boot never looks at it
again. The token is therefore never spent twice, there is nothing to remove from a
configuration afterwards - the gesture people forget - and nothing to remember to
call on the right boot.

**Nothing comes from a `.env`**, not even the password that seals the cookie. It
lives under `SSO_SESSION_PASSWORD` in `di.environment`, drawn at the first boot and
read back after. One environment variable fewer is one secret fewer to put on a
server, to carry through a redeployment, and to find again the day nobody remembers
where it was.

`di` is short, and that is the main fact about this library: **it persists nothing.**
No table, no migration, no schema - an application installing it creates none. The
session is a sealed cookie at the reader's end; the account and the rights are asked
of x-core on every request and never cached.

## The file

```ts
import { createXcoreBridge, type SsoLogger, type StandInAccount, type XcoreBridge } from "@gestionpratique/node-sso-consumer";

import { credentials } from "../hmac";
import { settings } from "../settings";
import { accountStore } from "../store";

export interface SsoDeps {
  logger?: SsoLogger;
}

/**
 * THE LOCAL DIRECTORY, read only when `mode` is `"local"`.
 *
 * In hard, in this file, and deliberately: these are the accounts a screen is built
 * with when the ecosystem is not up. They go nowhere and serve only here - with the
 * switch on this constant is never read.
 *
 * What is written is THIN. The library fills the rest out to the exact shape x-core
 * answers, so a component sees no difference:
 *
 *   `id`           derived from the email when absent, so it is stable from one boot
 *                  to the next - a cookie sealed yesterday opens tomorrow
 *   `displayName`  "FIRSTNAME LASTNAME", as x-core composes it
 *   `profile`      complete, with its `null` where nothing is known: `birthDate`,
 *                  `address`, `city`, `postalCode`, `phone1`. A screen reading
 *                  `me.profile.city` renders an empty string, it does not crash
 *   `permissions`  namespaced when they are not already, plus the `_sso_user_<email>`
 *                  group x-core creates for every account
 *
 * The password is in the clear and must be: nothing here claims to be secure, and
 * hashing it would suggest otherwise. What protects this list is that it does not
 * exist in production - `mode: "sso"` never looks at it.
 */
const LOCAL_ACCOUNTS = [
  {
    id: "julien",
    email: "julien@example.test",
    password: "julien",
    firstName: "Julien",
    lastName: "Example",
    // What this account holds. Namespaced or not: `read:user` becomes
    // `<app>:read:user`, and a value already carrying its prefix is left alone -
    // which is what lets you write `core:access` when you want to.
    permissions: ["read:user", "write:user"],
  },
  {
    id: "admin",
    email: "admin@example.test",
    password: "admin",
    firstName: "Admin",
    lastName: "Example",
    // Empty, and `isRoot` instead: x-core answers `isRoot: true` for an account that
    // passes everything, and `can()` reads it before looking at the list. Reproducing
    // it here is what makes a screen tested as root behave the same in production.
    permissions: [],
    isRoot: true,
  },
] satisfies StandInAccount[];

export const createXcore = ({ logger }: SsoDeps): XcoreBridge =>
  createXcoreBridge({
    // ── WHO DECIDES WHO IS THERE ─────────────────────────────────────────────
    //
    // At `true` it is x-core. The install token has to be valid and the provider
    // reachable: without that nothing behind a guard is served. Never paired is a
    // `500` - there is not even a portal address to send anybody to, since it
    // arrives WITH the pairing. Paired but refused, expired, or x-core unreachable
    // is a `401` and the portal.
    //
    // At `false` the SSO is off - AND THE LIBRARY STILL AUTHENTICATES, against the
    // accounts lent under `di.local_accounts`. It does not stand aside: the guards
    // hold, `requirePermissions` refuses a missing right, and the session that comes
    // out has EXACTLY the shape x-core answers - `user`, a complete `profile`,
    // namespaced `permissions.global`, `isRoot`, the groups, and an EMPTY
    // `permissions.portail`, because a requirement is what a PORTAL demands before
    // letting anybody in, and standing in there is no portal. Everybody enters.
    //
    // That is what makes the switch honest. A screen built offline reads
    // `me.profile.city` and `can('read:user')` exactly as it will in production, and
    // the day it is plugged in one line changes.
    //
    // IT IS NOT A "DEV MODE", it is a switch, and the application computes it. The
    // line below turns it on in production and off elsewhere because that is the
    // usual case. Nothing forces it: a development machine that wants the real chain
    // - real pairing, real propagation, a revocation that genuinely arrives over the
    // socket - writes `mode: "sso"` and never looks at it again.
    //
    // PASSED, NOT READ, and that is this library's rule rather than a detail: it
    // reads no `process.env`. A bundler replaces `process.env.NODE_ENV` with a
    // constant at build time, so a value read from inside a bundled library carries
    // what was true on the machine that built the image rather than what is true at
    // boot. This line sits in the application's own build, which knows.
    mode: process.env.NODE_ENV === "production" ? "sso" : "local",

    // ── WHERE IT CALLS ───────────────────────────────────────────────────────
    //
    // `baseUrl` is the provider's API WITH ITS PORT, and nothing else: the paths are
    // the library's and it composes them itself.
    //
    // It is the only address an application writes itself, and it cannot be
    // otherwise: everything else comes back from the pairing, but one does not learn
    // where to reach the provider from the provider.
    //
    // THE PORT IS THE TRAP. The login window lives on the same names without one and
    // answers `204 No Content` to anything it does not know, unsigned calls included
    // - so an application pointed at it declares itself "successfully" at every boot
    // and nothing exists on the other side. `start()` refuses that by proving the
    // address first.
    //
    // `frontUrl` is STATED rather than derived, and it is a belt. Derived, it is
    // "the same host without the port", which is right only where the login window
    // has no name of its own - and in production it usually has one. x-core answers
    // it at pairing under `SSO_FRONT_URL` and the stored value wins over this one,
    // so this line only covers the window before that reaches every deployment. A
    // wrong guess is a `502` at the instant a reader clicks, on an application that
    // paired, declared and signs perfectly.
    provider: {
      baseUrl: "https://x-core.example.test:13001",
      frontUrl: "https://x-sso.example.test",
    },

    // ── WHO THIS APPLICATION IS: NOT HERE ────────────────────────────────────
    //
    // No `clientId`, and that is the point. The SSO identity is decided ON THE
    // CONSOLE when the token is minted, and the installation brings it back. The
    // library stores it through `di.environment.save` with the rest and reads it
    // back through `load` at every later boot.
    //
    // Writing it in hard here would make a second source: two places deciding the
    // same name, and the day they diverge the application installs cleanly then
    // signs under a name that is not its own - which surfaces as a `401` on
    // everything, hours later, with nothing naming the cause.
    //
    // There is therefore no client_id / client_secret pair in this protocol: the
    // HMAC clientId IS the identity.
    //
    // Nor is there a `consumer` block. Identity, callback URL, cancel URL, template
    // and required resources are entered on the console. Rewriting them here would
    // be a second declaration of the same object - and since `declare()` sends them
    // back at every boot, the day the two diverged the application would win and
    // silently overwrite what an operator set.
    installToken: "EXAMPLE_ONLY_yTgc9Qm2LbVx7Kd0Rf3PnW8sHjA6ZuE4",

    // ── THE SESSION IT HOLDS ─────────────────────────────────────────────────
    //
    // No password and no cookie name here. The first is drawn at the first boot - 32
    // bytes, base64url - and stored under `SSO_SESSION_PASSWORD`; the second arrives
    // under `SSO_SESSION_COOKIE_NAME`, derived from the identity by x-core, so
    // `oauth-x-example` gives `sso_oauth_x_example`.
    //
    // An application does not choose the name, and that is what makes a collision
    // impossible by construction: two applications served under one host would
    // otherwise both write `sso_session` and sign each other out on every
    // navigation, silently, since from each one's point of view the cookie is simply
    // absent.
    session: {
      cookie: {
        // `false` ONLY where plain HTTP is served: a Secure cookie is dropped by the
        // browser there, and what that reads as is "signed out" at every navigation,
        // with nothing in the logs.
        secure: true,
        // `lax` and not `strict`: the cookie has to survive the redirect back from
        // the login window, which is a cross-site navigation.
        sameSite: "lax",
        // Browser hygiene, not a security mechanism. What actually expires a session
        // is the row on x-core's side: a cookie that outlives it opens nothing, since
        // the provider is asked on every request.
        maxAgeDays: 30,
      },
    },

    // ── WHERE ITS ROUTES MOUNT ───────────────────────────────────────────────
    //
    // `basePath` matters more than a default usually does: x-core's console COMPOSES
    // the callback it records as `<address>/api/auth/sso/callback`, with no field
    // offering anything else. An application that moves this is declared at one
    // address and listens at another.
    //
    // `loginPath` is read ONLY while standing in: with the switch on, the portal is
    // the one place anybody signs in and this library renders no login page.
    routes: {
      basePath: "/api/auth",
      afterLogin: "/",
      loginPath: "/login",
    },

    // ── THE REALTIME ─────────────────────────────────────────────────────────

    realtime: {
      // The path the BROWSER dials on this application's own host - not on the
      // provider. Matched exactly, so several bridges can share one HTTP server.
      path: "/_ws/realtime",

      // Where a 30 second ticket waits between the page asking for one and the
      // socket spending it. IN MEMORY BY DEFAULT, which is correct for ONE process
      // and a bug the day there are two: a ticket minted by one worker has to be
      // spendable by the other, and a dev server reloading between the mint and the
      // dial loses it too. Lend a Redis-backed store then - `put` and `take`, where
      // `take` reads AND removes in one move.
      //
      // tickets: redisTicketStore,
    },

    // ── FOLLOWING ACCOUNTS FROM THE SERVER SIDE ──────────────────────────────
    //
    // `live` opens ONE socket per account this process holds a session for, and
    // hands what arrives to `di.onAccount` and `di.onSignedOut`. A RELAY, and only a
    // relay: NO GUARD EVER READS FROM IT. Every read still asks the provider.
    //
    // Leave it OFF unless something here has to hear about it: a store of your own,
    // a cache the library knows nothing about, browsers you fan out to yourself.
    // With neither callback lent, every one of those sockets carries frames to
    // nowhere - one against x-core per signed-in reader, for nothing.
    live: { enabled: true },

    // ── EVERYTHING INJECTED, AND NOTHING ELSE ────────────────────────────────
    //
    // ONE key, ONE object, and everything is in it. It is short, and that is the
    // main fact about this library.
    //
    // What is in here is never a decision. It is a store, an access, a directory, a
    // way of speaking - the data or the door, never the choice.
    di: {
      // ── THE CREDENTIAL: TWO FUNCTIONS, AND THE INSTANCE STAYS OUTSIDE ─────
      //
      // The credential store does NOT enter the library. It lives here and is
      // captured by the closures below. The library never receives it, holds it or
      // names a method of it.
      //
      // That is what makes the dependency safe. It knows three moments - "give me
      // the current hash", "store this one", "this identity is gone" - and your code
      // knows how. The day the credential package renames a method, what breaks is
      // these three lines, in this file, fixed without waiting for a release here.
      //
      // A HASH, never a secret. The pairing answer does carry a secret in the clear,
      // and it is not what signs: x-core stores `hashClientSecret(secret, pepper)`
      // and verifies against that, the pepper is its own and never travels. An
      // application that hashed the raw secret itself would sign with something else
      // entirely and collect a `401 BAD_SIGNATURE` on every call while holding the
      // right secret. What works is the hash x-core computed, and it only ever
      // arrives on the propagation queue - which is why that queue is not a
      // convenience.
      hmac: {
        // READ ON EVERY SIGNED CALL and never captured: the credential is replaced
        // by propagation, and a client built once at boot would sign with the old
        // one until the next restart.
        getCredential: (clientId) => credentials.get(clientId),
        // Called on every rotation the queue carries.
        setCredential: (clientId, secretHash) => credentials.set(clientId, secretHash),
        // Optional. An application that never deletes anything simply leaves a dead
        // credential behind, which signs nothing because the far side refuses it.
        deleteCredential: (clientId) => credentials.remove(clientId),
      },

      // ── THIS APPLICATION'S OWN SHELF ─────────────────────────────────────
      //
      // Two functions over keys whose VALUES ARE JSON. Not strings: a gate is a
      // list, a port is a number, `INSTALLED` is a boolean, and flattening them into
      // text would make every reader responsible for unfolding them again - one more
      // unwritten convention that the first crooked `split(",")` breaks.
      //
      // The twenty keys are listed further down, with what a real table looks like.
      //
      // Stored wherever the application wants: a key/value table, a vault, a file.
      // The library does not know and does not have to.
      environment: {
        // EVERYTHING, in one read, and called before anything else. Four things come
        // out of it: `INSTALLED`, which decides whether the token is exchanged;
        // `SSO_SESSION_PASSWORD`, without which no cookie opens; `SSO_CLIENT_ID`,
        // without which the library does not know what to sign as; and the whole
        // declaration, which `declare()` sends back as it is.
        //
        // Not key by key: that would be twenty round trips at every boot for twenty
        // values that are read together, and one that failed would leave an
        // application half configured with nothing having said so.
        //
        // A key never written is ABSENT, not `null`. That is what tells "never set"
        // apart from "set to nothing" - an empty gate means this application filters
        // nothing, which is a declaration rather than an absence.
        load: () => settings.all(),

        // CREATE OR UPDATE each key given, and leave the others alone. An upsert,
        // not a replacement.
        //
        // Atomic over what it is given: the pairing hands everything over at once,
        // `INSTALLED` included, and that is what guarantees there is no instant
        // where the application believes itself paired without holding what that
        // announces.
        save: (values) => settings.upsertAll(values),
      },

      // ── THE DIRECTORY, WHEN IT IS NOT x-core ANSWERING ───────────────────
      //
      // Read ONLY at `mode: "local"`. With the switch on this key is never looked
      // at: who is there is x-core's answer and nothing else can give it.
      //
      // A LIST, and nothing more. No `signIn` to write, no password comparison, no
      // form: the login is the library's work, exactly as it is when the switch is
      // on. What an application lends is the DIRECTORY, never the procedure.
      //
      // A `signIn` lent instead would be two logins in the ecosystem, a real one and
      // one hand-written in each application, and the second always drifts.
      //
      // `local_accounts` and not `fakeAccounts`: these accounts really sign somebody
      // in, really hold a session and are really refused when a right is missing.
      // What changes is where they come from, not what they are worth.
      local_accounts: LOCAL_ACCOUNTS,

      // ── HOW THIS APPLICATION SAYS "REFUSED" ──────────────────────────────
      //
      // The library decides WHETHER and WHY - it is the only thing that talks to the
      // provider, so it is the only thing that can. It does not decide HOW, because
      // that belongs to the framework underneath: Nitro wants an `H3Error` thrown,
      // Nest wants an exception of its own, Express wants `next` with something on
      // it.
      //
      // Handed the raw request and response WITH the refusal, so one function can
      // answer every kind: `403` and `500` as a body, and the `401` that sends a
      // browser to the portal as a redirect.
      //
      // OPTIONAL. Lend nothing and the library writes the plain answer itself - a
      // redirect when there is a portal, JSON otherwise. It never leaves a request
      // hanging.
      // `WebResponse` is deliberately narrow - `statusCode`, `getHeader`,
      // `setHeader`, `end` - because that is the whole of what Node's own response
      // guarantees. No `writeHead`, no `res.json`, no `res.redirect`: those belong
      // to a framework, and this library runs under three of them.
      errors: (refusal, _req, res) => {
        if (refusal.redirectTo) {
          res.statusCode = 302;
          res.setHeader("location", refusal.redirectTo);
          res.end();
          return;
        }
        res.statusCode = refusal.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: refusal.message, code: refusal.code }));
      },

      // ── WHAT THE PROVIDER PUSHED ─────────────────────────────────────────
      //
      // For whatever this application keeps that the library cannot know about: its
      // own store, its own sockets, a cache of its own. The reads are already
      // reactive without this. Only called when `live.enabled` is true.
      onAccount: (userId, me) => accountStore.replace(userId, me),
      onSignedOut: (userId) => accountStore.clear(userId),
    },

    // ── THE REST ─────────────────────────────────────────────────────────────

    logger,
    timeoutMs: 10_000,
    // The provider may start after this application does. Five attempts three
    // seconds apart cover a `docker compose up` where the two go up together.
    retry: { attempts: 5, delayMs: 3_000 },
  });

export type Xcore = ReturnType<typeof createXcore>;
```

## Booting it, and shutting it down

`start()` **never throws.** Every outcome comes back as a value, because a boot that
died because a token was spent, because the broker was not up yet or because the
provider was still starting would take the whole application with it - including the
pages that have nothing to do with the SSO, and including whatever an operator would
use to look at the problem.

```ts
const xcore = createXcore({ logger: console });

const started = await xcore.start();
if (!started.ok) {
  // `withdrawn` | `ready` | `not-paired` | `not-declared`, and one sentence saying why.
  console.error(`[sso] not serving (${started.status}): ${started.reason}`);
}

// On shutdown. A process that exits without this leaves a consumer registered on the
// broker until its heartbeat times out, and the next boot finds two.
await xcore.close();
```

## What is injected, and nothing else

| Key                                  | Given                  | Returns                   | Called                                      |
| ------------------------------------ | ---------------------- | ------------------------- | ------------------------------------------- |
| `hmac.getCredential(clientId)`       | an identity            | the current hash          | before every signed call                    |
| `hmac.setCredential(clientId, hash)` | an identity and a hash | nothing                   | on every credential received                |
| `hmac.deleteCredential(clientId)`    | an identity            | nothing                   | optional, when the provider says it is gone |
| `environment.load()`                 | nothing                | `Record<string, unknown>` | at every boot, first                        |
| `environment.save(values)`           | the keys to write      | nothing                   | at pairing, and on every rotation           |
| `local_accounts`                     | a list                 | -                         | only at `mode: "local"`                     |
| `errors(refusal, req, res)`          | a decided refusal      | nothing, or throws        | optional, on every refusal                  |
| `onAccount(userId, me)`              | an account             | nothing                   | optional, when `live` pushes one            |
| `onSignedOut(userId)`                | an account id          | nothing                   | optional, when a session ends               |

## The store, as rows in a database

Twenty keys. Five come from what an operator typed on the console, four plus five
describe the broker, two are drawn locally, and one is the library's own bookkeeping.
**Nothing here is typed by hand into a `.env`**: the pairing brings it all back and
`save` puts it where the application keeps it.

The example below is a `app_sso_settings` table for a fictional application
`oauth-x-example`. The `type` column is not decoration: the library hands over
JavaScript values and takes them back, so a gate is an array, a port is a number and
`INSTALLED` is a boolean. Stored as one opaque blob that shape survives only as long
as whoever reads it remembers to parse, and the first reader who does not is a boot
comparing the string `"false"` to `false` and finding them different.

```sql
CREATE TABLE app_sso_settings (
  `key`        VARCHAR(191) NOT NULL PRIMARY KEY,
  `type`       ENUM('string','number','boolean','array','object','null') NOT NULL,
  `value`      TEXT NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);
```

A `string` is stored RAW rather than quoted, so the table stays readable to a human
with a SQL client. Everything else is JSON.

| `key`                         | `type`    | `value`                                                   | Where it comes from                                         |
| ----------------------------- | --------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| `INSTALLED`                   | `boolean` | `true`                                                    | written by the pairing, in the same transaction as the rest |
| `SSO_SESSION_PASSWORD`        | `string`  | `EXAMPLE_ONLY_4pQvR7nZ2xKmT9wLbJ0sHdE6yUcA3fG`            | drawn locally at the first boot, never received             |
| `SSO_CLIENT_ID`               | `string`  | `oauth-x-example`                                         | the console                                                 |
| `SSO_SESSION_COOKIE_NAME`     | `string`  | `sso_oauth_x_example`                                     | derived from the identity by x-core                         |
| `SSO_REDIRECT_URI`            | `string`  | `https://x-example.example.test/api/auth/sso/callback`    | the console                                                 |
| `SSO_CANCEL_URI`              | `string`  | `https://x-example.example.test/`                         | the console                                                 |
| `SSO_PORTAL_URL`              | `string`  | `https://portal.example.test/`                            | the console                                                 |
| `SSO_FRONT_URL`               | `string`  | `https://x-sso.example.test`                              | the console                                                 |
| `SSO_TEMPLATE`                | `string`  | `default`                                                 | the console                                                 |
| `SSO_DEPEND_GLOBAL_RESSOURCE` | `array`   | `["example"]`                                             | the console                                                 |
| `HMAC_AMQP_QUEUE`             | `string`  | `x-example-prod`                                          | the pairing                                                 |
| `HMAC_AMQP_BROKER_QUEUE`      | `string`  | `hmac-x-example-prod.queue`                               | the pairing                                                 |
| `HMAC_AMQP_VHOST`             | `string`  | `hmac-credentials`                                        | the pairing                                                 |
| `HMAC_PROPAGATION_SECRET`     | `string`  | `EXAMPLE_ONLY_8b41d0c7ae52f39d6410bc27ff85ea93`           | the pairing                                                 |
| `RABBITMQ_PROTOCOL`           | `string`  | `amqps`                                                   | the pairing                                                 |
| `RABBITMQ_HOST`               | `string`  | `x-amqp.example.test`                                     | the pairing                                                 |
| `RABBITMQ_PORT`               | `number`  | `5671`                                                    | the pairing                                                 |
| `RABBITMQ_USER`               | `string`  | `x_example_prod`                                          | the pairing                                                 |
| `RABBITMQ_PASSWORD`           | `string`  | `EXAMPLE_ONLY_Wq7ZvKm2TnRb9LdXsH0yJcE4`                   | the pairing, in the clear and once                          |
| `HMAC_PROPAGATION_CURSOR:…`   | `object`  | `{"ts":"1787555108907","eventId":"46b6af1b-f8f6-46e2-…"}` | the library, on every event applied                         |

> The values above are fabricated. Do not copy them: `SSO_SESSION_PASSWORD`,
> `HMAC_PROPAGATION_SECRET` and `RABBITMQ_PASSWORD` are secrets, and the first is
> drawn by the library itself rather than written by anybody.

Three of these are worth a sentence each.

**`SSO_SESSION_PASSWORD` is drawn here, never received.** Two applications sharing
one could open each other's cookies, while each holds its own revocable row on the
provider. Deleting the key is how an operator signs everybody out at once - every
existing cookie stops opening - and the next boot mints a new one. It is a tool, not
a fault.

**`SSO_DEPEND_GLOBAL_RESSOURCE` is an array whether it is empty or not.** An optional
field is only written when provided, so omitting it could set a gate and never clear
one. Its first entry is also what names the global ACL resource this application
**is**, which is how `actions()` knows what prefix to strip.

**`HMAC_PROPAGATION_CURSOR` is the only key x-core knows nothing about.** It is a
position rather than a setting, written by the library so a redelivered rotation is
applied once, and it carries a suffix naming the stream it tracks - which is why a
real table shows one row per propagation target rather than a single line.

## The installation, with no method to call

`INSTALLED` is what replaces `install(code)`. The boot reads `di.environment`, looks
at that key, and decides:

| `INSTALLED`        | What the boot does                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------- |
| absent, or `false` | exchanges `installToken`, stores everything with `INSTALLED: true`, opens the queue, declares |
| `true`             | does not even look at the token: opens the queue and declares                                 |

Two things follow, and they are the two that made the older shape fragile.

The token **stays in the configuration.** There is nothing to remove after the first
boot, therefore nothing to forget to remove. And since it is no longer read once
`INSTALLED` is true, a deployment that keeps it does not spend it a second time.

The state is **written**, not inferred. Asking "is this already installed?" used to
mean looking for a credential lying around in the store, which is indirect proof: a
credential that arrived by propagation, with no installation behind it, answered
"yes" to a question nobody had asked it.

`INSTALLED` is written in the **same `save`** as everything else and never before it.
Written first, a boot falling between the two would believe itself paired while
holding none of what that announces - and would never try again, since it no longer
looks at the token.

**Nothing is created by exchanging the token.** The queue, the broker account, the
SSO consumer and the HMAC credential were all built when it was MINTED, on the
console, in front of whoever minted it. The exchange collects them and x-core deletes
its row in the same breath. A boot either finds its reservation waiting or finds
nothing at all, and never half of it.

## The broker, and why it appears nowhere above

It appears nowhere **because this library holds it.** It takes
`@naskot/node-hmac-auth-core-propagation` as its own dependency, opens the
connection, consumes the queue and acknowledges. An application installing it writes
no AMQP and adds no second package to its `package.json`.

It is already the only side holding the nine values that connection needs -
`HMAC_AMQP_QUEUE`, `HMAC_PROPAGATION_SECRET`, `HMAC_AMQP_VHOST`,
`HMAC_AMQP_BROKER_QUEUE` and the five `RABBITMQ_*` - since the pairing brought them
back and `load` hands them over at every boot.

**No environment variable is added.** Not one: everything comes from the pairing, and
nothing about the broker is written into a configuration. The broker's address in
particular comes from there rather than from a constant somewhere, because it belongs
to the infrastructure and moves with it. An application holding a copy would keep
dialling the old one long after everybody had moved.

Every route consumed requires the signature, except one: the install exchange, which
is precisely what hands back the credential one would sign with.

Order follows from this: `load` is called **before** the first signed call, since it
is what yields the identity to sign as.
