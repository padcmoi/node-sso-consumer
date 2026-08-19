# @naskot/node-sso-consumer

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

## Two environments, and neither is a setting

`environment: "dev" | "prod"` picks a set of four addresses that are **written down in
the code**, not read from anywhere:

|              | dev                               | prod                               |
| ------------ | --------------------------------- | ---------------------------------- |
| the API      | `d-sso.gestionpratique.ovh:13001` | `x-core.gestionpratique.ovh:13001` |
| login window | `d-sso.gestionpratique.ovh`       | `x-sso.gestionpratique.ovh`        |
| the portal   | `d-portal.gestionpratique.ovh`    | `portail.gestionpratique.ovh`      |
| the socket   | `d-sso.gestionpratique.ovh:13002` | `x-core.gestionpratique.ovh:13002` |

They vary per **ecosystem**, not per deployment, which is why they are not
configuration. And the mistake they invite is the one that fails silently: the API and
the login window differ by a port, and the login window answers `204 No Content` to
anything it does not know. An application pointed at it declares itself
"successfully" at every boot, logs its own success, and nothing exists on the other
side. `provider` is required for exactly that reason - it is the one address an
integrator has to have looked at and typed, and `declare()` refuses a base that does
not reject an unsigned call with a `401`.

Naming `prod` while deploying to a dev machine is legitimate and reads as what it is:
one account list, one set of permissions, one place to grant them, shared across both
of an application's own environments.

An application on another ecosystem passes an object as `provider` and overrides all
four.

## Install

```bash
npm i @naskot/node-sso-consumer
```

## Quick start

```ts
import { signedHttpFetch, buildHttpSignedHeaders } from "@naskot/node-hmac-auth";
import { createXcoreBridge } from "@naskot/node-sso-consumer";

export const xcore = createXcoreBridge({
  environment: "prod",
  // WITH its port: the login window lives on the same name without one and
  // answers 204 to anything, so a mistake here fails silently.
  provider: "https://x-core.example.com:13001/",
  // The ONE value copied by hand, from the screen that mints it. It stays here for
  // the life of the application: what decides whether the pairing happens is the
  // `INSTALLED` key below, not the presence of this code.
  installToken: "ycsvtsa_87jk7RFVv0lYDPnUH1CwDcSD-PmvPHyVP2o",
  routes: { basePath: "/api/auth", afterLogin: "/" },

  // Everything this application LENDS, in one key and nowhere else.
  di: {
    hmac: {
      fetch: async (url, init) => signedHttpFetch(url, { ...init, secret: await hmacRuntime.secretHash(), secretIsHashed: true }),
      signHeaders: (request) => sign(request),
      setSecret: (clientId, secret) => hmacRuntime.clients.setSecret(clientId, secret),
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

`<base>` is `routes.basePath`, `/auth` by default.

## The session

```ts
const me = await xcore.session(req, res); // null means signed out
```

```jsonc
{
  "user": { "id": "90dce9b0-…", "email": "…", "displayName": "…", "avatarUrl": "…", "hasPassword": false },
  "profile": { "gender": "mr", "lastname": "…", "firstname": "…", "city": "…", "locale": "fr-FR" },
  "permissions": { "global": ["core:access", "infrastructure:access"], "isRoot": false, "groups": [] },
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

| Situation                           | Answer                                                 |
| ----------------------------------- | ------------------------------------------------------ |
| no cookie, or session closed at SSO | `302` to the portal                                    |
| the gate resource was revoked       | `302` to the portal, on the next call                  |
| signed in without the action        | `403 {"error":"Missing infrastructure:delete-queues"}` |
| the provider is unreachable         | `503 {"error":"The identity provider is unavailable"}` |

A `403` is never a redirect to a sign-in: the account IS signed in, it simply does not hold the right, and sending it to sign in again loops without changing anything.

## The rights

| Call                                                 | Returns                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `xcore.actions(req)`                                 | this application's actions the account holds, without the prefix |
| `xcore.can(req, action)` · `canAll(…)` · `canAny(…)` | a boolean, to hide a button the API would refuse anyway          |
| `xcore.assert(req, ...actions)`                      | nothing, or throws a `403` naming what is missing                |
| `xcore.permissions(req)`                             | the three raw keys: `global`, `isRoot`, `groups`                 |

Nothing is declared to obtain them: the catalogue belongs to the provider, which recomputes it for the account on every `me`. `can` hides, `assert` refuses - and the server decides, never the browser.

## Realtime

```ts
xcore.realtime.attach(server); // on the application's own HTTP server
```

A WebSocket is not bound by the same-origin policy and the provider wants two server-side credentials, so the page never dials it directly. It asks for a ticket over its authenticated session, dials `wss://<own host>/_ws/realtime?ticket=…`, and the bridge redeems it, signs the upstream handshake and sends the `auth` frame itself. An `auth` frame coming from the page is refused.

Following an account is what makes the reads reactive: a permission granted or revoked anywhere lands within seconds instead of at the next navigation. `live.staleAfterMs` (five minutes by default) is the ceiling past which the session is re-proven anyway.

## The browser half

A page holds no SSO code either. `@naskot/node-sso-consumer/client` reads the session, asks for a ticket, dials this host's socket, reconnects, and tells a session that is over from a connection that dropped:

```ts
import { createSsoClient } from "@naskot/node-sso-consumer/client";

const sso = createSsoClient({
  basePath: "/api/auth",
  onAccount: (me) => render(me),
  onSignedOut: () => location.assign("https://portal.example.com/"),
});

const me = await sso.connect();
if (!me) location.assign("/api/auth/sso/start");
if (sso.can("infrastructure:delete-queues")) deleteButton.hidden = false;
```

`@naskot/node-sso-consumer/express` is a third entry, imported once for its effect: it declares `req.me`, `req.ssoTokens` and `req.ssoUserId` on the framework's own request type.

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

- Nothing here reads `process.env`, opens a store or holds a secret. Read env in the service layer and pass plain config.
- The HMAC runtime is injected whole: this library signs with it and owns no credential of its own.
- Provider addresses are written down in the library, per environment, not configured per deployment. `provider` is required all the same, because it is the one address whose mistake is silent.
- The session cookie is sealed AES-256-GCM. The token pair IS the session: no local refresh chain. Changing `session.password` signs everyone out.
- `dependGlobalRessource` is an array and is sent whether it is empty or not.
- One process holds its realtime tickets in memory and pairs on its own. Several need a shared `realtime.tickets` store, and an election OUTSIDE this library: every worker calls `load()`, the elected one calls `start()` - see [Running several processes](./docs/multi-process.md).
