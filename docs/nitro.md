# Nuxt 4 integration, on the Nitro server API

> **Proprietary to x-core.** This library speaks x-core's routes, HMAC scheme, permission catalogue and realtime protocol; there is no other implementation of them. See [Installing an application](./install.md).

Nitro is where this library's shape pays off: there is no `app.use(middleware)` here, no error middleware and no chain. What there is instead is a `server/` folder of handlers, a plugin with the raw HTTP server, and `event.node.req` / `event.node.res` - which is exactly what the library reads and writes.

Five files. Nothing about the SSO lives outside them.

## 1) The service

`server/utils/xcore.ts`

Under `server/utils/`, so Nitro auto-imports it and every handler reaches the same instance. Built once at module scope: several instances would each open their own sockets for the same accounts.

```ts
import { createXcoreBridge, type SsoHmacRuntime } from "@naskot/node-sso-consumer";
import { hmacRuntime } from "./hmac";

const DOMAIN = "console.example.com";

// `useRuntimeConfig()` is Nitro's env, read HERE and handed over as plain values.
// Nothing inside the library reads an environment.
const config = useRuntimeConfig();

export const xcore = createXcoreBridge({
  clientId: "oauth-console",
  // The HMAC runtime of the module that owns this app's credential store,
  // injected whole: this library signs with it and holds no secret of its own.
  hmac: hmacRuntime satisfies SsoHmacRuntime,
  environment: "prod",
  // WITH its port: the login window lives on the same name without one and answers
  // 204 to anything it does not know, so an app pointed at it declares itself
  // "successfully" at every boot while nothing exists on the other side.
  provider: "https://x-core.example.com:13001/",
  consumer: {
    redirectUri: `https://${DOMAIN}/api/auth/sso/callback`,
    cancelUri: `https://${DOMAIN}/`,
    template: "gestionpratique",
    // An ARRAY, sent whether it is empty or not.
    dependGlobalRessource: ["console"],
  },
  session: { password: config.sessionPassword },
  // Minted by the portal, single use, one day of life. Only the first boot spends
  // it; afterwards the credential is already in the store.
  installToken: config.ssoInstallToken,
  routes: { basePath: "/api/auth", afterLogin: "/" },
  logger: console,
});
```

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

A Nitro plugin is where the raw HTTP server is reachable, which is what the realtime bridge hangs on. It is also where the boot belongs: awaited before anything is served.

```ts
export default defineNitroPlugin(async (nitro) => {
  // Pair if it must, then declare. An app that failed to declare itself boots
  // perfectly and refuses every sign-in afterwards.
  await xcore.start();

  nitro.hooks.hook("request", () => {
    /* nothing: the middleware above carries the routes */
  });

  // `listen` fires once the server exists. The bridge returns for every upgrade
  // that is not its own, so Nuxt's HMR socket in dev is untouched.
  nitro.hooks.hook("listen", (server) => xcore.realtime.attach(server));

  nitro.hooks.hook("close", () => xcore.close());
});
```

In dev, Nitro reloads the server on every change: hand a shared ticket store, or a ticket minted a second before a reload is gone by the time the socket arrives. See [Running several processes](./multi-process.md).

## 5) The page

`app/composables/useSso.ts` - the browser half, which is also the library's.

```ts
import { createSsoClient, type SsoBrowserClient } from "@naskot/node-sso-consumer/client";
import type { SsoMe } from "@naskot/node-sso-consumer";

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
- `await xcore.start()` in the plugin, before anything is served, and leave it there: it is skipped in silence once a credential is in the store.
- Dev reloads the server on every change: hand a shared `realtime.tickets` store, or the socket cannot reconnect after one.
- `session.password` is 32 characters or more, and changing it signs everyone out.
- `useRuntimeConfig()` belongs here, not in the library: nothing inside it reads an environment.
