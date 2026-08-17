# @naskot/node-sso-consumer

What a Node application needs to **be** a consumer of the x-core SSO, rather than to build one.

It pairs itself, declares itself at every boot, holds the reader's session, reads their rights and follows the account over a socket. No login page, no copy of anybody's personal data, no permission stored anywhere.

Framework-agnostic: everything runs on the raw Node `IncomingMessage` / `ServerResponse`, so the same code serves Express, NestJS (Express or Fastify), Nitro/Nuxt and anything else that hands over what Node hands over.

## Install

```bash
npm i @naskot/node-sso-consumer
```

## Quick start

```ts
import { createXcoreBridge } from "@naskot/node-sso-consumer";

const xcore = createXcoreBridge({
  clientId: "oauth-x-infra-manager",
  hmac: hmacService.http,
  environment: "prod",
  // WITH its port: the login window lives on the same name without one and
  // answers 204 to anything, so a mistake here fails silently.
  provider: "https://x-core.example.com:13001/",
  consumer: {
    redirectUri: "https://app.example.com/api/auth/sso/callback",
    cancelUri: "https://app.example.com/",
    dependGlobalRessource: ["infrastructure"],
  },
  session: { password: sessionPassword },
  // Given once, on the first boot: it pairs, writes the credential in and declares.
  installToken,
  routes: { basePath: "/api/auth", afterLogin: "/" },
});

// Pair if it must, then declare. Await it BEFORE serving: an application that
// failed to declare itself boots perfectly and refuses every sign-in afterwards.
await xcore.start();
```

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

## Integration guides

- [Express](./docs/express.md)
- [NestJS](./docs/nestjs.md)

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
- One process holds its realtime tickets in memory. Several processes, or a dev server that reloads, need a shared `realtime.tickets` store.
