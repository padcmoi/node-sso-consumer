# Installing an application

## What this library is, before anything else

**It is proprietary to x-core.** Not "designed for" it, not "works best with" it: it speaks x-core's protocol, and there is no other implementation of that protocol anywhere.

Concretely, it will not run against anything else:

- the routes are x-core's - `PUT /api/v1/sso/consumer/config`, `POST|PUT|DELETE /api/v1/sso/consumer/session`, `GET /api/v1/sso/me`, `POST /api/v1/portal/install`;
- the authentication is x-core's HMAC scheme, over `@naskot/node-hmac-auth-core`, signing `METHOD + path(+query) + timestamp + nonce + sha256(body)` with a **hashed** secret;
- the identity model is x-core's: the HMAC clientId IS the SSO identity. There is no `client_id` / `client_secret` pair, no OAuth discovery document, no JWKS, no OIDC. Pointing this at an OAuth2 or OIDC provider does not fail politely - nothing matches;
- the permissions are x-core's `resource:action` catalogue, recomputed per account and answered whole with every `me`;
- the realtime protocol is x-core's, down to its close codes;
- the provider addresses are **written into the library** ([`src/providers.ts`](../src/providers.ts)), per environment.

It also needs an x-core recent enough to serve `POST /api/v1/portal/install`. Against an older one, everything works except installing: the credential has to be provisioned by hand through `POST /api/v1/sso/consumer/config` and delivered over the broker, and this library is then given a store that already holds it.

## The install token

An application does not get created by an operator filling in a form. It **installs itself**, and what lets it is a pairing code minted on x-core's manager, under _Portails applicatifs → Jetons d'installation_:

- **one destination, one code.** The label is unique - two codes for one application would be two answers to which one installs it. Wanting a fresh value is a regeneration on the same row, not a second row;
- **it expires**, in hours, 24 by default;
- **it is single-use**, and it is spent the moment it is claimed, before anything is created;
- **it stays readable** on that screen for as long as it lives: an installation is not always finished the day it is prepared, and a code nobody can read back is a code minted twice.

That value goes into the application's config, the way any other secret does:

```ts
createXcoreBridge({
  clientId: "oauth-x-facturation",
  hmac: hmacService.http,
  environment: "prod",
  provider: "https://x-core.example.com:13001/",
  consumer: {
    redirectUri: "https://facturation.example.com/api/auth/sso/callback",
    dependGlobalRessource: ["facturation"],
  },
  session: { password: process.env.SESSION_PASSWORD },
  // Straight from the manager screen. Left in the config for the life of the
  // application: it is skipped in silence once the credential is in the store.
  installToken: process.env.SSO_INSTALL_TOKEN,
});
```

## One call, and the provider does the rest

```ts
await xcore.install();
```

`start()` calls it before declaring, so an ordinary boot needs nothing else. What it does here is small on purpose - it sends the code to the one route that exists for it, and **the work happens on x-core**:

| Step | Where        | What                                                                             |
| ---- | ------------ | -------------------------------------------------------------------------------- |
| 1    | this library | `POST /api/v1/portal/install`, **unsigned**, the code in `x-install-token`       |
| 2    | x-core       | claims the token, by an UPDATE that only takes a row still unspent               |
| 3    | x-core       | creates the **AMQP queue** this application's credential is propagated to        |
| 4    | x-core       | creates the **broker account** for it, scoped to that one queue                  |
| 5    | x-core       | records the **SSO consumer config**: callback, cancel URL, template, access gate |
| 6    | x-core       | mints the **HMAC credential** and aims it at that queue                          |
| 7    | x-core       | stamps the token **spent and withdrawn**                                         |
| 8    | this library | writes the secret into the credential store, through the injected runtime        |
| 9    | this library | declares the consumer, signed, exactly as every later boot does                  |

It is the only unsigned call this library ever makes, and it cannot be otherwise: what it creates is the credential a signature would be built from, so requiring one would be requiring the outcome as the input.

### The queue

It matters beyond this one call: it is what every later **rotation** travels on. Without it the secret would exist in x-core and in this one answer and nowhere else, and nothing could ever replace it.

x-core holds the broker's credentials, so the queue is really created: the row goes into `hmac_propagation_target`, the link into `hmac_credential_target`, and the propagation layer asserts the queue durable on the `hmac-credentials` vhost the first time it publishes to it. The name on the broker is `hmac-<name>.queue`.

Which is where the one constraint comes from. **The queue charset is narrower than the clientId's**: `[A-Za-z0-9-]`, no dot, no underscore, no colon. A clientId is allowed all three, so an identity like `oauth_x_core_manager` is a perfectly legal identity and cannot be a queue name. Such an application names its own:

```ts
createXcoreBridge({
  clientId: "oauth_x_core_manager",
  installToken,
  // Required here, since the clientId carries underscores. x-core refuses with a
  // 400 saying so rather than renaming it into something nobody chose - two
  // identities differing only by a dot would otherwise land on one queue.
  installQueue: "x-core-manager",
});
```

Anything matching the charset needs nothing: the queue takes the clientId's name, which is what an operator recognises on the broker.

## What comes back

```ts
const installed = await xcore.install();
// null when there was nothing to do: no code, or a credential already in the store.

installed?.answer;
// {
//   clientId:    "oauth-x-facturation",
//   secret:      "…43 base64url chars…",   // written into the store for you
//   redirectUri: "https://facturation.example.com/api/auth/sso/callback",
//   template:    null,
//   cancelUri:   null,
//   propagation: {
//     amqpQueue:         "oauth-x-facturation",
//     propagationSecret: "…",
//     brokerQueue:       "hmac-oauth-x-facturation.queue",
//     account: { username: "oauth-x-facturation", password: "…", vhost: "hmac-credentials" }
//   }
// }
```

`propagation` is handed back rather than acted on: this library holds no broker, and the application that does is the one entitled to wire its own consumer.

That is the application's whole propagation configuration, and it belongs in its environment:

```dotenv
HMAC_AMQP_QUEUE=oauth-x-facturation
HMAC_PROPAGATION_SECRET=<propagationSecret>
HMAC_AMQP_VHOST=hmac-credentials
RABBITMQ_USER=<account.username>
RABBITMQ_PASSWORD=<account.password>
```

`account` is null when x-core created nothing: either its `RABBITMQ_MANAGEMENT_URL` is not set - AMQP has no frames for administering users, so creating one needs the management plugin and an administrator account, which is a prod-side arrangement - or a user of that name already exists and was left untouched, since replacing its password would lock out whoever is connected with it. Null means the broker account is somebody's to create by hand; everything else was still done.

The account it does create is scoped to that one queue and nothing else on the vhost. An account able to read the whole propagation vhost could read every other application's rotations, which is every other application's credentials.

`HMAC_PROPAGATION_SECRET` is not decoration. Every rotation event x-core publishes carries the secret recorded on that queue's row, and the receiver compares it to what it was configured with. A mismatch is not an error anybody sees - it is a rotation dropped in silence, and an application still signing with a secret x-core has replaced.

The credential itself needs none of this on the first boot: `install()` has already written it into the store. The queue is what keeps it valid afterwards.

## Afterwards

Nothing about installing runs again. From here the application signs with its own identity and re-declares itself at every boot - `PUT /sso/consumer/config`, idempotent - which is precisely what every application already in the ecosystem does.

`install()` is safe to leave in the boot path forever:

- no `installToken` in the config → returns `null`, silently;
- a credential already in the store → returns `null`, silently. The code is never spent twice;
- a failure at any step on x-core → the token is **put back**, so a retry works. A provider that could not mint must not turn a retry into a call to whoever may mint a new code.

Running several workers: the code is single-use, so exactly one of them may attempt it. See [Running several processes](./multi-process.md).
