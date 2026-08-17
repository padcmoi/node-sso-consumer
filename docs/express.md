# Express integration

> **Proprietary to x-core.** This library speaks x-core's routes, HMAC scheme, permission catalogue and realtime protocol; there is no other implementation of them. See [Installing an application](./install.md).

An infrastructure console with no login page: it enters from the portal, holds its session on the SSO, shows and applies its rights, and follows the account over a socket.

Six files, in the order they are written. Nothing is elided.

## 1) The service

`src/sso/xcore.service.ts`

No environment variable here: the provider's addresses vary per environment, not per deployment, and they live in the library. What this file cannot know - the HMAC runtime of another service, the password that seals the cookie, the pairing token - is injected.

No rights catalogue either: the actions belong to the provider, which recomputes them for the account and returns them with every `me`.

```ts
import { createXcoreBridge, type SsoHmacRuntime, type SsoLogger } from "@naskot/node-sso-consumer";

const DOMAIN = "x-infra-manager.example.com";

export interface SsoDeps {
  /**
   * The HMAC runtime of the service that owns this console's credential store,
   * with its Redis, its namespace and the provider's token. Injected whole: this
   * library asks it for one thing and holds no secret of its own.
   */
  hmac: SsoHmacRuntime;
  /** 32 characters or more. Changing it signs everyone out, which is its own tool. */
  sessionPassword: string;
  /** Minted by the portal, single use, one day of life. Only the first boot spends it. */
  installToken?: string;
  logger?: SsoLogger;
}

export const createXcore = (deps: SsoDeps) =>
  createXcoreBridge({
    // There is no client_id/client_secret pair in this protocol: the HMAC clientId
    // IS the identity, and a code minted for it can only be redeemed by a caller
    // signing as it.
    clientId: "oauth-x-infra-manager",
    hmac: deps.hmac,
    // The login window, the portal and the socket come with the name. Naming `prod`
    // while deploying to dev is how an app deliberately shares one account list
    // across both of its own environments.
    environment: "prod",
    // Required although the environment carries a default, and WITH its port: the
    // login window lives on the same name without one and answers 204 to anything
    // it does not know, so a console pointed at it declares itself "successfully"
    // at every boot while nothing exists on the other side. A trailing slash is
    // fine, it is trimmed before anything is signed.
    provider: "https://x-core.example.com:13001/",

    // What this console IS on the provider's side: the row is `sso_consumer` and
    // the route is `PUT /sso/consumer/config`, so the key says the same word.
    consumer: {
      redirectUri: `https://${DOMAIN}/api/auth/sso/callback`,
      cancelUri: `https://${DOMAIN}/`,
      template: "gestionpratique",
      // An ARRAY, sent whether it is empty or not: an optional field is only
      // written when provided, so omitting it could set a gate and never clear one.
      dependGlobalRessource: ["infrastructure"],
    },

    session: { password: deps.sessionPassword, cookie: { name: "sso_session" } },
    installToken: deps.installToken,
    routes: { basePath: "/api/auth", afterLogin: "/" },
    logger: deps.logger,
  });

export type Xcore = ReturnType<typeof createXcore>;
```

## 2) The server

`src/server.ts`

`start()` before `listen`: a console that failed to declare itself boots perfectly and refuses every sign-in afterwards, which is the longest failure to trace back.

```ts
import express from "express";
import { createServer } from "node:http";
// Imported once, for its effect: it is what puts `req.me` on Express's own type.
import "@naskot/node-sso-consumer/express";
import { createXcore } from "./sso/xcore.service";
import { queueRoutes } from "./routes/queues.routes";
import { accountRoutes } from "./routes/account.routes";
import { hmacService, sessionPassword, installToken } from "./bootstrap";

const xcore = createXcore({ hmac: hmacService.http, sessionPassword, installToken, logger: console });
const app = express();

app.use(express.json());
// The relay is the only client and it forwards the browser's address. Without
// this, every session is filed under this container's own - which is what its
// owner then reads on the portal's sessions screen.
app.set("trust proxy", true);

// GET  /api/auth/sso/start       the portal's card points here
// GET  /api/auth/sso/callback    the code comes back, sealed into a session
// POST /api/auth/logout          closes this console's session, not the SSO's
// GET  /api/auth/session         the account, its details, its rights
// POST /api/auth/realtime-ticket what the page dials the socket with
app.use(xcore.middleware.routes());

// Nothing under /api is reachable signed out. No exception and no public route: a
// browser with no session goes back to the portal, which is the only thing in this
// ecosystem that signs a human in.
app.use("/api", xcore.middleware.requireSession());

app.use(queueRoutes(xcore));
app.use(accountRoutes(xcore));

// Last, and after the routes: it maps the library's codes onto answers.
app.use(xcore.middleware.errors());

const server = createServer(app);
// The socket the browser dials, bridged to the provider's. It returns for every
// upgrade that is not its own, so this console's own feeds can share the server.
xcore.realtime.attach(server);

await xcore.start();
server.listen(3333, () => console.info("[api] listening on 3333"));

export { xcore };
```

## 3) The routes

`src/routes/queues.routes.ts` - both levels: what the middleware refuses, and what the answer hides.

```ts
import { Router } from "express";
import type { Xcore } from "../sso/xcore.service";
import { brokerService } from "../services/broker.service";

export const queueRoutes = (xcore: Xcore) => {
  const router = Router();

  router.get("/api/queues", xcore.middleware.requirePermissions("view-queues"), async (req, res) => {
    res.json({
      data: await brokerService.list(),
      // The same list the guards read goes to the browser, and that is intended:
      // it hides a button the API would refuse anyway. Hiding is not enforcing -
      // the middleware on each route is.
      can: {
        create: xcore.can(req, "create-queues"),
        manage: xcore.can(req, "manage-queues"),
        delete: xcore.can(req, "delete-queues"),
      },
    });
  });

  router.post("/api/queues", xcore.middleware.requirePermissions("create-queues"), async (req, res) => {
    // `requireSession` already resolved it for this request; asking again would be
    // another round trip - and another token rotation - for the same answer.
    const queue = await brokerService.create(req.body, { by: req.me?.user.email });
    res.status(201).json({ data: queue });
  });

  // Reading a credential back is a right of its own, and not a shade of managing:
  // whoever may rename a queue has no business being handed its password.
  router.post(
    "/api/queues/:name/credentials",
    xcore.middleware.requirePermissions("reveal-queue-credentials"),
    async (req, res) => {
      res.json({ data: await brokerService.credentials(req.params.name) });
    }
  );

  // Several actions mean ALL of them, and the refusal names the ones missing.
  router.post(
    "/api/queues/:name/regenerate",
    xcore.middleware.requirePermissions("manage-queues", "reveal-queue-credentials"),
    async (req, res) => {
      res.json({ data: await brokerService.regenerate(req.params.name) });
    }
  );

  // Deleting is its own right: the other verbs are repaired by doing them again,
  // this one is not.
  router.delete("/api/queues/:name", xcore.middleware.requirePermissions("delete-queues"), async (req, res) => {
    await brokerService.remove(req.params.name);
    res.status(204).end();
  });

  return router;
};
```

## 4) The account

`src/routes/account.routes.ts` - the one route here that asks for no right: it is about the reader, not about the infrastructure.

```ts
import { Router } from "express";
import type { Xcore } from "../sso/xcore.service";

export const accountRoutes = (xcore: Xcore) => {
  const router = Router();

  router.get("/api/me", (req, res) => {
    res.json({
      data: req.me,
      // What THIS console's screens draw from: the actions the account holds here,
      // without their prefix. Nothing was declared to obtain them - they come with
      // the account, recomputed by the provider on this very request.
      actions: xcore.actions(req),
    });
  });

  return router;
};
```

## 5) The page

`src/public/app.js` - the browser half, which is also the library's.

```js
import { createSsoClient } from "@naskot/node-sso-consumer/client";

const sso = createSsoClient({
  basePath: "/api/auth",
  // Pushed, not polled: a permission granted or revoked anywhere lands here within
  // seconds rather than at the next navigation.
  onAccount: (me) => render(me),
  // The IdP session was closed, the account disabled, or its access revoked. The
  // portal is the only thing that signs a human in, so that is where this goes.
  onSignedOut: () => location.assign("https://portal.example.com/"),
  onConnectionChange: (connected) => badge.classList.toggle("live", connected),
});

const me = await sso.connect();
if (!me) location.assign("/api/auth/sso/start");

// Hides a button the API would refuse anyway. The server decides, always.
if (sso.can("infrastructure:delete-queues")) deleteButton.hidden = false;
```

Nothing about the ticket, the socket URL, the reconnection or the close codes is written here: `connect()` reads the session, asks for a ticket, dials this host, and tells a session that is over from a connection that dropped.

## 6) Following an account elsewhere

The bridge already follows every account it holds a session for, and that is what makes the reads reactive. Two hooks exist for what the library cannot know about - a store of this console's own, a cache, a feed it fans out to itself:

```ts
createXcore({
  // ...
  live: {
    onAccount: (userId, me) => store.replace(userId, me),
    onSignedOut: (userId) => store.clear(userId),
  },
});
```

And for a socket of one's own, on one account:

```ts
// `sessions.read` reads the sealed cookie and asks the provider nothing, which is
// what makes it the right call when the token itself is what is wanted.
const held = xcore.sessions.read(xcore.jar(req, res));
if (held) {
  const live = await xcore.follow({
    accessToken: held.tokens.accessToken,
    onAccount: (me) => feed.push(me),
    onSignedOut: () => feed.end(),
  });
  // The caller owns it and closes it. `xcore.close()` only lets go of what the
  // bridge itself opened.
}
```

## 7) Production notes

- `app.set("trust proxy", true)` behind a relay, or every session is filed under the container's address.
- `await xcore.start()` before `listen`, and leave it there: it is skipped in silence once a credential is in the store.
- The `installToken` is single use and expires in a day. A boot with a credential already paired does not spend it.
- Several workers: hand `bootstrap.elect` so one of them pairs and declares, and a shared `realtime.tickets` store so a ticket minted on one is spendable on another. See [Running several processes](./multi-process.md).
- `session.password` is 32 characters or more, and changing it signs everyone out.
- Read `process.env` in this service layer, never in the library.
