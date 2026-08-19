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

## The installation happens before the application does

This is the part worth reading twice, because it is not where it used to be.

An application does not get created by an operator filling in a form, and it does not create itself either. An operator goes to x-core's manager, under _Portails applicatifs → Jetons d'installation → Générer un jeton_, walks four steps, and what the last one hands back is a **pairing code**. That act is the installation:

| Step | Where  | What                                                                        |
| ---- | ------ | --------------------------------------------------------------------------- |
| 1    | x-core | asks the **infrastructure manager** for a queue and a broker account for it  |
| 2    | x-core | records the **propagation target** the credential will travel on             |
| 3    | x-core | records the **SSO consumer**: identity, callback, cancel URL, template, gate |
| 4    | x-core | mints the **HMAC credential** and aims it at that queue                      |
| 5    | x-core | seals both secrets onto the token's row, and answers the code                |

By the time the code is handed over, everything exists. The queue is on the broker, the account is scoped to it, the identity is in the SSO. What the operator carries away is one value.

Three things follow from that, and they are the whole point:

**A failure lands on a form.** It used to land on the first boot of a service nobody was watching, hours later, with the code already spent - and the person who could have fixed it had gone home. Now a key that opens nothing, a name already taken, a manager that is down: all of it refuses in front of whoever can do something about it.

**The borrowed key does not survive.** The infrastructure manager key an operator pasted in to build the reservation is revoked on the manager itself, at both ends of the code's life: when the application collects its credential, and when the code is deleted.

**Deleting the code is a cancellation.** The row on that screen is the only thing that knows a broker account and an SSO identity were created for an application that never arrived. Deleting it takes the credential, the consumer, the propagation target and the broker account back down, in that order. Nothing is left under a name the next attempt would be refused for.

The code itself: **one destination, one code**; **it expires**, in hours; **it is single-use**, and redeeming it deletes the row; and **it stays readable** on that screen for as long as it lives, because an installation is not always finished the day it is prepared.

## Its place in the config

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

`clientId` and `consumer` are still here, and they are not duplicates of what was declared on the console. `clientId` is what this application SIGNS as, on every call, forever. `consumer` is what it re-declares at every boot, which is the ordinary lifecycle of an application already installed. What the console decided is the same thing, once, so that it could exist before the application did - and `install()` refuses a code minted for a different identity rather than letting the two drift apart in silence.

There is no `installQueue`. There used to be, because the queue was named after the clientId and the two charsets disagree. The queue is now named by the infrastructure manager, from the `app` and `env` an operator typed, and this library never has an opinion about it.

### `install()` requires it

The code comes off a screen and is read once, and `install()` takes it as its only argument - required:

```ts
await xcore.install("7EPkuTlxYY2GcDkylMqWrGezgmXDi0LPnae_DkKofQQ");

// Or, when the same call should declare afterwards:
await xcore.start("7EPkuTlxYY2GcDkylMqWrGezgmXDi0LPnae_DkKofQQ");
```

An `install()` that could run with nothing would be a call whose argument reads as decoration, when the code IS what it is about. `start()` is the one that goes looking in the config, because a boot has to be able to run with no code at all - which is the ordinary case of every application already installed. Given both, the argument wins: it is the more recent of the two, and it was typed on purpose.

## One call, and there is nothing to do

```ts
await xcore.install(code);
```

`start()` calls it before declaring, so an ordinary boot needs nothing else. It goes to the `provider` address configured above, and to exactly one route on it:

```http
POST https://x-core.example.com:13001/api/v1/portal/install
x-install-token: 7EPkuTlxYY2GcDkylMqWrGezgmXDi0LPnae_DkKofQQ
content-type: application/json

{}
```

What it does is small, and smaller than it looks:

| Step | Where        | What                                                            |
| ---- | ------------ | --------------------------------------------------------------- |
| 1    | this library | `POST {provider}/api/v1/portal/install`, **unsigned**, **no body** |
| 2    | x-core       | reads the reservation, answers it whole and deletes the row     |
| 3    | x-core       | **revokes** the manager key it borrowed: nothing is left for it |
| 4    | this library | writes the secret into the credential store                     |
| 5    | this library | declares the consumer, signed, as every later boot does         |

It is the only unsigned call this library ever makes, and it cannot be otherwise: what it collects is the credential a signature would be built from, so requiring one would be requiring the outcome as the input.

**No body**, and that is deliberate. An application that could still send its own callback URL here would be an application able to point somebody else's installation at itself.

### The queue

It matters beyond this one call: it is what every later **rotation** travels on. Without it the secret would exist in x-core and in this one answer and nowhere else, and nothing could ever replace it.

The name on the broker is `hmac-<base>.queue`, where `base` is what the infrastructure manager built from the destination and the environment - `x-facturation-prod`, and the login `x_facturation_prod`. None of that is decided here or guessed at: it is read back from what the manager answered, so there is one implementation of the convention rather than two that can disagree.

## What comes back

```ts
const installed = await xcore.install(code);
// null when there was nothing to do: a credential is already in the store.

installed?.answer;
// {
//   clientId:    "oauth-x-facturation",
//   secret:      "…43 base64url chars…",   // written into the store for you
//   redirectUri: "https://facturation.example.com/api/auth/sso/callback",
//   template:    null,
//   cancelUri:   null,
//   propagation: {
//     amqpQueue:         "x-facturation-prod",
//     propagationSecret: "…",
//     brokerQueue:       "hmac-x-facturation-prod.queue",
//     account: { username: "x_facturation_prod", password: "…", vhost: "hmac-credentials" }
//   }
// }
```

`propagation` is handed back rather than acted on: this library holds no broker, and the application that does is the one entitled to wire its own consumer.

That is the application's whole propagation configuration, and it belongs in its environment:

```dotenv
HMAC_AMQP_QUEUE=x-facturation-prod
HMAC_PROPAGATION_SECRET=<propagationSecret>
HMAC_AMQP_VHOST=hmac-credentials
RABBITMQ_USER=<account.username>
RABBITMQ_PASSWORD=<account.password>
```

**Those five are the application's own job, and nothing here writes them.** `install()` writes the credential and stops there. Left unwired, the application signs perfectly on its first boot and then misses every rotation: the secret is replaced in x-core, the event is published to a queue nobody reads, and what surfaces days later is a 401 on every call with no cause named anywhere.

`account` is never null now. It was, when x-core created the queue itself: administering a broker user needs the management plugin and an administrator credential, which x-core does not hold and must not. The infrastructure manager holds it, that is its job, and the account it creates is scoped to that one application's queues and nothing else on the vhost. An account able to read the whole propagation vhost could read every other application's rotations, which is every other application's credentials.

`HMAC_PROPAGATION_SECRET` is not decoration either. Every rotation event x-core publishes carries the secret recorded on that queue's row, and the receiver compares it to what it was configured with. A mismatch is not an error anybody sees - it is a rotation dropped in silence.

## Afterwards

Nothing about installing runs again. From here the application signs with its own identity and re-declares itself at every boot - `PUT /sso/consumer/config`, idempotent - which is precisely what every application already in the ecosystem does.

`install()` is safe to leave in the boot path forever:

- an empty code → throws. It is an environment variable nobody set, and a `null` there would read as "already installed";
- a credential already in the store → returns `null`, silently. The code is never spent twice;
- a code minted for another identity → throws, naming both. It is a misconfiguration, and the alternative is an application that installs cleanly and signs as somebody else;
- a code already redeemed, withdrawn or expired → throws. There is nothing to retry: on x-core the row is gone, and what it held has been handed to whoever redeemed it.

That last one is the one real change in failure behaviour. There is no half-installed state to recover from any more, because nothing is built at this moment: the call either finds a reservation waiting or finds nothing at all.

Running several workers: the code is single-use, so exactly one of them may attempt it. See [Running several processes](./multi-process.md).
