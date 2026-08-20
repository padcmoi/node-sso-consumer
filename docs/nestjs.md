# NestJS integration

> **Proprietary to x-core.** This library speaks x-core's routes, HMAC scheme, permission catalogue and realtime protocol; there is no other implementation of them. See [Installing an application](./install.md).

The same bridge, wired the way Nest wires things: a provider, a middleware for the routes, a guard for the two doors, and a filter for the refusals.

Nothing here is Express-specific - the library reads what Node hands over, so this works the same under the Fastify platform.

> **It replaces the whole local authentication, not part of it.** No user table, no
> password column, no reset flow, no session table, no permission table, no login
> page. The account, the profile and the rights are asked of x-core on every request
> and never cached - which is what makes a revocation elsewhere land on the very next
> call. The cookie carries the account id and the token pair and nothing else. See
> [what it replaces](../README.md#it-replaces-the-whole-local-authentication).

## 1) The provider

`src/sso/xcore.provider.ts`

One instance for the whole application: several would each open their own sockets for
the same accounts. Instantiation is synchronous and reaches nobody; the boot is a
lifecycle hook, which is what lets it be awaited and fail out loud.

What this application DECIDES is short, and what it LENDS is shorter. What it IS
towards x-core - identity, callback URL, cancel URL, template, gate - is entered on
the console when the pairing code is minted, and the pairing brings it back. There is
one place that decides it, and this file is not it.

Nothing comes from a `.env` either, not even the password that seals the cookie: it
is minted at the first boot and kept in the application's own store.

**One value is copied by hand**, from the screen that mints the code, and it stays
here for the life of the application:

```ts
installToken: {
  prod: "ycsvtsa_87jk7RFVv0lYDPnUH1CwDcSD-PmvPHyVP2o";
}
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
import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { settings } from "./settings";
import { accountStore } from "./account-store";

const CLIENT_ID = () => xcore.environment.SSO_CLIENT_ID as string;

@Injectable()
export class XcoreProvider implements OnApplicationBootstrap, OnModuleDestroy {
  readonly bridge = createXcoreBridge({
    // Which of the two environments this process is, and only the application can say
    // it: this library reads no `process.env`, and a bundler freezes that value at
    // build time anyway. `"dev"` or `"prod"`, and anything else throws rather than be
    // guessed - read as dev, a wrong value stands a production process down and leaves
    // its local login facing the internet, without a word.
    NODE_ENV: process.env.NODE_ENV === "production" ? "prod" : "dev",

    // The provider, one per environment. `baseUrl` is the API WITH its port: the login
    // window lives on the same names without one and answers 204 to anything it does
    // not know, so an application pointed at it declares itself "successfully" at every
    // boot while nothing exists on the other side.
    //
    // Which of the two is used is decided by `NODE_ENV` above: the same configuration
    // ships to both. `dev` is optional - without it this library stands down in
    // development and the application keeps its own local login.
    provider: {
      dev: { baseUrl: "https://d-sso.example.com:13001" },
      prod: { baseUrl: "https://x-core.example.com:13001" },
    },

    // One pairing code per environment, each minted against its own x-core. It stays
    // here for the life of the application: `INSTALLED` decides, not its presence.
    installToken: {
      dev: "ycsvtsa_87jk7RFVv0lYDPnUH1CwDcSD-PmvPHyVP2o",
      prod: "8hK2mQx_pT4vN9wZaLbYcRdEfGhJkMnPqSt7UvWx1Yz",
    },

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

  // `onApplicationBootstrap` and not `onModuleInit`: everything the declaration
  // needs - the credential store, its broker - is up by then.
  async onApplicationBootstrap() {
    await this.bridge.start();
  }

  onModuleDestroy() {
    this.bridge.close();
  }
}
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

## 2) The guard and its decorator

`src/sso/xcore.guard.ts`

One guard for both doors: it resolves the session, puts it on the request, then checks whatever the route asked for. Authenticating and authorising cannot come apart, and nothing defaults to open.

```ts
import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SsoError } from "@gestionpratique/node-sso-consumer";
import { XcoreService } from "./xcore.service";

export const PERMISSIONS = "sso:permissions";
/** Every action listed, or the call is refused. */
export const RequirePermissions = (...actions: string[]) => SetMetadata(PERMISSIONS, actions);

@Injectable()
export class XcoreGuard implements CanActivate {
  constructor(
    private readonly xcore: XcoreService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const resolved = await this.xcore.bridge.sessionOf(req, res);
    // UNAUTHORIZED rather than a redirect: the filter below decides what a browser
    // sees, and an XHR must not be answered with the portal's HTML.
    if (!resolved) throw new SsoError("UNAUTHORIZED", "No session");

    req.me = resolved.me;
    req.ssoTokens = resolved.tokens;
    req.ssoUserId = resolved.userId;

    const actions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS, [context.getHandler(), context.getClass()]);
    // Throws FORBIDDEN naming what is missing.
    if (actions?.length) this.xcore.bridge.assert(req, ...actions);
    return true;
  }
}
```

## 3) The filter

`src/sso/xcore.filter.ts`

The distinction that matters: `FORBIDDEN` is about the ACCOUNT and must not be redirected to a sign-in, which would loop - signing in again changes nothing about what it holds. `UNAUTHORIZED` is about the SESSION, which a round trip does fix.

```ts
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import { SsoError } from "@gestionpratique/node-sso-consumer";
import { XcoreService } from "./xcore.service";

@Catch(SsoError)
export class XcoreExceptionFilter implements ExceptionFilter {
  constructor(private readonly xcore: XcoreService) {}

  catch(error: SsoError, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest();
    const res = host.switchToHttp().getResponse();

    if (error.code === "FORBIDDEN") return res.status(403).json({ error: error.message });
    if (error.code === "UNAUTHORIZED") {
      // An XHR gets a status it can act on; a navigation gets the portal, which is
      // the only thing in this ecosystem that signs a human in.
      const wantsJson = String(req.headers?.accept ?? "").includes("application/json");
      return wantsJson ? res.status(401).json({ error: "No session" }) : res.redirect(this.xcore.bridge.provider.portalUrl);
    }
    // NO_CREDENTIAL, NOT_XCORE, UNREACHABLE, MALFORMED_ANSWER, REFUSED: this
    // application's problem, and never the reader's to act on.
    res.status(503).json({ error: "The identity provider is unavailable" });
  }
}
```

## 4) The module

`src/sso/xcore.module.ts`

The five routes go on as a middleware - they are the library's handlers, and the guard must not run in front of them: `/sso/start` is what a signed-out browser is sent to.

```ts
import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { HmacModule } from "../hmac/hmac.module";
import { XcoreService } from "./xcore.service";
import { XcoreGuard } from "./xcore.guard";
import { XcoreExceptionFilter } from "./xcore.filter";

@Module({
  imports: [HmacModule],
  providers: [XcoreService, XcoreGuard, { provide: APP_FILTER, useClass: XcoreExceptionFilter }],
  exports: [XcoreService, XcoreGuard],
})
export class XcoreModule implements NestModule {
  constructor(private readonly xcore: XcoreService) {}

  configure(consumer: MiddlewareConsumer) {
    // GET  /api/auth/sso/start       where the portal's card points
    // GET  /api/auth/sso/callback    the code comes back, sealed into a session
    // POST /api/auth/logout          closes THIS app's session, not the SSO's
    // GET  /api/auth/session         the account, its details, its rights
    // POST /api/auth/realtime-ticket what the page dials the socket with
    consumer.apply(this.xcore.bridge.middleware.routes()).forRoutes("*");
  }
}
```

## 5) A controller

```ts
import { Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
// Imported once anywhere in the app, for its effect: it is what puts `req.me` on
// the request type, so this file reads it without reaching for `any`.
import "@gestionpratique/node-sso-consumer/express";
import { XcoreGuard, RequirePermissions } from "../sso/xcore.guard";
import { XcoreService } from "../sso/xcore.service";

@Controller("api/queues")
@UseGuards(XcoreGuard)
export class QueuesController {
  constructor(
    private readonly xcore: XcoreService,
    private readonly broker: BrokerService
  ) {}

  @Get()
  @RequirePermissions("view-queues")
  async list(@Req() req: Request) {
    return {
      data: await this.broker.list(),
      // Hides a button the API would refuse anyway. Hiding is not enforcing - the
      // decorator on each route is.
      can: { create: this.xcore.bridge.can(req, "create-queues") },
    };
  }

  @Post()
  @RequirePermissions("create-queues")
  async create(@Req() req: Request) {
    // The guard already resolved it for this request; asking again would be
    // another round trip - and another token rotation - for the same answer.
    return { data: await this.broker.create(req.body, { by: req.me?.user.email }) };
  }
}
```

## 6) The socket

`src/main.ts` - the bridge hangs on the underlying HTTP server, and returns for every upgrade that is not its own, so an application's own gateways can share it.

```ts
const app = await NestFactory.create(AppModule);
app.set("trust proxy", true);
await app.listen(3333);

app.get(XcoreService).bridge.realtime.attach(app.getHttpServer());
```

## 7) The page

The browser half is the library's too - see [the Express guide](./express.md#5-the-page) for `@gestionpratique/node-sso-consumer/client`, which is the same file whatever serves it.

## 8) Production notes

- `trust proxy` behind a relay, or every session is filed under the container's address rather than the browser's.
- `onApplicationBootstrap` rather than `onModuleInit`: everything the declaration needs - the credential store, its broker - is up by then. It reads the store, pairs only if `INSTALLED` is not true, and declares.
- The pairing code stays in the provider for the life of the application. It is never looked at again once `INSTALLED` is true, and it opens nothing anyway: x-core deleted its row and revoked the manager key the moment it was spent.
- Several workers need an election and a shared ticket store: see [Running several processes](./multi-process.md).
- The sealing password is minted at the first boot and kept under `SSO_SESSION_PASSWORD`. Deleting that key signs everyone out at once, and the next boot mints a new one.
- Nothing reads a `.env`, here or in the library. What a deployment used to carry lives in the application's own store, written by the pairing.\n- Several workers: elect outside. Every worker calls `await bridge.load()`, only the elected one calls `await bridge.start()`.
