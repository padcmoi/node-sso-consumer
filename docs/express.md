# Express integration

> **Proprietary to x-core.** This library speaks x-core's routes, HMAC scheme, permission catalogue and realtime protocol; there is no other implementation of them. See [Installing an application](./install.md).

An infrastructure console with no login page: it enters from the portal, holds its session on the SSO, shows and applies its rights, and follows the account over a socket.

Six files, in the order they are written. Nothing is elided.

> **It replaces the whole local authentication, not part of it.** No user table, no
> password column, no reset flow, no session table, no permission table, no login
> page. The account, the profile and the rights are asked of x-core on every request
> and never cached - which is what makes a revocation elsewhere land on the very next
> call. The cookie carries the account id and the token pair and nothing else. See
> [what it replaces](../README.md#it-replaces-the-whole-local-authentication).

## 1) The service

`src/sso/xcore.service.ts`

One instance for the whole application, built once at module scope: several would
each open their own sockets for the same accounts.

What this application DECIDES is short, and what it LENDS is shorter. What it IS
towards x-core - identity, callback URL, cancel URL, template, gate - is entered on
the console when the pairing code is minted, and the pairing brings it back. There is
one place that decides it, and this file is not it.

Nothing comes from a `.env` either, not even the password that seals the cookie: it
is minted at the first boot and kept in the application's own store.

**One value is copied by hand**, from the screen that mints the code, and it stays
here for the life of the application:

```ts
installToken: "ycsvtsa_87jk7RFVv0lYDPnUH1CwDcSD-PmvPHyVP2o";
```

There is no `install()` to call. What decides whether the pairing happens is not the
presence of that code but the `INSTALLED` key of `di.environment`: until it reads
true the boot exchanges the code, and once it does the boot never looks at it again.
So there is nothing to remove from a configuration afterwards, and nothing to
remember to call on the right boot.

```ts
import { signedHttpFetch, buildHttpSignedHeaders } from "@naskot/node-hmac-auth";
import { createXcoreBridge } from "@naskot/node-sso-consumer";
import { hmacRuntime } from "./hmac";
import { settings } from "./settings";
import { accountStore } from "./account-store";

const CLIENT_ID = () => xcore.environment.SSO_CLIENT_ID as string;

export const xcore = createXcoreBridge({
  environment: "prod",
  // WITH its port: the login window lives on the same name without one and answers
  // 204 to anything it does not know, so an app pointed at it declares itself
  // "successfully" at every boot while nothing exists on the other side.
  provider: "https://x-core.example.com:13001/",
  installToken: "ycsvtsa_87jk7RFVv0lYDPnUH1CwDcSD-PmvPHyVP2o",

  session: {
    // No password and no name: the first is minted at the first boot, the second is
    // derived from the identity by x-core. What is left is the shape of the cookie.
    cookie: { secure: true, sameSite: "lax", maxAgeDays: 30 },
  },
  routes: { basePath: "/api/auth", afterLogin: "/" },
  realtime: { path: "/_ws/realtime" },
  live: { enabled: true, staleAfterMs: 5 * 60 * 1000 },

  di: {
    hmac: {
      // `init.clientId` is set by the library - it holds the identity, from the
      // pairing or from the store - so this adds a secret and nothing else.
      fetch: async (url, init) => signedHttpFetch(url, { ...init, secret: await hmacRuntime.secretHash(), secretIsHashed: true }),
      // An upgrade is not a fetch: the provider verifies it before a socket exists,
      // so what the dialer needs is the headers themselves.
      signHeaders: async (request) => {
        const headers: Record<string, string> = {};
        buildHttpSignedHeaders({
          ...request,
          clientId: CLIENT_ID(),
          secret: await hmacRuntime.secretHash(),
          secretIsHashed: true,
        }).forEach((value, key) => (headers[key] = value));
        return headers;
      },
      setSecret: (clientId, secret) => hmacRuntime.clients.setSecret(clientId, secret),
    },
    environment: {
      load: () => settings.all(),
      save: (values) => settings.upsertAll(values),
    },
    onAccount: (userId, me) => accountStore.replace(userId, me),
    onSignedOut: (userId) => accountStore.clear(userId),
  },

  logger: console,
  timeoutMs: 10_000,
  retry: { attempts: 5, delayMs: 3_000 },
});
```

| What it lends              | Receives                       | Returns         | Called when                   |
| -------------------------- | ------------------------------ | --------------- | ----------------------------- |
| `hmac.fetch(url, init)`    | a request, `init.clientId` set | the HTTP answer | every call to the provider    |
| `hmac.signHeaders(req)`    | a request to sign              | the headers     | the realtime handshake        |
| `hmac.setSecret(id, s)`    | the identity and the secret    | nothing         | at pairing, once              |
| `environment.load()`       | nothing                        | every key       | at boot, first                |
| `environment.save(values)` | the keys to write              | nothing         | at pairing, and on a rotation |
| `onAccount(userId, me)`    | what the provider pushed       | nothing         | a permission changes          |
| `onSignedOut(userId)`      | the account                    | nothing         | the session is over           |

The signing is not written here either: `signedHttpFetch` and `buildHttpSignedHeaders`
come from `@naskot/node-hmac-auth`, the same code that signs everywhere else in the
ecosystem, so there is no second implementation of the protocol to drift from the one
that verifies in front. **No secret ever crosses this library.**

The hash is re-read on EVERY call rather than captured at boot: the credential is
replaced by propagation, and a client built once would sign with the old one until the
next restart - which surfaces as a `401` on everything, with nothing naming the cause.

`environment` holds eighteen keys and this library writes them: `INSTALLED`,
`SSO_SESSION_PASSWORD`, `SSO_SESSION_COOKIE_NAME`, `SSO_CLIENT_ID`, `SSO_REDIRECT_URI`,
`SSO_CANCEL_URI`, `SSO_PORTAL_URL`, `SSO_TEMPLATE`, `SSO_DEPEND_GLOBAL_RESSOURCE`, `HMAC_AMQP_QUEUE`,
`HMAC_PROPAGATION_SECRET`, `HMAC_AMQP_VHOST`, `HMAC_AMQP_BROKER_QUEUE`,
`RABBITMQ_PROTOCOL`, `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`,
`RABBITMQ_PASSWORD`. The values are JSON, not strings - a gate is a list, a port is a
number - and `save` is an UPSERT: it writes the keys it is given and leaves the others
alone.

`xcore.environment` hands the whole of it back, which is what wires the propagation
consumer to the broker. This library holds no broker and never will.

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
import { xcore } from "./sso/xcore.service";
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
createXcoreBridge({
  // ...
  di: {
    // ...
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
- The pairing code stays in the service for the life of the application. It is never looked at again once `INSTALLED` is true, and it opens nothing anyway: x-core deleted its row and revoked the manager key the moment it was spent.
- Several workers: every one calls `await xcore.load()`, the elected one calls `await xcore.start()`, and they share a `realtime.tickets` store so a ticket minted on one is spendable on another. See [Running several processes](./multi-process.md).
- The sealing password is minted at the first boot and kept under `SSO_SESSION_PASSWORD`. Deleting that key signs everyone out at once, and the next boot mints a new one.
- Read `process.env` in this service layer, never in the library.
