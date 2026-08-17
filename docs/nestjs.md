# NestJS integration

The same bridge, wired the way Nest wires things: a provider, a middleware for the routes, a guard for the two doors, and a filter for the refusals.

Nothing here is Express-specific - the library reads what Node hands over, so this works the same under the Fastify platform.

## 1) The provider

`src/sso/xcore.service.ts`

No environment variable in the library: read them here and hand plain config over. The HMAC runtime comes from the module that owns the credential store, injected whole.

```ts
import { Inject, Injectable, OnModuleDestroy, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createXcoreBridge, type SsoHmacRuntime } from "@naskot/node-sso-consumer";
import { HmacService } from "../hmac/hmac.service";

const DOMAIN = "x-infra-manager.example.com";

@Injectable()
export class XcoreService implements OnApplicationBootstrap, OnModuleDestroy {
  readonly bridge;

  constructor(
    private readonly config: ConfigService,
    @Inject(HmacService) private readonly hmac: HmacService
  ) {
    // Built here rather than as a field initializer: the injected dependencies
    // below are what it reads, and they are only assigned once the constructor runs.
    this.bridge = createXcoreBridge({
      // There is no client_id/client_secret pair in this protocol: the HMAC
      // clientId IS the identity, and a code minted for it can only be redeemed by
      // a caller signing as it.
      clientId: "oauth-x-infra-manager",
      // The HMAC runtime of the module that owns the credential store, injected
      // whole: this library signs with it and holds no secret of its own.
      hmac: hmac.http satisfies SsoHmacRuntime,
      environment: "prod",
      // WITH its port: the login window lives on the same name without one and
      // answers 204 to anything it does not know, so a console pointed at it
      // declares itself "successfully" at every boot while nothing exists behind.
      provider: "https://x-core.example.com:13001/",
      consumer: {
        redirectUri: `https://${DOMAIN}/api/auth/sso/callback`,
        cancelUri: `https://${DOMAIN}/`,
        template: "gestionpratique",
        // An ARRAY, sent whether it is empty or not.
        dependGlobalRessource: ["infrastructure"],
      },
      session: { password: config.getOrThrow<string>("SESSION_PASSWORD") },
      // Minted by the portal, single use, one day of life. Only the first boot
      // spends it; afterwards the credential is already in the store.
      installToken: config.get<string>("SSO_INSTALL_TOKEN"),
      routes: { basePath: "/api/auth", afterLogin: "/" },
      logger: console,
    });
  }

  // Pair if it must, then declare - before anything is served. An application that
  // failed to declare itself boots perfectly and refuses every sign-in afterwards.
  async onApplicationBootstrap() {
    await this.bridge.start();
  }

  onModuleDestroy() {
    this.bridge.close();
  }
}
```

## 2) The guard and its decorator

`src/sso/xcore.guard.ts`

One guard for both doors: it resolves the session, puts it on the request, then checks whatever the route asked for. Authenticating and authorising cannot come apart, and nothing defaults to open.

```ts
import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SsoError } from "@naskot/node-sso-consumer";
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
import { SsoError } from "@naskot/node-sso-consumer";
import { XcoreService } from "./xcore.service";

@Catch(SsoError)
export class XcoreExceptionFilter implements ExceptionFilter {
  constructor(private readonly xcore: XcoreService) {}

  catch(error: SsoError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();

    if (error.code === "FORBIDDEN") return res.status(403).json({ error: error.message });
    if (error.code === "UNAUTHORIZED") return res.redirect(this.xcore.bridge.provider.portalUrl);
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
    // GET  /api/auth/sso/start      where the portal's card points
    // GET  /api/auth/sso/callback   the code comes back, sealed into a session
    // POST /api/auth/logout         closes THIS app's session, not the SSO's
    // GET  /api/auth/session        the account, its details, its rights
    // POST /api/auth/realtime-ticket what the page dials the socket with
    consumer.apply(this.xcore.bridge.middleware.routes()).forRoutes("*");
  }
}
```

## 5) A controller

```ts
import { Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
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
  async list(@Req() req) {
    return {
      data: await this.broker.list(),
      // Hiding a button the API would refuse anyway. Hiding is not enforcing - the
      // decorator on each route is.
      can: { create: this.xcore.bridge.can(req, "create-queues") },
    };
  }

  @Post()
  @RequirePermissions("create-queues")
  async create(@Req() req) {
    // The guard already resolved it for this request; asking again would be
    // another round trip - and another token rotation - for the same answer.
    return { data: await this.broker.create(req.body, { by: req.me.user.email }) };
  }
}
```

## 6) The socket

`src/main.ts` - the bridge hangs on the underlying HTTP server, and returns for every upgrade that is not its own, so an application's own feeds can share it.

```ts
const app = await NestFactory.create(AppModule);
app.set("trust proxy", true);
await app.listen(3333);

app.get(XcoreService).bridge.realtime.attach(app.getHttpServer());
```

## 7) Production notes

- `trust proxy` behind a relay, or every session is filed under the container's address rather than the browser's.
- `onApplicationBootstrap` rather than `onModuleInit`: everything the declaration needs - the credential store, its broker - is up by then.
- The `installToken` is single use and expires in a day. It is skipped in silence once a credential is in the store, so it is safe to leave in the config.
- One process holds its realtime tickets in memory. Several processes, or a dev server that reloads, hand a shared store in `realtime.tickets`.
- `session.password` is 32 characters or more, and changing it signs everyone out.
- Read `process.env` in this provider layer, never in the library.
