# @gestionpratique/node-sso-consumer

What a Node application needs to **be** a consumer of the x-core SSO, rather than to build one.

It installs itself from a pairing code, declares itself at every boot, holds the reader's session, reads their rights and follows the account over a socket. No login page, no copy of anybody's personal data, no permission stored anywhere.

Framework-agnostic: everything runs on the raw Node `IncomingMessage` / `ServerResponse`, so the same code serves Express, NestJS (Express or Fastify), Nitro/Nuxt and anything else that hands over what Node hands over.

> ## This library only works with x-core
>
> It is **proprietary to x-core**, not a general SSO client. It speaks x-core's routes, x-core's HMAC scheme, x-core's `resource:action` catalogue and x-core's realtime protocol - and there is no other implementation of any of them. There is no `client_id`/`client_secret` pair here, no discovery document, no JWKS, no OIDC: the HMAC clientId **is** the SSO identity. Pointed at an OAuth2 or OIDC provider it does not degrade, it simply has nothing to talk to.
>
> It also needs an x-core recent enough to serve `POST /api/v1/portal/install`. See [Installing an application](./docs/install.md).

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

## One switch, and one address

Two keys carry the whole of what an application decides about this library, and they
are the first two of the object.

```ts
enabled: NODE_ENV == "production" ? true : false,
provider: { baseUrl: "https://x-core.gestionpratique.ovh:13001" },
```

### `enabled` - x-core answers, or this library stands in for it

At `false` there is no pairing, no declaration and no socket - and **the library still
authenticates**, against the directory the application lends it under
`di.local_accounts`. It does not stand aside: the guards hold, `requirePermissions`
still refuses a right that is missing, and the session it hands back has exactly the
shape x-core answers, `permissions.portail` included and empty.

There are two states and no third:

| `enabled` | `di.local_accounts` | What happens                                                     |
| --------- | ------------------- | ---------------------------------------------------------------- |
| `true`    | ignored             | x-core decides. Unreachable or unpaired: every door shuts, `500` |
| `false`   | lent                | this library decides, against that list, at `routes.loginPath`   |
| `false`   | nothing             | nobody can ever sign in, so **every door shuts**                 |

The last row is the one that used to stand aside, and standing aside is exactly what a
guard must never do: an application nobody had configured served every protected page
to whoever asked, painted around no account, at the one moment nothing could tell one
reader from another.

What is lent is a **directory, never a procedure** - a list of accounts, and no sign-in
function to write. Comparing, sealing the cookie and holding the session are this
library's work in both states, which is what makes the switch honest: a screen built
offline reads `me.profile.city` and `can("read:user")` exactly as it will in
production. The application still draws the sign-in SCREEN, because a library cannot
render its page, and it posts to `<basePath>/sso/sign-in`.

**It is not a "dev mode", it is a switch**, and the application computes it. The line
above turns it on in production and off elsewhere because that is the common case: a
screen being built without the ecosystem behind it, without a token to mint and
without a broker account. Nothing forces that line - a development machine that wants
the real chain, real pairing, real propagation and a revocation that genuinely
arrives over the socket, writes `enabled: true` and never looks at it again. Those
things do not simulate credibly.

**Passed, not read.** Nothing in here touches `process.env`, and reading it from in
here would not even be reliable: a bundler - Nitro, Vite, esbuild - replaces
`process.env.NODE_ENV` with a constant at build time, so the bundled code carries
what was true on the machine that built the image rather than what is true at boot.
The line above sits in the application's own build, which knows.

Off by mistake in production it does not fall over: it leaves a production offering
the accounts written in its own source to the internet, or refusing everybody if none
were lent. That is why it is the first key of the object.

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

| `status`       | What it means                                                        |
| -------------- | -------------------------------------------------------------------- |
| `withdrawn`    | `enabled: false`. Nothing was asked of anybody, and nothing is wrong |
| `ready`        | paired and declared: the SSO is serving                              |
| `not-paired`   | no install token, or one the provider refused - in its own words     |
| `not-declared` | the provider was not told how this application plugs in              |

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
  // At `false` this library authenticates against `di.local_accounts` instead.
  enabled: NODE_ENV == "production" ? true : false,
  // ONE x-core, WITH its port: the login window lives on the same names without one
  // and answers 204 to anything, so a mistake here fails silently - which is why the
  // boot probes the address before declaring anything to it.
  provider: { baseUrl: "https://x-core.example.com:13001" },
  // The ONE value copied by hand, from the screen that mints it. It stays here for
  // the life of the application: what decides whether the pairing happens is the
  // `INSTALLED` key, not the presence of this token.
  installToken: "ycsvtsa_87jk7RFVv0lYDPnUH1CwDcSD-PmvPHyVP2o",
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

## The five routes

`xcore.middleware.routes()` carries them and passes through for anything else, so mounting is a single `use`:

| Route                         | What it does                                     |
| ----------------------------- | ------------------------------------------------ |
| `GET  <base>/sso/start`       | where the portal's card points                   |
| `GET  <base>/sso/callback`    | the code comes back, sealed into a session       |
| `POST <base>/logout`          | closes THIS application's session, not the SSO's |
| `GET  <base>/session`         | the account, its details, its rights             |
| `POST <base>/realtime-ticket` | what the page dials the socket with              |

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

- [Installing an application](./docs/install.md) - the pairing code, and what x-core does with it
- [Express](./docs/express.md)
- [NestJS](./docs/nestjs.md)
- [Nuxt 4 / Nitro server API](./docs/nitro.md)
- [Running several processes](./docs/multi-process.md)

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

## Notes

- Nothing here reads `process.env`, opens a store or holds a secret. Read env in the service layer and pass plain config - `enabled` included, which is why it is a key of the configuration rather than something this library looks up.
- The HMAC runtime is injected whole: this library signs with it and owns no credential of its own.
- One address is configured, `provider.baseUrl`, and the other three are derived from it. It is required because it is the one whose mistake is silent, which is why the boot probes it before declaring anything to it.
- The session cookie is sealed AES-256-GCM. The token pair IS the session: no local refresh chain. Changing `session.password` signs everyone out.
- `dependGlobalRessource` is an array and is sent whether it is empty or not. It records what an application declared at pairing; it is NOT what the door is judged on - `permissions.portail` is, and it arrives with every `me` so a requirement changed on the console applies without re-pairing.
- The browser half polls nothing, and the server half caches nothing. Every read asks the provider; the socket says what moved.
- One process holds its realtime tickets in memory and pairs on its own. Several need a shared `realtime.tickets` store, and an election OUTSIDE this library: every worker calls `load()`, the elected one calls `start()` - see [Running several processes](./docs/multi-process.md).
