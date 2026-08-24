import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import next from "next";
import type { WebHandler, WebRequest, WebResponse } from "@gestionpratique/node-sso-consumer";
import { buildSchema } from "./src/sso/store";
import { pool, requests, xcore } from "./src/sso/runtime";

/**
 * ONE process, ONE port: the pages, the six SSO routes and the realtime socket.
 *
 * ── WHY A CUSTOM SERVER AT ALL ────────────────────────────────────────────────
 *
 * Not a second API - the same process - and not a preference either. Two things the
 * App Router cannot do:
 *
 *   1. Its route handlers speak the Web's `Request` and `Response`. This library
 *      speaks `IncomingMessage` and `ServerResponse`, which is what every Node
 *      framework carries underneath, and there is no way to hand one to the other
 *      without an adapter written twice - once each way, per route.
 *   2. `realtime.attach()` needs the HTTP server's `upgrade` event, and Next hands
 *      the server to nobody. Without this file there is no socket at all: no
 *      permission landing on a page while it is open, and no revocation arriving in
 *      seconds.
 *
 * ── AND WHY THE SESSION IS RESOLVED HERE ──────────────────────────────────────
 *
 * `sessionOf` asks x-core, rotates the token pair when it has to, and RE-SEALS the
 * cookie. Writing a cookie is exactly what a Server Component may not do - Next
 * refuses it - so resolving the session during a render would drop the re-seal and
 * break every session at the first rotation, a quarter of an hour in, silently.
 *
 * Resolved here, it is written on a real `ServerResponse` that has not been sent,
 * and the account travels into the render through `AsyncLocalStorage`. A component
 * or an action then reads it for free: ten of them cost x-core nothing.
 */
const PORT = Number(process.env.PORT ?? 3000);
const REALTIME_PATH = "/_ws/realtime";

/**
 * What is served WITHOUT touching the session, and it is not an optimisation.
 *
 * `sessionOf` asks the provider on EVERY call - deliberately, since a held answer is
 * a revocation nobody honours - so a page that pulls forty assets would be forty
 * round trips to x-core for one navigation. None of them can render anything, so
 * none of them needs an account.
 *
 * Next's own dev endpoints are in here too: they are polled continuously.
 */
const UNGUARDED = /^\/(_next|__nextjs|favicon\.ico|robots\.txt)/;

/**
 * A `next`-style handler, run to completion.
 *
 * The library is framework-free: its handlers take `(req, res, next)`. The three
 * ways one can end all have to be caught, because getting that wrong does not fail,
 * it HANGS: it calls `next`, it answers and returns, or it throws - and a discarded
 * rejection takes `next` with it, so the request waits for a call that never comes.
 */
const run = (handler: WebHandler, req: IncomingMessage, res: ServerResponse) =>
  new Promise<void>((resolve, reject) => {
    Promise.resolve(handler(req, res, (error) => (error ? reject(error) : resolve()))).then(() => resolve(), reject);
  });

async function main() {
  // The shelf FIRST, and awaited: `start()` reads it before anything else - that is
  // how it knows whether this application is already paired - so a boot that ran
  // while the tables were still being created would report `not-paired` on a token
  // that was perfectly good.
  await buildSchema(pool());

  const bridge = xcore();

  // `start()` NEVER THROWS: what it did comes back as a value. A boot that died
  // because a token was spent or because x-core was still starting would take this
  // whole application with it, including the pages that have nothing to do with the
  // SSO.
  const started = await bridge.start();
  if (!started.ok) {
    console.error(
      `[poc] the SSO is not serving (${started.status}). ` +
        "Mint an install token on x-core, under « Portails applicatifs », with the callback " +
        "https://sync-gp3.gestionpratique.ovh/api/auth/sso/callback, put it in " +
        "`src/sso/runtime.ts` and boot again."
    );
  }

  const app = next({ dev: process.env.NODE_ENV !== "production" });
  await app.prepare();
  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();

  const routes = bridge.middleware.routes();
  const guard = bridge.middleware.requireSession();

  const server = createServer((req, res) => {
    void serve(req, res).catch((error) => {
      console.error("[poc]", error);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  async function serve(node: IncomingMessage, res: ServerResponse) {
    const path = new URL(node.url ?? "/", "http://internal").pathname;

    // The SAME object, seen through the library's own shape.
    //
    // `IncomingMessage` satisfies `WebRequest` structurally - that is the whole
    // design of this library, and why it runs under Express, Nest, Nitro and a bare
    // server without an adapter for each. But `me` is declared on `WebRequest` and
    // not on Node's type, so it is read through this view rather than through a
    // cast: nothing is converted, and the compiler still checks both ends.
    const req: WebRequest = node;

    // The seven routes, first and unguarded. `/sso/start` is precisely where a browser
    // WITHOUT a session is sent: behind the guard it would refuse the one route that
    // exists to fix being refused. The handler passes on anything that is not one of
    // its own, so there is no list of paths to keep in step here.
    await run(routes, node, res);
    if (res.writableEnded) return;

    // Assets. Handed straight over, outside the scope below: nothing they serve can
    // read an account, and nothing they do needs a request scope.
    if (UNGUARDED.test(path)) return handle(node, res);

    // Everything else goes behind the library's own guard - it resolves the session,
    // rotates and re-seals when it must, and refuses through `di.errors` when there
    // is nobody. `req.me` is what it leaves behind.
    //
    // EXCEPT the sign-in screen, which is only ever reached while the library stands
    // in: guarded, a reader refused on it would be sent to it, and refused again.
    if (path !== "/login") {
      await run(guard, node, res);
      if (res.writableEnded) return;
    }

    // The scope, opened for the sign-in screen too - because the action that screen
    // posts is what seals the cookie, and it needs the response to write it on.
    //
    // Awaited, or the context is gone before React has finished with it.
    const answer: WebResponse = res;
    await requests().run({ req, res: answer, me: req.me ?? null }, () => handle(node, res));
  }

  // The socket, on the same server and the same port. It returns for every upgrade
  // that is not its own, so Next's dev HMR socket - which is an upgrade on
  // `/_next/webpack-hmr` - is left to Next.
  bridge.realtime.attach(server);
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://internal").pathname;
    if (path !== REALTIME_PATH) void upgrade(req, socket, head);
  });

  // A process that exits without letting go leaves a consumer registered on the
  // broker until its heartbeat times out, and the next boot finds two.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      bridge.close();
      server.close(() => process.exit(0));
    });
  }

  server.listen(PORT, "0.0.0.0", () => console.info(`[poc] listening on http://0.0.0.0:${PORT}`));
}

void main();
