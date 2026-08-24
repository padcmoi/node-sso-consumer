# What the library is, and what it refuses to be

One implementation of everything in this folder, so an application holds none of it.

This document used to describe a contract designed **before** any of it was built, and it did not survive contact: every option was renamed, the identity stopped being configured at all, and the declaration moved to the console. What follows is the surface as it actually is. For how to write it, with every option commented, see [The service file](../../guides/en/service.md).

## Three rules it holds itself to

**It persists nothing.** No table, no migration, no schema. An application installing it creates none, and there is no store to back up. What state exists lives in the reader's sealed cookie and in x-core.

**It reads no `process.env`.** Everything comes in as an argument or as an injected function. A bundler replaces `process.env.NODE_ENV` with a constant at build time, so a value read from inside a bundled library carries what was true on the machine that built the image rather than what is true at boot. The application's own line sits in the application's own build, which knows.

**It owns no credential.** No secret ever crosses it. It asks for the current hash before every signature and hands one back to be stored; where that store is, and how a rotation reaches it, is the deployment's business ([07-reference-apps.md](07-reference-apps.md)).

## What it is given

One object, at construction, through `createXcoreBridge`.

```
mode          "sso" or "local": WHICH DIRECTORY answers. The first key, because it
              decides every other one. Required, no default.
              At "local" the library still authenticates, against di.local_accounts.

provider      { baseUrl, frontUrl?, realtimeUrl?, portalUrl? }
              baseUrl is the API WITH ITS PORT, and the one address an integrator
              types. It is probed before anything is declared to it. The other
              three are derived when absent, and the pairing answers two of them.

installToken  the value minted on the console, and the ONE an operator copies.
              It stays here for the life of the application: what decides whether
              the exchange happens is the INSTALLED key, not this field.

session       { cookie?: { stateName?, secure?, sameSite?, path?, domain?,
                           maxAgeDays? } }
              No password and no name: the first is drawn at the first boot, the
              second is derived from the identity by x-core.

routes        { basePath?, afterLogin?, loginPath? }
              basePath defaults to /api/auth, which is what the console composes
              its callback from. loginPath is read only while standing in.

realtime      { path?, tickets? }
              path is what the BROWSER dials on this host. tickets defaults to
              memory, which is a bug the day there are two workers.

live          { enabled? }
              Follow every account this process holds a session for, and RELAY
              what arrives to di.onAccount / di.onSignedOut. No guard reads from it.

di            everything injected. See below.

logger        timeoutMs        retry { attempts?, delayMs? }
```

**No `identity`, no `declaration`, no `exit`, no `policy`.** Identity, callback URL, cancel URL, template and gate are entered on x-core's console at the step that mints the install token, and the pairing brings them back into the application's own store. Writing them here would be a second source, and since `declare()` sends them back at every boot the application would silently overwrite what an operator set.

### `di`, and nothing else is injection

```
hmac.getCredential(clientId)          the current hash, read before EVERY signature
hmac.setCredential(clientId, hash)    store what the propagation queue carried
hmac.deleteCredential?(clientId)      optional

environment.load()                    everything, in one read, before anything else
environment.save(values)              upsert what is given, leave the rest alone

local_accounts?                       a LIST, read only at mode: "local"
errors?(refusal, req, res)            how THIS application says "refused"
onAccount?(userId, me)                what live pushed
onSignedOut?(userId)                  the session is over
```

Two functions for the credential, two for the store, and never the store itself: an object handed across this boundary is one this library holds and depends on, so the day the credential package renames a method every application using this one waits for a release. A function moves the break into the application's own file, where it is one line.

`errors` is the same rule applied to refusals. The library decides WHETHER and WHY - it is the only thing that talks to the provider - and this says HOW, because that belongs to the framework underneath. Lend nothing and the library writes the plain answer itself.

## What it does

```
start()                          read the store, pair if INSTALLED says so, open the
                                 credential queue, prove the address, declare.
                                 NEVER THROWS: the outcome is an XcoreStartResult.
load()                           the store alone, for a worker that does not declare
declare()                        the declaration alone
close()                          every socket and the queue, for a process exiting

session(req, res)                the account, or null. Asks the provider EVERY time
sessionOf(req, res)              the same, keeping the pair and the account id
logout(req, res)                 close at x-core, clear the cookie, answer where to go
jar(req, res)                    read and write this exchange's cookies

middleware.routes()              the six routes, and a pass-through for anything else
middleware.requireSession()      nothing behind it is served without an account
middleware.requirePermissions()  refuse unless every action is held
middleware.errors()              the last handler of the chain
middleware.account(req, res, …)  for a handler that ASKS rather than sits behind one

realtime.ticket(accessToken)     mint one: 32 bytes, 30 seconds, single use
realtime.attach(server)          hang the bridge on an existing HTTP server
follow({ accessToken, … })       a socket of one's own, following ONE account

permissions(req) actions(req) can(req, a) canAll(…) canAny(…) assert(…)
```

`sessionOf` is the whole of the server side in one call: it reads the sealed cookie, asks x-core, rotates when the access token has expired, seals the new pair back, compares `portail` against `global`, and answers the account as [session.json](session.json) or `null` when the session is over. **It never caches.**

`start()` not throwing is deliberate rather than lax. A boot that died because a token was spent, because the broker was not up yet or because the provider was still starting would take the whole application with it, including the pages that have nothing to do with the SSO and including whatever an operator would use to look at the problem.

## How it plugs in

The core runs on raw Node request and response objects - no `res.json`, no `res.redirect`, no `req.query` - so what sits above it is an adapter rather than a port.

| Entry point                                  | What it provides                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@gestionpratique/node-sso-consumer`         | the bridge, the middleware, the guards, the realtime bridge                            |
| `@gestionpratique/node-sso-consumer/client`  | the browser half: the socket, the ticket, the backoff, the heartbeat, the topics       |
| `@gestionpratique/node-sso-consumer/express` | declares `req.me`, `req.ssoTokens` and `req.ssoUserId` on the framework's request type |

Guides for [Express](../../guides/en/express.md), [NestJS](../../guides/en/nestjs.md) and [Nuxt 4 / Nitro](../../guides/en/nitro.md).

The browser half is not optional in spirit: an application that skips it has no realtime, therefore no revocation until somebody clicks.

## What it will not do

Decide anything about the application's own data. The gate it declares says who may come in at all; who may touch which invoice is the application's business, and always was.

Own a login page, a user table, a password, a reset flow or a session table. Those are what it replaces, not what it wraps. At `mode: "local"` it authenticates against a lent list, and even there the application owns only the SCREEN: the comparison, the seal and the session are the library's.

Open a Redis or a database. It is handed two functions for the credential and two for the store, and knows nothing else about either. It **does** open the broker connection, because a propagation queue carries credentials and no consuming application should have to wire one for something it never reads itself.

Cache the account, the profile or the rights. Not for a request, not for a second. That is the guarantee, not an implementation detail.

Speak to anything other than x-core. It knows x-core's routes, x-core's HMAC scheme, x-core's catalogue and x-core's realtime protocol, and there is no other implementation of any of them. Pointed at an OAuth2 or OIDC provider it does not degrade, it simply has nothing to talk to.
