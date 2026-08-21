# Nuxt 4 integration, on the Nitro server API

> **Proprietary to x-core.** This library speaks x-core's routes, HMAC scheme, permission catalogue and realtime protocol; there is no other implementation of them. See [Installing an application](./install.md).

Nitro is where this library's shape pays off: there is no `app.use(middleware)` here, no error middleware and no chain. What there is instead is a `server/` folder of handlers, a plugin with the raw HTTP server, and `event.node.req` / `event.node.res` - which is exactly what the library reads and writes.

Five files. Nothing about the SSO lives outside them.

> **It replaces the whole local authentication, not part of it.** No user table, no
> password column, no reset flow, no session table, no permission table, no login
> page. The account, the profile and the rights are asked of x-core on every request
> and never cached - which is what makes a revocation elsewhere land on the very next
> call. The cookie carries the account id and the token pair and nothing else. See
> [what it replaces](../README.md#it-replaces-the-whole-local-authentication).

## 1) The service

`server/utils/xcore.ts`

Under `server/utils/`, so Nitro auto-imports it and every handler reaches the same
instance. Built once at module scope: several instances would each open their own
sockets for the same accounts.

What this application DECIDES is short, and what it LENDS is shorter. What it IS
towards x-core - identity, callback URL, cancel URL, template, gate - is entered on
the console when the pairing code is minted, and the pairing brings it back. There is
one place that decides it, and this file is not it.

Nothing comes from a `.env` either, not even the password that seals the cookie: it
is minted at the first boot and kept in the application's own store.

**One value is copied by hand**, from the screen that mints the code, and it stays
here for the life of the application:

```ts
installToken: "ycsvtsa_87jk7RFVv0lYDPnUH1CwDcSD-PmvPHyVP2o",
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

const CLIENT_ID = () => xcore.environment.SSO_CLIENT_ID as string;

export const xcore = createXcoreBridge({
  // ON, OR WITHDRAWN. The first key, because it decides every other one.
  //
  // At `false` this library WITHDRAWS: no pairing, no declaration, no session, no
  // socket. `start()` hands back without doing anything, the guards let everything
  // through, and what signs anybody in is this application's own affair. It is a
  // decision rather than a fault: it does not throw.
  //
  // It is NOT a "dev mode", it is a switch, and the application computes it. A
  // development machine that wants the real chain writes `enabled: true` and never
  // looks at it again.
  //
  // PASSED, NOT READ: this library reads no `process.env`. A bundler freezes that
  // value at build time anyway, so read from inside it would carry what was true on
  // the machine that built the image.
  enabled: NODE_ENV == "production" ? true : false,

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

| What it lends              | Receives                 | Returns   | Called when                   |
| -------------------------- | ------------------------ | --------- | ----------------------------- |
| `environment.load()`       | nothing                  | every key | at boot, first                |
| `environment.save(values)` | the keys to write        | nothing   | at pairing, and on a rotation |
| `onAccount(userId, me)`    | what the provider pushed | nothing   | a permission changes          |
| `onSignedOut(userId)`      | the account              | nothing   | the session is over           |

The signing is not written here either: this library holds
`@naskot/node-hmac-auth-core` as its own dependency and builds the signed transport
itself, from the hash `getCredential` hands back. So there is no second
implementation of the protocol on this side to drift from the one that verifies in
front, and no secret crosses the boundary - a hash is asked for, a hash is stored.

The hash is re-read on EVERY call rather than captured at boot: the credential is
replaced by propagation, and a client built once would sign with the old one until the
next restart - which surfaces as a `401` on everything, with nothing naming the cause.

`environment` holds nineteen keys and this library writes them: `INSTALLED`,
`SSO_SESSION_PASSWORD`, `SSO_SESSION_COOKIE_NAME`, `SSO_CLIENT_ID`, `SSO_REDIRECT_URI`,
`SSO_CANCEL_URI`, `SSO_PORTAL_URL`, `SSO_TEMPLATE`, `SSO_DEPEND_GLOBAL_RESSOURCE`, `HMAC_AMQP_QUEUE`,
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
dependency, and an application writes no AMQP at all. That queue is not a convenience

- it is how a paired application gets a key that verifies, since the secret the
  pairing answers with is hashed by x-core with a pepper that never travels.

## 2) The routes

`server/middleware/sso.ts`

Nitro middleware runs before every handler and passes through when it answers nothing - which is exactly what `routes()` does. The two are the same idea, so the adapter is four lines.

```ts
export default defineEventHandler(async (event) => {
  const { req, res } = event.node;

  // `routes()` takes a `next`, and here there is none: what Nitro wants is for the
  // handler to return. So `next` resolves a promise, and returning after it is
  // "this was not one of my routes".
  await new Promise<void>((resolve, reject) => {
    void xcore.middleware.routes()(req, res, (error) => (error ? reject(error) : resolve()));
  });

  // Answered by the library: nothing else runs for this request.
  if (res.writableEnded) return;
});
```

## 3) The guard

`server/utils/session.ts`

There is no `requireSession()` middleware to mount here, and it would be the wrong shape anyway: a Nuxt app serves pages and an API from the same origin, and redirecting an XHR to the portal hands a component a page of HTML where it expected JSON. So the guard is a function each handler calls, and it throws what Nitro already knows how to answer.

```ts
import type { H3Event } from "h3";

/** The account, or a 401 the app's own error page turns into a sign-in. */
export const requireSession = async (event: H3Event) => {
  const me = await xcore.session(event.node.req, event.node.res);
  if (!me) throw createError({ statusCode: 401, statusMessage: "No session" });
  return me;
};

/**
 * The same, plus the actions. Refuses with a 403 naming what is missing.
 *
 * A 403 is never a redirect to a sign-in: the account IS signed in, it simply does
 * not hold the right, and sending it to sign in again loops without changing
 * anything.
 */
export const requirePermissions = async (event: H3Event, ...actions: string[]) => {
  const me = await requireSession(event);
  const missing = actions.filter((action) => !xcore.auth.can(me.permissions, action));
  if (missing.length) {
    throw createError({
      statusCode: 403,
      statusMessage: `Missing ${missing.map((action) => xcore.auth.permissions.permission(action)).join(", ")}`,
    });
  }
  return me;
};
```

Used the way every other Nitro handler reads its input:

```ts
// server/api/queues/index.get.ts
export default defineEventHandler(async (event) => {
  const me = await requirePermissions(event, "view-queues");

  return {
    data: await listQueues(),
    // Hides a button the API would refuse anyway. Hiding is not enforcing - the
    // line above is.
    can: { delete: xcore.auth.can(me.permissions, "delete-queues") },
  };
});
```

```ts
// server/api/queues/[name].delete.ts
export default defineEventHandler(async (event) => {
  await requirePermissions(event, "delete-queues");
  await removeQueue(getRouterParam(event, "name"));
  setResponseStatus(event, 204);
});
```

## 4) The socket and the boot

`server/plugins/sso.ts`

A Nitro plugin is where the boot belongs: awaited before anything is served. It is also the nearest thing to the raw HTTP server, which is what the realtime bridge hangs on - though not directly, and that is worth a paragraph.

**Nitro has no runtime hook that hands the server over.** `listen` belongs to the BUILD instance and a plugin runs inside the built one, so there is nothing to hook. What is reachable is the server behind the first request that arrives - `event.node.req.socket.server` - and the bridge is hung there, once. Node sets that property on every socket a server accepted and does not declare it in its own types, so it is the one place an integration reads defensively rather than with the compiler's help.

Hung **once**, and the flag is not a micro-optimisation: a second `upgrade` listener on the same path means two handlers answering one upgrade, the second `handleUpgrade` throwing out of a promise nobody can catch, and that unhandled rejection is the worker gone and restarted for as long as anybody opens that page.

```ts
export default defineNitroPlugin(async (nitro) => {
  // Read the store, pair if `INSTALLED` says so, open the credential queue, declare.
  // It NEVER throws: what it did comes back as a value and is said in the log. A boot
  // that died on a spent token would take the whole application with it.
  const started = await xcore.start();
  if (!started.ok) console.error(`[app] the SSO is not serving (${started.status}): ${started.reason}`);

  let hung = false;
  nitro.hooks.hook("request", (event) => {
    if (hung) return;
    // Node sets `server` on every socket a server accepted and does not type it.
    const socket = event.node.req.socket as unknown as {
      server?: Parameters<typeof xcore.realtime.attach>[0];
    };
    if (!socket.server) return;

    hung = true;
    // The bridge returns for every upgrade that is not its own, so Nuxt's HMR socket
    // in dev is untouched, and its path is matched EXACTLY.
    xcore.realtime.attach(socket.server);
  });

  nitro.hooks.hook("close", () => xcore.close());
});
```

In dev, Nitro reloads the server on every change: hand a shared ticket store, or a ticket minted a second before a reload is gone by the time the socket arrives. See [Running several processes](./multi-process.md).

## 5) The page

`app/composables/useSso.ts` - the browser half, which is also the library's.

```ts
import { createSsoClient, type SsoBrowserClient } from "@gestionpratique/node-sso-consumer/client";
import type { SsoMe } from "@gestionpratique/node-sso-consumer";

const account = ref<SsoMe | null>(null);
const connected = ref(false);
let client: SsoBrowserClient | null = null;

export const useSso = () => {
  onMounted(async () => {
    // The client dials a socket and reads a cookie: both are a browser's business,
    // so nothing here runs during SSR.
    if (client) return;
    client = createSsoClient({
      basePath: "/api/auth",
      // Pushed, not polled: a right revoked anywhere lands here within seconds
      // rather than at the next navigation, and the ref is reactive.
      onAccount: (me) => (account.value = me),
      onSignedOut: () => {
        account.value = null;
        location.assign("https://portal.example.com/");
      },
      onConnectionChange: (up) => (connected.value = up),
    });

    if (!(await client.connect())) location.assign("/api/auth/sso/start");
  });

  onScopeDispose(() => {
    client?.close();
    client = null;
  });

  return {
    account: readonly(account),
    connected: readonly(connected),
    /** Hides a button the API would refuse anyway. The server decides, always. */
    can: (permission: string) => Boolean(client?.can(permission)),
    logout: () => client?.logout(),
  };
};
```

And a page reads it like anything else:

```vue
<script setup lang="ts">
const { account, can, connected } = useSso();
</script>

<template>
  <header>
    <span>{{ account?.user.displayName }}</span>
    <span :class="{ live: connected }" />
  </header>
  <!-- Redrawn on its own the moment the right is revoked, with no reload. -->
  <button v-if="can('console:delete-queues')">Supprimer</button>
</template>
```

## 6) Production notes

- The library never runs during SSR: `xcore` is a `server/` module and the client half is behind `onMounted`. Importing either into a component is what breaks a build.
- Nuxt behind a relay needs the forwarded address to reach Node, or every session is filed under the container's own - which is what the portal's sessions screen then shows.
- `await xcore.start()` in the plugin, before anything is served, and leave it there. It reads the store, pairs only if `INSTALLED` is not true, and declares. The pairing code stays in the file for the life of the application: it is never looked at again once the key is set.
- Dev reloads the server on every change: hand a shared `realtime.tickets` store, or the socket cannot reconnect after one.
- The sealing password is minted at the first boot and kept under `SSO_SESSION_PASSWORD`. Deleting that key signs everyone out at once, and the next boot mints a new one - which is a tool, not a fault.
- Nothing reads a `.env`, here or inside the library. What a deployment used to carry - the identity, the callback, the gate, the broker credentials, the sealing password - lives in the application's own store, written by the pairing.\n- Several workers: elect outside, in the deployment. Every worker calls `await xcore.load()`, and only the elected one calls `await xcore.start()` - this library knows nothing of PM2 or of how many processes there are.
