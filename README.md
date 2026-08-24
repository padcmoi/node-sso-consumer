# @gestionpratique/node-sso-consumer

What a Node application needs to **be** a consumer of the x-core SSO, rather than to build one.

It installs itself from a pairing code, declares itself at every boot, holds the reader's session, reads their rights and follows the account over a socket. No login page, no copy of anybody's personal data, no permission stored anywhere.

Framework-agnostic: everything runs on the raw Node `IncomingMessage` / `ServerResponse`, so the same code serves Express, NestJS (Express or Fastify), Nitro/Nuxt and anything else that hands over what Node hands over.

> ## This library only works with x-core
>
> It is **proprietary to x-core**, not a general SSO client. It speaks x-core's routes, x-core's HMAC scheme, x-core's `resource:action` catalogue and x-core's realtime protocol - and there is no other implementation of any of them. There is no `client_id`/`client_secret` pair here, no discovery document, no JWKS, no OIDC: the HMAC clientId **is** the SSO identity. Pointed at an OAuth2 or OIDC provider it does not degrade, it simply has nothing to talk to.
>
> It also needs an x-core recent enough to serve `POST /api/v1/portal/install`. See [Installing an application](./docs/guides/en/install.md).

## It replaces the whole local authentication

Not part of it. An application using this library holds **no user table, no password
column, no reset flow, no session table, no permission table and no login page**. It
does not sign anyone in - the portal does - and there is nothing here to sign in
against.

| What an application used to hold | Where it lives now                                          |
| -------------------------------- | ----------------------------------------------------------- |
| a users table                    | x-core. `GET /sso/me` answers the account on every request  |
| passwords, hashes, resets        | x-core. This library never sees one                         |
| a login page and its form        | the portal. This application only offers `<base>/sso/start` |
| a sessions table                 | a sealed cookie at the reader's end, AES-256-GCM            |
| roles and permissions            | x-core, recomputed per account and answered with every `me` |
| a "remember me" / refresh chain  | the token pair inside that cookie, rotated by x-core        |

Two consequences worth stating out loud.

**Nothing is cached, ever.** The account, the profile and the rights are asked of
x-core on EVERY request. That is what makes a sign-out elsewhere, an account disabled
or an access revoked land on the very next call - with nothing to invalidate here and
no webhook to expose. A local session table cannot do that: it would still be valid.

**Nothing personal is stored.** The cookie carries the account id and the token pair,
and that is all. No email, no name, no address, no permission - not in a column, not
in a cache, not in a persisted front store.

What this library does NOT do: decide anything about the application's own data. The
gate it declares says who may come in at all; who may touch which invoice is the
application's business, and always was.

## One mode, and one address

Two keys carry the whole of what an application decides about this library, and they
are the first two of the object.

```ts
mode: NODE_ENV === "production" ? "sso" : "local",
provider: { baseUrl: "https://x-core.example.test:13001" },
```

### `mode` - x-core answers, or this library stands in for it

At `"local"` there is no pairing, no declaration and no socket - and **the library
still authenticates**, against the directory the application lends it under
`di.accounts`. It does not stand aside: the guards hold, `requirePermissions`
still refuses a right that is missing, and the session it hands back has exactly the
shape x-core answers, `permissions.portail` included and empty.

There are two states and no third:

| `mode`    | `di.accounts` | What happens                                                     |
| --------- | ------------- | ---------------------------------------------------------------- |
| `"sso"`   | ignored       | x-core decides. Unreachable or unpaired: every door shuts, `500` |
| `"local"` | lent          | this library decides, against that list, at `routes.loginPath`   |
| `"local"` | nothing       | nobody can ever sign in, so **every door shuts**                 |

The last row is the one that used to stand aside, and standing aside is exactly what a
guard must never do: an application nobody had configured served every protected page
to whoever asked, painted around no account, at the one moment nothing could tell one
reader from another.

What is lent is **access to a directory, never a procedure** - four functions over
whatever the application keeps its accounts in:

```ts
di.accounts = {
  // "local" only - reading and writing the directory
  findByEmail(email), // the sign-in read
  findById(id),       // the per-request read, from the id inside the cookie
  create?(record),    // receives a record this library has already hashed
  update?(id, patch),

  // BOTH modes - the projection
  seen?(account),     // a reader was just seen: write their row, or refresh it
};
```

Everything in it is optional, which is not laxity: the first four belong to
`"local"`, and `seen` belongs to both. An application on x-core that wants a foreign
key target lends `seen` alone rather than writing two lookups it will never call.
What `"local"` needs is checked where it is used - without `findByEmail` and
`findById` the library is not standing in, and every door shuts.

Comparing, hashing, sealing the cookie and holding the session are this library's work
in both modes, which is what makes the mode honest: a screen built offline reads
`me.profile.city` and `can("read:user")` exactly as it will in production. The
application still draws the sign-in SCREEN, because a library cannot render its page,
and it posts to `<basePath>/sso/sign-in`.

**The password never crosses that line.** `xcore.accounts.signUp({ ..., password })`
hashes with scrypt and hands `create` a `passwordHash`; `xcore.accounts.update(id, {
password })` does the same. An application that produced the hash itself would have to
reproduce the format and the parameters, and the day one of the two moves nothing
fails loudly - every password is simply wrong at once.

It used to be an ARRAY of accounts, and that was its ceiling: a directory written as a
literal cannot be added to without a deploy, and a hash typed into a source file is no
better protected than the clear password it replaced.

**It names a directory, not a level of service**, and the application computes it. The
line above reads the local one wherever the ecosystem is not up, because that is the
common case: a screen being built without a token to mint and without a broker
account. Nothing forces that line - a development machine that wants the real chain,
real pairing, real propagation and a revocation that genuinely arrives over the
socket, writes `mode: "sso"` and never looks at it again. Those things do not simulate
credibly.

It used to be a boolean called `enabled`, and the word was wrong: `false` never turned
anything off, it named the other directory. It is also required now, where `enabled`
read an absent key as `true` - so a typo in the key name silently chose x-core.

**Passed, not read.** Nothing in here touches `process.env`, and reading it from in
here would not even be reliable: a bundler - Nitro, Vite, esbuild - replaces
`process.env.NODE_ENV` with a constant at build time, so the bundled code carries
what was true on the machine that built the image rather than what is true at boot.
The line above sits in the application's own build, which knows.

Left on `"local"` by mistake in production it does not fall over: it leaves a
production offering the accounts written in its own source to the internet, or
refusing everybody if none were lent. That is why it is the first key of the object.

### `provider` - one x-core, one address

`baseUrl` is the API **with its port**, and it is the only address an application
writes itself. It cannot be otherwise: everything else comes back from the pairing,
but one does not learn where to reach the provider from the provider.

The other three are derived from it, and each derivation is a fact of the protocol:

| Address          | Where it comes from                                   |
| ---------------- | ----------------------------------------------------- |
| the API          | `provider.baseUrl`, written by the application        |
| the login window | the same host **without** the port                    |
| the socket       | the same host, **one port further**, path `/realtime` |
| the portal       | answered by the pairing, under `SSO_PORTAL_URL`       |

**The port is the trap.** The API and the login window differ by exactly that, and
the login window answers `204 No Content` to anything it does not know, unsigned
calls included. An application pointed at it declares itself "successfully" at every
boot, writes its own success into its logs, and nothing exists on the other side. So
`start()` proves the address first: an unsigned call that is not refused with a `401`
means nothing is declared.

A deployment laid out differently names `frontUrl`, `realtimeUrl` or `portalUrl`
beside `baseUrl`, and naming one changes nothing about the others.

`installToken` goes with `provider`, and the two are a couple: a token is a row in
**that** x-core's database, with its queue, its broker account and its credential
behind it. Presented to another it finds nothing.

### `start()` never throws

Every outcome comes back as a value and is said in one loud line in the log:

| `status`       | What it means                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `ready`        | serving: either paired and declared, or standing in against `di.accounts`                           |
| `not-paired`   | no install token, one the provider refused - in its own words - or the switch off with nothing lent |
| `not-declared` | the provider was not told how this application plugs in                                             |

`XcoreStartResult` also declares a `withdrawn` status and **nothing returns it**: at `mode: "local"` with a directory lent the answer is `ready`, and with nothing lent it is `not-paired`. Branch on `ok`, never on that value.

A boot that died because a token was spent, because the broker was not up yet or
because the provider was still starting would take the whole application with it -
including the pages that have nothing to do with the SSO, and including whatever an
operator would use to look at the problem. What is wanted instead is an application
that stands up, says what is not working, and is repaired by a value in a
configuration rather than by a container that will not stay alive.

Until it is paired, on an application that says it uses the SSO, **every door shuts**.
There is no cookie name to read, no sealing password and nothing to sign as, so nothing
can be learned about a reader - and what cannot be identified cannot be served. It used
to stand aside on the reasoning that refusing a reader for a fault that is not theirs is
unfair; standing aside served every protected page to whoever asked, on a deployment
nobody had configured, which is the application with its lock removed.

## Install

```bash
npm i @gestionpratique/node-sso-consumer
```

## Quick start

```ts
import { createXcoreBridge } from "@gestionpratique/node-sso-consumer";
// Built by the application, over its own Redis. It never enters this library.
import { hmacInstance } from "./hmac";

export const xcore = createXcoreBridge({
  // ON, OR WITHDRAWN, and only the application can say it: this library reads no
  // `process.env`, and a bundler would have frozen the value at build time anyway.
  // At `false` this library authenticates against `di.accounts` instead.
  mode: NODE_ENV === "production" ? "sso" : "local",
  // ONE x-core, WITH its port: the login window lives on the same names without one
  // and answers 204 to anything, so a mistake here fails silently - which is why the
  // boot probes the address before declaring anything to it.
  provider: { baseUrl: "https://x-core.example.com:13001" },
  // The ONE value copied by hand, from the screen that mints it. It stays here for
  // the life of the application: what decides whether the pairing happens is the
  // `INSTALLED` key, not the presence of this token.
  installToken: "EXAMPLE_ONLY_yTgc9Qm2LbVx7Kd0Rf3PnW8sHjA6ZuE4",
  routes: { basePath: "/api/auth", afterLogin: "/" },

  // Everything this application LENDS, in one key and nowhere else.
  di: {
    // TWO FUNCTIONS, and the HMAC instance never crosses. This library names no
    // method of `@naskot/node-hmac-auth-core`: it knows two moments - "give me the
    // current hash", "store this one" - and your code knows how. The day that
    // package renames a method, what breaks is this line, here.
    //
    // A HASH both ways. x-core keeps `hashClientSecret(secret, pepper)` and verifies
    // against that, and the pepper never travels: an application that hashed the raw
    // secret itself would sign with something else and collect a 401 on every call.
    // What signs is the hash x-core computed, and it arrives on the propagation queue
    // this library consumes for you.
    hmac: {
      getCredential: (clientId) => hmacInstance.clients.getSecretHash(clientId),
      setCredential: (clientId, secretHash) => hmacInstance.clients.setSecretHash(clientId, secretHash),
    },
    environment: {
      load: () => settings.all(),
      save: (values) => settings.upsertAll(values),
    },
  },
});

// Read the store, pair if `INSTALLED` is not true, then declare. Await it BEFORE
// serving: an application that failed to declare itself boots perfectly and refuses
// every sign-in afterwards.
await xcore.start();
```

There is no identity here, no callback URL, no gate and no session password. All of
it is entered on x-core's console when the pairing code is minted, brought back by
the pairing, and kept in the application's own store - so **nothing comes from a
`.env`**, and one place decides what this application is.

## `seen`, and why a foreign key needs it

An application's own rows belong to somebody. `invoices.owner`, `notes.owner` - and a
foreign key **cannot cross two databases**, while the account lives in x-core's. So the
application needs a local row to point at, and the only thing that knows when to write
one is whatever resolved the session.

```ts
seen({ id, origin, email, displayName, firstName, lastName, avatarUrl });
```

`id` is the foreign key target: x-core's UUID in `"sso"`, the local id in `"local"` -
one column holds both, which is what keeps `invoices.owner` pointing at the same place
when the mode changes. `origin` says which of the two it was, so nothing downstream has
to guess.

**The permissions are not passed, deliberately.** x-core recomputes them with every
`me`, so a copy in a table is a second truth that goes stale without saying so - and
the day somebody joins against it, a revoked right is still granted by a query.

**It fires once per account per process**, and again after a sign-out. That is the
whole reason it lives here rather than in an application's own guard: `sessionOf()`
hands the account back on every request, so wiring the write there would write on every
asset a page pulls. It is also **not awaited** - a projection that is slow or locked
must not turn a good session into a refused one - and a failure is logged and forgotten
so the next read tries again.

It is called AFTER the door, never before: a reader refused for this application has no
business being written into its table.

## The seven routes

`xcore.middleware.routes()` carries them and passes through for anything else, so mounting is a single `use`:

| Route                         | What it does                                      |
| ----------------------------- | ------------------------------------------------- |
| `GET  <base>/sso/start`       | where the portal's card points                    |
| `GET  <base>/sso/callback`    | the code comes back, sealed into a session        |
| `POST <base>/sso/sign-in`     | answers ONLY while standing in, `404` otherwise   |
| `POST <base>/sso/sign-up`     | creates then signs in. OFF unless `routes.signUp` |
| `POST <base>/logout`          | closes THIS application's session, not the SSO's  |
| `GET  <base>/session`         | the account, its details, its rights              |
| `POST <base>/realtime-ticket` | what the page dials the socket with               |

`sso/sign-up` is opt-in twice over: `mode: "local"`, and `routes.signUp: true`. Lending `di.accounts.create` is deliberately not enough - an application may lend it for an administration screen and want nothing open to the internet, and a route that appeared the moment `create` existed would be a public sign-up on a deployment whose author never read this line. It answers `201` with the account and the cookie, `409` on an address already taken, and `422` below eight characters of password.

`<base>` is `routes.basePath`, `/api/auth` by default - the path x-core's console composes into the callback it records, so an application that configures nothing answers where it was declared.

## The session

```ts
const me = await xcore.session(req, res); // null means signed out
```

```jsonc
{
  "user": { "id": "90dce9b0-…", "email": "…", "displayName": "…", "avatarUrl": "…", "hasPassword": false },
  "profile": { "gender": "mr", "lastname": "…", "firstname": "…", "city": "…", "locale": "fr-FR" },
  "permissions": {
    "global": ["core:access", "infrastructure:access"],
    "isRoot": false,
    "groups": [],
    // What THIS application requires before anybody may be in it. Empty admits
    // everybody. See "The door" below.
    "portail": ["infrastructure:access"],
  },
}
```

Behind `requireSession()`, read `req.me` instead: the middleware just resolved it, and asking again costs another round trip and another token rotation for the same answer.

`xcore.sessionOf(req, res)` returns `{ me, tokens, userId }` when the pair itself is needed.

## The guards

```ts
app.use("/api", xcore.middleware.requireSession());
app.get("/api/queues", xcore.middleware.requirePermissions("view-queues"), handler);
app.use(xcore.middleware.errors()); // last, after the routes
```

| Situation                                  | Answer                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| no cookie, or session closed at SSO        | `302` to the portal                                    |
| the session was ended from the portal      | `302` to the portal, within a second or two            |
| what this application requires is not held | `302` to the portal, on the next call                  |
| signed in without the action               | `403 {"error":"Missing infrastructure:delete-queues"}` |
| the provider is unreachable                | `503 {"error":"The identity provider is unavailable"}` |

A `403` is never a redirect to a sign-in: the account IS signed in, it simply does not hold the right, and sending it to sign in again loops without changing anything.

## The door

Being signed into the ecosystem is not being a user OF this application. What it requires arrives with every `me`, under `permissions.portail`, in the same `resource:action` vocabulary as `global` - so the whole check is one subset test:

```
global ⊇ portail   →   admitted
```

**An empty `portail` requires nothing and admits everybody**, which is the common case. Root passes without an exception anywhere: the provider answers it the whole catalogue in `global`.

What is required is never kept here. It is the console that decides it, per application, and the next `me` says so - so adding a requirement applies to a running deployment with nothing to re-pair and nothing to redeploy. An account that stops holding it is not an account short of a button: it is no longer a user of this application, so the session ends, the cookie is cleared and the reader goes back to the portal.

The provider enforces the same thing on its own side, on every path that opens or keeps a session alive. Both readings come from the same rows, so they cannot disagree.

## The rights

| Call                                                 | Returns                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `xcore.actions(req)`                                 | this application's actions the account holds, without the prefix |
| `xcore.can(req, action)` · `canAll(…)` · `canAny(…)` | a boolean, to hide a button the API would refuse anyway          |
| `xcore.assert(req, ...actions)`                      | nothing, or throws a `403` naming what is missing                |
| `xcore.permissions(req)`                             | the four raw keys: `global`, `isRoot`, `groups`, `portail`       |

Nothing is declared to obtain them: the catalogue belongs to the provider, which recomputes it for the account on every `me`. `can` hides, `assert` refuses - and the server decides, never the browser.

## Realtime

```ts
xcore.realtime.attach(server); // on the application's own HTTP server
```

A WebSocket is not bound by the same-origin policy and the provider wants two server-side credentials, so the page never dials it directly. It asks for a ticket over its authenticated session, dials `wss://<own host>/_ws/realtime?ticket=…`, and the bridge redeems it, signs the upstream handshake and sends the `auth` frame itself. An `auth` frame coming from the page is refused.

Three topics are followed for the whole session, and each answers a different question:

| topic           | says                                                             |
| --------------- | ---------------------------------------------------------------- |
| `me-changed`    | the account moved - a right granted or revoked, a profile edited |
| `me-signed-out` | the SSO session is gone, or this application's access was        |
| `me-sessions`   | the account's own sign-ins, one of which is this one             |

The third is what catches a session ended from the portal's sign-ins screen. `me-signed-out` cannot report that one: the provider computes it from the IdP session and the account's access, and ending one application's session moves neither. So the caller's own line is watched instead - the provider already marks it `current` - and when it goes, the session is over here.

Following an account SERVER-side pushes the same frames to `di.onAccount` and `di.onSignedOut`, for an application keeping a store of its own. **No guard reads from it.** Every read asks the provider, every time, because anything held is a session the provider may already have ended.

## The browser half

A page holds no SSO code either. `@gestionpratique/node-sso-consumer/client` reads the session, asks for a ticket, dials this host's socket, reconnects, and tells a session that is over from a connection that dropped.

**It polls nothing.** Three requests in its whole life: the session at startup, a ticket per socket, and a sign-out when somebody clicks. Everything after that arrives on the socket, which is what a socket is for.

```ts
import { createSsoClient } from "@gestionpratique/node-sso-consumer/client";

const sso = createSsoClient({
  basePath: "/api/auth",
  onAccount: (me) => render(me),
  onSignedOut: () => location.assign("https://portal.example.com/"),
});

const me = await sso.connect();
if (!me) location.assign("/api/auth/sso/start");
if (sso.can("infrastructure:delete-queues")) deleteButton.hidden = false;
```

`@gestionpratique/node-sso-consumer/express` is a third entry, imported once for its effect: it declares `req.me`, `req.ssoTokens` and `req.ssoUserId` on the framework's own request type.

## Integration guides

- [Installing an application](./docs/guides/en/install.md) - the pairing code, and what x-core does with it
- [The service file](./docs/guides/en/service.md) - every option, what the store holds, and what a real table looks like
- [Express](./docs/guides/en/express.md)
- [NestJS](./docs/guides/en/nestjs.md)
- [Nuxt 4 / Nitro server API](./docs/guides/en/nitro.md)
- [Running several processes](./docs/guides/en/multi-process.md)

## The protocol, specified

[docs/specs/](./docs/specs/en/README.md) is x-core's SSO written down independently of this library: the signed HTTP surface, the realtime gateway, the session model, the lifecycle, the permissions and the invariants. It is what this library implements, and what a reader consults when they need to know why something is the way it is rather than how to call it.

The sequence diagrams are in [docs/diagrams/](./docs/diagrams/), in English and French, whole and split into printable A4 sheets.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

## Notes

- Nothing here reads `process.env`, opens a store or holds a secret. Read env in the service layer and pass plain config - `mode` included, which is why it is a key of the configuration rather than something this library looks up.
- The HMAC runtime is injected whole: this library signs with it and owns no credential of its own.
- One address is configured, `provider.baseUrl`, and the other three are derived from it. It is required because it is the one whose mistake is silent, which is why the boot probes it before declaring anything to it.
- The session cookie is sealed AES-256-GCM. The token pair IS the session: no local refresh chain. Changing `session.password` signs everyone out.
- `dependGlobalRessource` is an array and is sent whether it is empty or not. It records what an application declared at pairing; it is NOT what the door is judged on - `permissions.portail` is, and it arrives with every `me` so a requirement changed on the console applies without re-pairing.
- The browser half polls nothing, and the server half caches nothing. Every read asks the provider; the socket says what moved.
- One process holds its realtime tickets in memory and pairs on its own. Several need a shared `realtime.tickets` store, and an election OUTSIDE this library: every worker calls `load()`, the elected one calls `start()` - see [Running several processes](./docs/guides/en/multi-process.md).
