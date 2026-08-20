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

| Step | Where  | What                                                                         |
| ---- | ------ | ---------------------------------------------------------------------------- |
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

The code goes into the application's configuration and STAYS there, for the life of
the application:

```ts
createXcoreBridge({
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
  di: { hmac: { … }, environment: { load, save } },
});
```

There is no identity here, no callback URL, no gate and no session password. All of
it was entered on the console when the code was minted, and the pairing brings it
back - so there is exactly one place that decides what this application is, and it is
not this file.

### There is no `install()` to call

What decides whether the pairing happens is not the presence of the code but the
`INSTALLED` key of the application's own store:

| `INSTALLED`   | What the boot does                                                                   |
| ------------- | ------------------------------------------------------------------------------------ |
| absent, false | exchanges the code, writes the credential, records everything with `INSTALLED: true` |
| true          | does not even look at the code, declares, and that is all                            |

Two things follow, and they are the two that made the old shape fragile.

The code **stays in the configuration**. There is nothing to remove after the first
boot, so nothing to forget to remove. And since it is not read once the key is set, a
deployment that keeps it does not spend it a second time - it would not open anything
anyway: x-core deleted the row and revoked the manager key the moment it was spent.

The state is **written**, not inferred. The question "is this already installed?" used
to be answered by looking for a credential in the store, which is indirect evidence: a
credential that arrived by propagation, with no installation behind it, answered "yes"
to a question nobody had asked it.

`INSTALLED` is written in the SAME `save` as everything it announces, and never before
it. Written first, a boot falling between the two would believe itself paired while
holding none of what that announces - and would never try again, since it no longer
looks at the code.

## One call, and there is nothing to do

```ts
await xcore.start();
```

It reads the store, pairs if it must, and declares. It goes to the `provider` address
configured above, and to exactly one route on it:

```http
POST https://x-core.example.com:13001/api/v1/portal/install
x-install-token: 7EPkuTlxYY2GcDkylMqWrGezgmXDi0LPnae_DkKofQQ
content-type: application/json

{}
```

What it does is small, and smaller than it looks:

| Step | Where        | What                                                                                               |
| ---- | ------------ | -------------------------------------------------------------------------------------------------- |
| 1    | this library | reads `di.environment.load()` and looks at `INSTALLED`                                             |
| 2    | this library | `POST {provider}/api/v1/portal/install`, **unsigned**, **no body**                                 |
| 3    | x-core       | reads the reservation, answers it whole and deletes the row                                        |
| 4    | x-core       | **revokes** the manager key it borrowed: nothing is left for it                                    |
| 5    | this library | opens the propagation queue; the credential arrives on it and goes through `di.hmac.setCredential` |
| 6    | this library | records the whole answer, `INSTALLED` included, in one `save`                                      |
| 7    | this library | declares the consumer, signed, as every later boot does                                            |

It is the only unsigned call this library ever makes, and it cannot be otherwise: what
it collects is the credential a signature would be built from, so requiring one would
be requiring the outcome as the input.

**No body**, and that is deliberate. An application that could still send its own
callback URL here would be an application able to point somebody else's installation
at itself.

### The queue

It matters beyond this one call: it is what every later **rotation** travels on.
Without it the secret would exist in x-core and in this one answer and nowhere else,
and nothing could ever replace it.

The name on the broker is `hmac-<base>.queue`, where `base` is what the infrastructure
manager built from the destination and the environment - `x-facturation-prod`, and the
login `x_facturation_prod`. None of that is decided here or guessed at: it is read back
from what the manager answered, so there is one implementation of the convention rather
than two that can disagree.

## What comes back, and where it lands

Nothing is handed back to be transcribed. `start()` records the whole answer through
`di.environment.save`, and `xcore.environment` reads it out again:

```ts
xcore.environment;
// {
//   INSTALLED:                   true,
//   SSO_SESSION_PASSWORD:        "…",                     // minted here, never received
//   SSO_SESSION_COOKIE_NAME:     "sso_oauth_x_facturation",
//   SSO_CLIENT_ID:               "oauth-x-facturation",
//   SSO_REDIRECT_URI:            "https://facturation.example.com/api/auth/sso/callback",
//   SSO_CANCEL_URI:              "https://facturation.example.com/",
//   SSO_PORTAL_URL:              "https://portal.example.com",     // where a sign-out lands
//   SSO_TEMPLATE:                "gestionpratique",
//   SSO_DEPEND_GLOBAL_RESSOURCE: ["facturation"],
//
//   HMAC_AMQP_QUEUE:             "x-facturation-prod",
//   HMAC_PROPAGATION_SECRET:     "…",
//   HMAC_AMQP_VHOST:             "hmac-credentials",
//   HMAC_AMQP_BROKER_QUEUE:      "hmac-x-facturation-prod.queue",
//
//   RABBITMQ_PROTOCOL:           "amqps",
//   RABBITMQ_HOST:               "x-amqp.example.com",
//   RABBITMQ_PORT:               5671,
//   RABBITMQ_USER:               "x_facturation_prod",
//   RABBITMQ_PASSWORD:           "…",
// }
```

The HMAC credential is NOT among them: it arrives on the propagation queue and goes
through `di.hmac.setCredential`, into the store
that signs with it, and never onto a key/value shelf beside a broker password.

The `RABBITMQ_*` and `HMAC_AMQP_*` keys are the application's propagation
configuration, and wiring the consumer with them is still its own job - **this library
opens the credential queue itself**, with `@naskot/node-hmac-auth-core-propagation` as its own dependency. What changed is that they are no longer transcribed
by hand from a screen, which is the gesture people get wrong: left unwired, an
application signs perfectly on its first boot and then misses every rotation. The
secret is replaced in x-core, the event is published to a queue nobody reads, and what
surfaces days later is a `401` on every call with no cause named anywhere.

The broker's ADDRESS travels with them, and that is deliberate: it belongs to the
infrastructure and moves with it. An application holding a copy of an old one keeps
dialling it long after everybody has moved.

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
