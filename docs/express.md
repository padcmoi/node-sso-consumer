# Express integration

An infrastructure console with no login page: it enters from the portal, holds its session on the SSO, shows and applies its rights, and follows the account over a socket.

Four files, in the order they are written.

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
  /** Minted by the portal, single use, one day of life. Only the first boot needs it. */
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
import { createXcore } from "./sso/xcore.service";
import { queueRoutes } from "./routes/queues.routes";
import { hmacService, sessionPassword, installToken } from "./bootstrap";

const xcore = createXcore({ hmac: hmacService.http, sessionPassword, installToken, logger: console });
const app = express();

app.use(express.json());
// The relay is the only client and it forwards the browser's address. Without
// this, every session is filed under this container's own - which is what its
// owner then reads on the portal's sessions screen.
app.set("trust proxy", true);

// The five routes, and a pass-through for everything else.
app.use(xcore.middleware.routes());

// Nothing under /api is reachable signed out. No exception and no public route: a
// browser with no session goes back to the portal, which is the only thing in this
// ecosystem that signs a human in.
app.use("/api", xcore.middleware.requireSession());
app.use(queueRoutes(xcore));

// Last, and after the routes: it maps the library's codes onto answers.
app.use(xcore.middleware.errors());

const server = createServer(app);
// The socket the browser dials, bridged to the provider's.
xcore.realtime.attach(server);

// Pair if it must, then declare.
await xcore.start();
server.listen(3333, () => console.info("[api] listening on 3333"));
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

  // Several actions mean ALL of them, and the refusal names the ones missing.
  router.post(
    "/api/queues/:name/regenerate",
    xcore.middleware.requirePermissions("manage-queues", "reveal-queue-credentials"),
    async (req, res) => {
      res.json({ data: await brokerService.regenerate(req.params.name) });
    }
  );

  // The account itself: the one route here that asks for no right, because it is
  // about the reader rather than about the infrastructure.
  router.get("/api/me", (req, res) => {
    res.json({
      data: req.me,
      // What THIS console's screens draw from: the actions the account holds here,
      // without their prefix. Nothing was declared to obtain them.
      actions: xcore.actions(req),
    });
  });

  return router;
};
```

## 4) Production notes

- `app.set("trust proxy", true)` behind a relay, or every session is filed under the container's address.
- `await xcore.start()` before `listen`, and leave it there: it is skipped in silence once a credential is in the store.
- The `installToken` is single use and expires in a day. A second boot with a credential already paired does not spend it.
- One process holds its realtime tickets in memory. Several processes, or a dev server that reloads, hand a shared store in `realtime.tickets`.
- `session.password` is 32 characters or more, and changing it signs everyone out.
- Read `process.env` in this service layer, never in the library.
