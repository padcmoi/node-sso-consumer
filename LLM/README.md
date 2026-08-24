# Installing `@gestionpratique/node-sso-consumer` - instructions for an AI agent

Describes **0.1.7**. If `package.json` in this package says a different version, stop and
say so rather than guessing: this file is followed literally, so a drifted copy is worse
than none.

Read this file whole before writing anything. It is deliberately one flat document: the
cost of navigating between files and missing one is higher, for you, than the cost of
reading long.

The reference is a real integration that runs in production, not an example written for
this document. Every code block below is that integration with the hostnames and secrets
replaced.

---

## 1. What this library is, in one paragraph

An application that consumes this SSO holds **no users table, no sessions table, no
permissions table, no password, no login page and no cache**. It holds a sealed cookie
carrying a token pair minted by the provider (x-core), it asks the provider who the reader
is on every request, and it keeps a WebSocket open for the whole session so a change made
in another application arrives in seconds rather than at the next click.

If you find yourself writing a `users` table, a `sessions` table, a password column or a
login form, you have misread the task. Those are what this library **replaces**.

---

## 2. Hard rules

Violating any of these produces something that appears to work and is wrong.

1. **Never cache the account.** Not for a request, not for a second. `sessionOf()` asks the
   provider every time, and that is what makes a revocation land immediately.
2. **Never store a session locally.** A local session row is exactly what cannot honour a
   revocation, because it would still be valid.
3. **Never run the session guard on assets.** Guard pages and your own API, skip
   `/_nuxt/`, `/_ipx/`, fonts and anything with a file extension. See trap 3.
4. **The callback URL belongs to the FRONT's address**, the address a browser can reach -
   not an internal API container's.
5. **A relay must send `x-forwarded-for`.** The library reads it off the raw headers
   itself. Without it every session is filed under the relay's address.
6. **`enabled: false` does not let anything through.** It authenticates against
   `di.local_accounts`, or it shuts every door. It is not a bypass.
7. **The provider's `baseUrl` carries its PORT.** See trap 1 - this one has bitten twice.
8. **Build the bridge once per process**, not once per module evaluation. See trap 2.
9. **Never read `process.env` from inside library configuration you place in a bundled
   file** without knowing it is server-only. The library itself reads no environment
   variable, by design.

---

## 3. What the library gives you

### Six HTTP routes, mounted in one call

`middleware.routes()` answers these and passes everything else through. `<base>` is
`routes.basePath`, default `/api/auth`.

| method | path                     | what it does                                 |
| ------ | ------------------------ | -------------------------------------------- |
| GET    | `<base>/sso/start`       | sends the browser to the login window        |
| GET    | `<base>/sso/callback`    | exchanges the code, seals the session        |
| POST   | `<base>/logout`          | closes at the provider, clears the cookie    |
| GET    | `<base>/session`         | the account, or `null`                       |
| POST   | `<base>/realtime-ticket` | a single-use ticket for the browser socket   |
| POST   | `<base>/sso/sign-in`     | local sign-in, read ONLY at `enabled: false` |

### The methods you will actually call

```
xcore.start()                          at boot. NEVER THROWS, returns a result
xcore.middleware.routes()              the six routes above
xcore.middleware.requireSession()      nothing behind it is served without an account
xcore.middleware.requirePermissions()  refuses unless every action is held
xcore.sessionOf(req, res)              the account, or null. Asks the provider EVERY time
xcore.realtime.attach(server)          hook the socket bridge onto an existing HTTP server
```

### The two entry points

```ts
import { createXcoreBridge } from "@gestionpratique/node-sso-consumer"; // server
import { createSsoClient } from "@gestionpratique/node-sso-consumer/client"; // browser
```

There is a third, `@gestionpratique/node-sso-consumer/express`, which only declares
`req.me`, `req.ssoTokens` and `req.ssoUserId` on Express's request type.

---

## 4. Install, step by step

Do them in this order. Steps 1 and 2 are not code and cannot be skipped.

1. **On the provider's console**, under the applications section, create the application.
   You enter its identity, its address, its cancel URL, its login template and its access
   gate THERE - not in code. The console composes the callback from the address as
   `<address>/api/auth/sso/callback`, which must match `routes.basePath` in step 4.
2. **Copy the install token** the console mints. It is the only value a human copies by
   hand, and it is spent once.
3. **Create the key/value store** the library keeps its installation in (section 6).
4. **Write the service file** - one call, one file (section 5.1).
5. **Mount the routes and the guard** (section 5.2).
6. **Open the browser half** (section 5.3).
7. **Boot and read the log.** `start()` never throws; it returns a status. A boot that
   printed `not-paired` did not install.

---

## 5. The five files

### 5.1 The service - `server/utils/xcore.ts`

One call, one file. Everything this application decides about the SSO is here and nowhere
else.

```ts
import { createXcoreBridge } from "@gestionpratique/node-sso-consumer";
import { getHmacAuthService } from "../services/hmac-auth.service";
import { settings } from "./settings";

const ENVS = {
  dev: {
    // THE PORT IS THE TRAP. See trap 1.
    api: "https://sso.example.test:13001",
    // STATED, not derived: on some deployments the login window is a different host.
    front: "https://sso.example.test",
    // Only needed for a deployment that has never been paired. What decides whether
    // the token is exchanged is the INSTALLED key in the store, never this field.
    installToken: "",
  },
  prod: {
    api: "https://sso.example.test:13001",
    front: "https://sso.example.test",
    installToken: "",
  },
} as const;

const ENV = process.env.NODE_ENV === "production" ? ENVS.prod : ENVS.dev;

// ONE BRIDGE PER PROCESS, held on globalThis. See trap 2 - this is not optional.
const HELD = "__myAppXcoreBridge";
const runtime = globalThis as unknown as Record<string, ReturnType<typeof createXcoreBridge> | undefined>;

export const xcore = (runtime[HELD] ??= createXcoreBridge({
  // true: the provider answers. false: authenticate against di.local_accounts, or
  // shut every door if none were lent. NOT a bypass.
  enabled: true,

  provider: { baseUrl: ENV.api, frontUrl: ENV.front },
  installToken: ENV.installToken,

  session: {
    // No password and no cookie name here: the first is minted at the first boot and
    // kept in the store, the second is derived from the identity by the provider.
    //
    // `secure` follows the deployment and is the WHOLE decision: the library writes
    // the attribute from this value and never asks the request what protocol it
    // arrived on.
    cookie: { secure: true, sameSite: "lax", maxAgeDays: 30 },
  },

  // basePath is what the console composed the callback from. They must agree.
  // loginPath is read only at enabled: false.
  routes: { basePath: "/api/auth", afterLogin: "/dashboard" },

  // The path the BROWSER dials on this host. Keep the default unless you know why:
  // see trap 4.
  realtime: { path: "/_ws/realtime" },

  // Follow every account this process holds a session for, and relay changes to
  // di.onAccount / di.onSignedOut. No guard reads this.
  live: { enabled: true },

  di: {
    // Two functions, never the store itself. The library names no method of any
    // credential package: it asks for the current hash and hands one back.
    // A HASH both ways, never a secret.
    hmac: {
      getCredential: async (clientId) => {
        const { http } = await getHmacAuthService();
        return http.clients.getSecretHash(clientId);
      },
      setCredential: async (clientId, secretHash) => {
        const { http } = await getHmacAuthService();
        await http.clients.setSecretHash(clientId, secretHash);
      },
      deleteCredential: async (clientId) => {
        const { http } = await getHmacAuthService();
        await http.clients.delete(clientId);
      },
    },

    // The store. Two functions over whatever shelf this application keeps.
    // load() returns EVERYTHING in one read; save() upserts what it is given and
    // leaves the rest alone.
    environment: {
      load: () => settings.all(),
      save: (values) => settings.upsertAll(values),
    },

    // What `live` pushed. This process caches no account, so these are a log of a
    // change rather than its application.
    onAccount: (userId, me) =>
      console.info(`[sso] ${userId} changed: ${me.permissions.global.length} right(s), root=${me.permissions.isRoot}`),
    onSignedOut: (userId) => console.info(`[sso] ${userId} is signed out at the provider`),

    // HOW this application says "refused". The library decides WHETHER and WHY and
    // calls this with the refusal already settled. Nothing is recomputed here.
    //
    //   a portal to go to  a real 302 WRITTEN on the response. Thrown instead it
    //                      would carry a body and no Location.
    //   anything else      thrown, which is how Nitro stops a handler.
    errors: (refusal, _req, res) => {
      if (refusal.redirectTo) {
        res.statusCode = 302;
        res.setHeader("location", refusal.redirectTo);
        res.end();
        return;
      }
      throw createError({ statusCode: refusal.status, statusMessage: refusal.message });
    },
  },

  logger: console,
  timeoutMs: 10_000,
  // The provider may start after this application does.
  retry: { attempts: 5, delayMs: 3_000 },
}));
```

`di.errors` receives the raw response object. Its surface is `statusCode`, `getHeader`,
`setHeader`, `end`, `writableEnded` - **there is no `res.writeHead`, no `res.json` and no
`res.redirect`**.

### 5.2 Mounting the routes and the guard - `server/middleware/01.sso.ts`

The library's handlers take `(req, res, next)`. A framework without `next` must supply
one, and **all three ways a handler can end have to be caught, because getting it wrong
does not fail, it HANGS**:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { xcore } from "../utils/xcore";

const run = (handler: ReturnType<typeof xcore.middleware.routes>, req: IncomingMessage, res: ServerResponse) =>
  new Promise<void>((resolve, reject) => {
    Promise.resolve(handler(req, res, (error) => (error ? reject(error) : resolve()))).then(() => resolve(), reject);
  });

export default defineEventHandler(async (event) => {
  const { req, res } = event.node;

  // The six routes. Answering nothing means this was not one of them.
  await run(xcore.middleware.routes(), req, res);
  if (res.writableEnded) return;

  // THE ONE THING THE LIBRARY CANNOT KNOW: which paths are this application's own
  // API. An API refuses with a status; redirecting an XHR to the portal hands a
  // component HTML where it expected JSON. Its handlers call the guard themselves.
  if (event.path.startsWith("/api/")) return;

  // Assets are skipped. See trap 3 - this is not an optimisation.
  if (isAsset(event.path)) return;

  // Pages, behind the library's guard. Without this the shell renders for anybody.
  await run(xcore.middleware.requireSession(), req, res);
});

function isAsset(path: string) {
  return /^\/(_nuxt|__nuxt|_ipx|_fonts)\//.test(path) || /\.[a-z0-9]+$/i.test(path.split("?")[0] ?? "");
}
```

### 5.3 The browser half - `plugins/sso.client.ts`

Not optional in spirit: an application that skips it has no realtime, so no revocation
until somebody clicks.

```ts
import { createSsoClient, signInUrl } from "@gestionpratique/node-sso-consumer/client";

export default defineNuxtPlugin(async () => {
  const account = useSsoAccount();
  const connected = useSsoConnected();
  const sessions = useSsoSessions();

  // Read from the server rather than written here: the provider answers it at pairing.
  const exit = async () => {
    const answer = await $fetch<{ url: string | null }>("/api/portal").catch(() => null);
    location.assign(answer?.url || signInUrl("/api/auth"));
  };

  const client = setSsoClient(
    createSsoClient({
      basePath: "/api/auth",
      // The frame IS the new value, written straight in with no re-read behind it.
      onAccount: (me) => (account.value = me),
      // Signed out at the portal, account disabled, or access to THIS application
      // revoked. Empty everything and leave.
      onSignedOut: () => {
        account.value = null;
        sessions.value = null;
        connected.value = false;
        void exit();
      },
      onFrame: (topic, data) => {
        if (topic === "me-sessions") sessions.value = data;
      },
      onConnectionChange: (up) => (connected.value = up),
    })
  );

  // Read the account, THEN follow it. Dialling without a session is a socket that
  // opens and closes on the ticket route's 401.
  //
  // DO NOT REDIRECT FROM HERE. The server guard already sent a browser with no
  // session where it had to go, before a byte of this page rendered. A second router
  // on top of the first disagrees with it: on the sign-in screen this reads null,
  // goes to sso/start, which sends a reader without a session to the sign-in screen.
  account.value = await client.connect();

  // DO NOT wire `online`, `focus` or `visibilitychange`. They are the client's own
  // since 0.1.2 - it is the only thing that knows whether it holds a socket.
});
```

Three topics are always on and are not subscribed by hand: `me-changed`,
`me-signed-out`, `me-sessions`. Anything else is `client.subscribe(topic)`.

Browser client surface: `session()`, `connect()`, `close()`, `logout()`, `can()`,
`actions()`, `subscribe()`, `unsubscribe()`, `send()`, `revoke(sessionId)`.

### 5.4 The store adapter and its table

`di.environment` is two functions over whatever shelf the application keeps. A **table**,
not a cache: these keys ARE the installation, and losing them costs a re-pairing with a
token the provider deleted when it was spent. Put them where the backups are.

```ts
import { EntitySchema } from "typeorm";

export const AppSettingEntity = new EntitySchema({
  name: "AppSetting",
  tableName: "app_sso_settings",
  columns: {
    key: { name: "key", type: String, length: 190, primary: true },
    // A COLUMN, not a convention. The library hands over JavaScript values and takes
    // them back: the gate is an array, INSTALLED a boolean, the cursor an object.
    // Stored as one opaque blob, that shape survives only as long as every reader
    // remembers to parse it - and the first who does not compares "false" to false.
    type: { name: "type", type: "enum", enum: ["string", "number", "boolean", "array", "object", "null"] },
    value: { name: "value", type: "longtext" },
    createdAt: { name: "created_at", type: "datetime", createDate: true },
    updatedAt: { name: "updated_at", type: "datetime", updateDate: true },
  },
});
```

`load()` must return a key that was never written as **absent**, not as `null`. An empty
gate means "this application filters nothing", which is a declaration, not an absence.

### 5.5 Reaching the account from a page - `composables/useSso.ts`

Hold the client at module scope, one for the whole client session. One socket per page
would drop exactly the topics that must not be dropped between two navigations.

```ts
export const useSsoAccount = () => useState<SsoMe | null>("sso.account", () => null);
export const useSsoConnected = () => useState("sso.connected", () => false);
```

**Never persist this state to `localStorage`.** It would be a session outliving the one it
mirrors, which is the thing this whole model forbids.

`can()` on the client hides a button. It never refuses a call - the server decides, always.

---

## 6. The store: twenty keys

The pairing writes them. You do not.

| key                           | what it is                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `INSTALLED`                   | boolean. **The only thing that decides** whether the pairing code is exchanged |
| `SSO_SESSION_PASSWORD`        | seals the cookie. Minted locally at the first boot, never received             |
| `SSO_SESSION_COOKIE_NAME`     | derived from the identity                                                      |
| `SSO_CLIENT_ID`               | the identity this application signs as                                         |
| `SSO_REDIRECT_URI`            | where the provider sends the browser back                                      |
| `SSO_CANCEL_URI`              | where a reader who gives up lands                                              |
| `SSO_PORTAL_URL`              | where a sign-out lands                                                         |
| `SSO_FRONT_URL`               | the login window                                                               |
| `SSO_TEMPLATE`                | the look of the login screen                                                   |
| `SSO_DEPEND_GLOBAL_RESSOURCE` | the gate, an ARRAY. Empty means this app filters nothing                       |
| `HMAC_AMQP_QUEUE`             | propagation consumer                                                           |
| `HMAC_PROPAGATION_SECRET`     | propagation consumer                                                           |
| `HMAC_AMQP_VHOST`             | propagation consumer                                                           |
| `HMAC_AMQP_BROKER_QUEUE`      | propagation consumer                                                           |
| `RABBITMQ_PROTOCOL`           | broker                                                                         |
| `RABBITMQ_HOST`               | broker                                                                         |
| `RABBITMQ_PORT`               | broker                                                                         |
| `RABBITMQ_USER`               | broker                                                                         |
| `RABBITMQ_PASSWORD`           | broker                                                                         |
| `HMAC_PROPAGATION_CURSOR`     | written by the library, never by the pairing. A position, not a setting        |

---

## 7. Traps that have already cost time

Each of these produced a system that looked fine.

**1. The provider's base URL without its port.** The login window lives on the same name
without a port and answers `204` to anything it does not know, unsigned calls included. An
application pointed at it declares itself "successfully" at every boot with nothing on the
other side.

**2. One bridge per module evaluation instead of one per process.** A dev server
re-evaluates modules on change, and a plain `export const` is rebuilt with them. That
produced two bridges: the plugin had attached the FIRST to the HTTP server and the
middleware was minting tickets on the SECOND. A ticket lives in the instance that minted
it, so every dial was refused with `4402 Ticket spent or expired`, before any upstream was
opened - which is why nothing appeared in the logs at all. Hold it on `globalThis`.

**3. Guarding assets.** The guard asks the provider on every call it runs on. Run on
everything, it ran on every asset a page pulls: dozens of `sessionOf()` per page load, in
parallel, on one session. A rotation is SINGLE USE - several find the access token expired
at the same instant, all spend the same refresh token, one wins and the rest are refused.
The session died from being read too often, which surfaced as a socket opening and dying a
second later, forever. Filter by PATH, never by the `accept` header: filtering on
`text/html` lets through anything that does not announce that type.

**4. Putting the realtime path on `/realtime`.** A dev server may hold its HMR socket
there, so the upgrade never reaches the bridge: an unticketed dial answers `101` where the
bridge answers `401`, and no frame ever arrives. The realtime half is then never exercised
in dev and a clean log is a test that tested nothing. `/_ws/realtime` is the default for
this reason. The bridge returns for every upgrade that is not its own.

**5. `trust proxy`.** Not something this library needs - it never asks a request what
protocol it arrived on, and the cookie's `Secure` comes from your configuration. What
matters is that the relay SENDS `x-forwarded-for`.

**6. Close codes.** `4001`, `4002`, `4003` come from the provider and are fatal. `4402` is
this library's own bridge saying the ticket was spent or expired - it is **not** fatal, and
the client mints another.

---

## 8. Before you say it works

- [ ] Boot printed a paired status, not `not-paired`
- [ ] `<base>/session` answers an account for a signed-in browser and `null` otherwise
- [ ] A page requested without a cookie is redirected, before a byte of shell is rendered
- [ ] The socket stays open - not opening and dying every second (trap 3)
- [ ] A permission revoked elsewhere reaches the open page within seconds, with no click
- [ ] No `users`, `sessions` or `permissions` table was created
- [ ] Assets are not guarded, and your own `/api/` is guarded by its handlers

If any box is unchecked, say which one rather than reporting success.
