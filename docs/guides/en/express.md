# Express integration

> **Proprietary to x-core.** This library speaks x-core's routes, HMAC scheme, permission catalogue and realtime protocol; there is no other implementation of them. See [Installing an application](./install.md).

An infrastructure console with no login page: it enters from the portal, holds its session on the SSO, shows and applies its rights, and follows the account over a socket.

Six files, in the order they are written. Nothing is elided.

> **It replaces the whole local authentication, not part of it.** No user table, no
> password column, no reset flow, no session table, no permission table, no login
> page. The account, the profile and the rights are asked of x-core on every request
> and never cached - which is what makes a revocation elsewhere land on the very next
> call. The cookie carries the account id and the token pair and nothing else. See
> [what it replaces](../../../README.md#it-replaces-the-whole-local-authentication).

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
installToken: "EXAMPLE_ONLY_yTgc9Qm2LbVx7Kd0Rf3PnW8sHjA6ZuE4",
```

There is no `install()` to call. What decides whether the pairing happens is not the
presence of that code but the `INSTALLED` key of `di.environment`: until it reads
true the boot exchanges the code, and once it does the boot never looks at it again.
So there is nothing to remove from a configuration afterwards, and nothing to
remember to call on the right boot.

```ts
// Built by the application, over its own Redis. It never enters this library.
import { hmacInstance } from "./hmac";
import { createXcoreBridge } from "@gestionpratique/node-sso-consumer";
import { settings } from "./settings";
import { accountStore } from "./account-store";

export const xcore = createXcoreBridge({
  // ON, OR WITHDRAWN. The first key, because it decides every other one.
  //
  // At `false` there is no pairing, no declaration and no socket - AND THIS LIBRARY
  // STILL AUTHENTICATES, against the accounts lent under `di.local_accounts`. It does
  // NOT stand aside: the guards hold, `requirePermissions` refuses a missing right,
  // and the session that comes out has exactly the shape x-core answers.
  //
  // At `false` with NOTHING lent, every door SHUTS instead: no provider to ask and no
  // directory to read means nobody can ever sign in. Standing aside is what used to
  // serve every protected page to whoever asked.
  //
  // It is NOT a "dev mode", it is a switch, and the application computes it. A
  // development machine that wants the real chain writes `mode: "sso"` and never
  // looks at it again.
  //
  // PASSED, NOT READ: this library reads no `process.env`. A bundler freezes that
  // value at build time anyway, so read from inside it would carry what was true on
  // the machine that built the image.
  mode: NODE_ENV === "production" ? "sso" : "local",

  // ONE x-core, named by its API WITH its port, and the only address this
  // application writes itself. The login window lives on the same names without the
  // port and answers 204 to anything it does not know - so an application pointed at
  // it declares itself "successfully" at every boot while nothing exists on the other
  // side. The boot probes the address before declaring anything to it.
  //
  // The other three addresses are derived: the login window is this host without the
  // port, the socket is one port further, and the portal comes back with the pairing.
  provider: { baseUrl: "https://x-core.example.com:13001" },

  // The install token minted on the console, and the ONE value an operator copies out
  // of this whole flow. It stays here for the life of the application: `INSTALLED`
  // decides whether it is exchanged, not its presence.
  installToken: "EXAMPLE_ONLY_yTgc9Qm2LbVx7Kd0Rf3PnW8sHjA6ZuE4",

  session: {
    // No password and no name: the first is minted at the first boot, the second is
    // derived from the identity by x-core. What is left is the shape of the cookie.
    cookie: { secure: true, sameSite: "lax", maxAgeDays: 30 },
  },
  routes: { basePath: "/api/auth", afterLogin: "/" },
  realtime: { path: "/_ws/realtime" },
  live: { enabled: true },

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
    onAccount: (userId, me) => accountStore.replace(userId, me),
    onSignedOut: (userId) => accountStore.clear(userId),
  },

  logger: console,
  timeoutMs: 10_000,
  retry: { attempts: 5, delayMs: 3_000 },
});
```

| What it lends               | Receives                 | Returns            | Called when                   |
| --------------------------- | ------------------------ | ------------------ | ----------------------------- |
| `environment.load()`        | nothing                  | every key          | at boot, first                |
| `environment.save(values)`  | the keys to write        | nothing            | at pairing, and on a rotation |
| `onAccount(userId, me)`     | what the provider pushed | nothing            | a permission changes          |
| `onSignedOut(userId)`       | the account              | nothing            | the session is over           |
| `errors(refusal, req, res)` | a decided refusal        | nothing, or throws | every refusal                 |
| `local_accounts`            | -                        | a list             | read only at `mode: "local"`  |

`errors` is optional and is where a refusal is SPOKEN. The library decides whether and
why - it is the only thing that talks to the provider - and hands the whole conclusion
over: the status, the code, the sentence, and the address to send a browser to when
there is one. Answer however the framework wants, on `res` or by throwing; the throw
travels untouched. Lend nothing and the library writes the plain answer itself.

`local_accounts` is a DIRECTORY, not a procedure: a list of accounts, and no sign-in
function to write. See [`mode`](../../../README.md#mode---x-core-answers-or-this-library-stands-in-for-it).

The signing is not written here either: this library holds
`@naskot/node-hmac-auth-core` as its own dependency and builds the signed transport
itself, from the hash `getCredential` hands back. So there is no second
implementation of the protocol on this side to drift from the one that verifies in
front, and no secret crosses the boundary - a hash is asked for, a hash is stored.

The hash is re-read on EVERY call rather than captured at boot: the credential is
replaced by propagation, and a client built once would sign with the old one until the
next restart - which surfaces as a `401` on everything, with nothing naming the cause.

`environment` holds twenty keys and this library writes them: `INSTALLED`,
`SSO_SESSION_PASSWORD`, `SSO_SESSION_COOKIE_NAME`, `SSO_CLIENT_ID`, `SSO_REDIRECT_URI`,
`SSO_CANCEL_URI`, `SSO_PORTAL_URL`, `SSO_FRONT_URL`, `SSO_TEMPLATE`, `SSO_DEPEND_GLOBAL_RESSOURCE`, `HMAC_AMQP_QUEUE`,
`HMAC_PROPAGATION_SECRET`, `HMAC_AMQP_VHOST`, `HMAC_AMQP_BROKER_QUEUE`,
`RABBITMQ_PROTOCOL`, `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`,
`RABBITMQ_PASSWORD` and `HMAC_PROPAGATION_CURSOR`. That last one is where the
credential queue is up to, so a redelivered rotation is applied once: a position
rather than a setting, and the only key here x-core knows nothing about. The values are JSON, not strings - a gate is a list, a port is a
number - and `save` is an UPSERT: it writes the keys it is given and leaves the others
alone.

`xcore.environment` hands the whole of it back, for whatever else an application does
with it. The broker is not one of those things any more: **this library opens the
credential queue itself**, with `@naskot/node-hmac-auth-core-propagation` as its own
dependency, and an application writes no AMQP at all. That queue is not a
convenience: it is how a paired application gets a key that verifies at all, since the
secret the pairing answers with is hashed by x-core with a pepper that never travels.

## 2) The server

`src/server.ts`

`start()` before `listen`: a console that failed to declare itself boots perfectly and refuses every sign-in afterwards, which is the longest failure to trace back.

```ts
import express from "express";
import { createServer } from "node:http";
// Imported once, for its effect: it is what puts `req.me` on Express's own type.
import "@gestionpratique/node-sso-consumer/express";
import { createXcore } from "./sso/xcore.service";
import { queueRoutes } from "./routes/queues.routes";
import { accountRoutes } from "./routes/account.routes";
import { xcore } from "./sso/xcore.service";
const app = express();

app.use(express.json());
// Express hygiene, and NOT something this library depends on: it reads
// `x-forwarded-for` off the raw headers itself. What actually matters is that the
// relay SENDS that header - without it every session is filed under this
// container's address, which is what the portal's sessions screen then shows.
app.set("trust proxy", true);

// GET  /api/auth/sso/start       the portal's card points here
// GET  /api/auth/sso/callback    the code comes back, sealed into a session
// POST /api/auth/sso/sign-in     answers ONLY while standing in, 404 otherwise
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
import { createSsoClient } from "@gestionpratique/node-sso-consumer/client";

const sso = createSsoClient({
  basePath: "/api/auth",
  // Pushed, not polled - and NOTHING here is polled: this client asks for the
  // session once, a ticket per socket, and a sign-out on a click. Everything else
  // arrives on the socket, which is what a socket is for.
  onAccount: (me) => render(me),
  // The IdP session was closed, the account disabled, its access revoked, or this
  // session ended from the portal's sign-ins screen. The portal is the only thing
  // that signs a human in, so that is where this goes.
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

- The relay must SEND `x-forwarded-for`, or every session is filed under this container's address. This library reads that header off the raw request itself, so `app.set("trust proxy", true)` is Express hygiene rather than something it needs.
- `await xcore.start()` before `listen`, and leave it there: it is skipped in silence once a credential is in the store.
- The pairing code stays in the service for the life of the application. It is never looked at again once `INSTALLED` is true, and it opens nothing anyway: x-core deleted its row the moment it was spent.
- Several workers: every one calls `await xcore.load()`, the elected one calls `await xcore.start()`, and they share a `realtime.tickets` store so a ticket minted on one is spendable on another. See [Running several processes](./multi-process.md).
- The sealing password is minted at the first boot and kept under `SSO_SESSION_PASSWORD`. Deleting that key signs everyone out at once, and the next boot mints a new one.
- Read `process.env` in this service layer, never in the library.
