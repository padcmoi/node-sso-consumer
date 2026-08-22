import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { XcoreService } from "./sso/xcore.service";

const PORT = 3333;

/**
 * NO PUBLIC PORT. The compose exposes 3333 on the shared network and publishes
 * nothing: the only thing that reaches this process is the console's relay, over the
 * network alias `api`. So there is no CORS here either, on purpose - a permissive
 * header would be the one way this port becomes reachable from a page.
 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // THE RELAY IS THE ONLY CLIENT, and it forwards what it knows about the browser in
  // `x-forwarded-for` and `x-forwarded-proto`. Without this line:
  //
  //   every session is filed under the console container's address rather than the
  //   reader's - one address for all of them;
  //   and this process believes every request arrived over plain HTTP, so the
  //   `secure: true` cookie is written on what it takes to be an insecure connection
  //   and the browser drops it. What one reads then is "signed out" at every
  //   navigation, with nothing in any log.
  app.set("trust proxy", true);

  const xcore = app.get(XcoreService);

  // ── THE LIBRARY'S SIX ROUTES ────────────────────────────────────────────────
  //
  //   GET  /api/auth/sso/start        the portal's card points here
  //   GET  /api/auth/sso/callback     the code comes back, sealed into a session
  //   POST /api/auth/sso/sign-in      standing in only: this application's own screen
  //   POST /api/auth/logout           closes THIS application's session, not the SSO's
  //   GET  /api/auth/session          the account, its details, its rights
  //   POST /api/auth/realtime-ticket  a single-use ticket for the browser's socket
  //
  // `app.use` WITH NO PATH, and this is the correction `docs/nestjs.md` needs.
  // Mounted the way that document describes - `consumer.apply(...).forRoutes("*")`
  // in a `NestModule` - Express strips the mount path off `req.url` before the
  // handler runs, so the library reads `/` for every request, recognises none of its
  // six, and passes all of them on. What comes out is a `404` from Nest on
  // `/api/auth/session`, with nothing in any log and no route to sign in with. A
  // global `use` has no mount path to strip.
  //
  // Ahead of the router, and it has to be: `/sso/start` is where a browser WITHOUT a
  // session is sent, so a guard in front of it would refuse the one route that exists
  // to fix being refused. The handler passes on anything that is not its own.
  app.use(xcore.bridge.middleware.routes());

  // What makes `onModuleDestroy` run on SIGTERM. Without it the bridge is never
  // closed, and a consumer stays registered on the broker until its heartbeat times
  // out - so the next boot finds two.
  app.enableShutdownHooks();

  await app.listen(PORT, "0.0.0.0");

  // The realtime bridge, hung on the HTTP server this application already listens on
  // - the same port, on its own path. The browser dials the CONSOLE, the console
  // relays the upgrade here, and this end holds the pair that signs the handshake to
  // x-core.
  //
  // It returns for every upgrade that is not its own, so a gateway of this
  // application's own can share the same server.
  xcore.bridge.realtime.attach(app.getHttpServer());

  new Logger("Bootstrap").log(`API listening on http://0.0.0.0:${PORT} (internal only)`);
}

void bootstrap();
