# The two reference applications

Everything in this folder was read off two applications that already speak this protocol, in two different shapes. This is what each of them does, where they agree, and where one of them is the model and the other is the legacy.

|                    | `manager-infra`                                | `x-core/app_manager`                           |
| ------------------ | ---------------------------------------------- | ---------------------------------------------- |
| Shape              | a NestJS API and a Nuxt console, two processes | one Nuxt application, its server half is Nitro |
| Session held by    | the API                                        | the Nitro server                               |
| Interface talks to | the API, through a relay                       | its own server routes                          |

## Step by step

| #   | Step               | `manager-infra`                                                                  | `app_manager`                                                             |
| --- | ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Identity           | configured clientId                                                              | clientId written down in the service                                      |
| 2   | Credential         | delivered over a broker into its own store, receive-only                         | created and rotated by the application in a store shared with x-core      |
| 3   | Declaration        | `PUT config`, 5 attempts, 3 s apart, elected worker, **probe first**             | `PUT config`, 60 attempts, 2 s apart, not awaited, no probe               |
| 4   | Way in             | `sso/start`, `sso_state` for 10 min                                              | same, plus `sso_redirect` validated as a path of this app                 |
| 5   | Callback           | state compared, code exchanged with the browser's address and agent, pair sealed | identical                                                                 |
| 6   | On failure         | back to the way in with `?error=sso`                                             | identical                                                                 |
| 7   | Cookie             | sealed envelope, holds the pair **and a local session**                          | sealed envelope, holds the pair and the account id                        |
| 8   | Local state        | **a sessions table and an accounts table**                                       | **none**                                                                  |
| 9   | Liveness           | `GET /sso/me` on every guarded route                                             | `GET /sso/me` on every data route, sign-out and the account read excepted |
| 10  | Expiry             | rotate once, retry once                                                          | identical                                                                 |
| 11  | Rotation dedup     | keyed by refresh token                                                           | keyed by refresh token, **plus a re-read of the cookie when it loses**    |
| 12  | Sign-out           | close at x-core, revoke the local row, clear the cookie                          | close at x-core, clear the cookie                                         |
| 13  | Ticket             | 32 bytes, shared store, 30 s, GETDEL                                             | identical, byte for byte                                                  |
| 14  | Bridge             | on the API's own HTTP server, path matched exactly                               | the framework's WebSocket handler                                         |
| 15  | Topics followed    | `me-changed`, `me-signed-out`                                                    | the same two, **plus a registry** that subscribes per page                |
| 16  | Client-to-server   | none                                                                             | `revoke`, from the sessions screen                                        |
| 17  | On `me-signed-out` | clear the state **and call the sign-out route**, then leave                      | clear the state and leave; the cookie dies at the next request            |
| 18  | Reconnect on       | the session appearing                                                            | the session appearing, `online`, `focus`, `visibilitychange`              |
| 19  | Exit               | the portal                                                                       | its own login page                                                        |
| 20  | Permissions        | short form under one resource                                                    | full `resource:action`, with `isRoot` read explicitly                     |
| 21  | Page already open  | re-checked when the rights change                                                | not covered                                                               |

## What the two disagree about, and who is right

**Local state (row 8).** `app_manager` holds nothing, which is the model ([03-session-model.md](03-session-model.md)). `manager-infra` still carries a sessions table with an access window and a refresh chain of its own, and an accounts table. Its own code says the migration is not finished: there is no local sign-in any more, and a session carrying no x-core pair is already refused outright. **The library implements the first and drops the second.** A local session is precisely what cannot honour a revocation, because it would still be valid.

**Rotation dedup (row 11).** `app_manager` re-reads the cookie when its rotation loses, and it is right: losing a rotation is not proof the session is over, another worker may have won it. `manager-infra`'s version leaves a cluster uncovered.

> **The library took `manager-infra`'s.** It deduplicates in process, keyed by the refresh token, and reads a refused rotation as a session that is over - correct on one process, and on several it signs a reader out whenever two workers race the same expired token. The re-read is what would close that, and it is not there. Written down rather than quietly dropped from the table, because this file is what somebody reads to know what was decided.

**The probe (row 3).** Only `manager-infra` checks that the address really is x-core before declaring anything to it. It is the only protection against the silent failure this protocol invites. **The library keeps it, for everybody.**

**Signing out over the socket (row 17).** `manager-infra` calls its own sign-out route, which clears the sealed cookie and closes the session at x-core there and then. `app_manager` leaves the cookie to die at the next request, which happens to work because its guard reads the account on every navigation. **The library takes the explicit one:** it must not depend on somebody navigating.

**Reconnection and the page already open (rows 18 and 21).** Each application covers something the other does not. **The library takes the union.**

**Topic registry and `revoke` (rows 15 and 16).** `app_manager`'s is a superset of `manager-infra`'s two fixed topics. **The library takes the registry**, with THREE always-on topics outside it: `me-sessions` joined the two, because it is the only one that reports a session cut from the sign-ins screen.

## What must become configuration

Nothing in the list above is logic. These are the only real differences between the two integrations, and each becomes a value:

```
identity            the clientId this application signs as
provider            the API base, the login window, the socket's port
credential access   how to read the current secret hash, and how to store one
ticket store        where a 30 second single-use ticket lives
routes              where the way in, the callback, the sign-out and the ticket answer
declaration         callback, cancel URL, login template, the access gate
cookie              its name, its seal, whether Secure applies
exit                where a signed-out browser lands
election            whether this worker is the one that declares
liveness policy      which paths are checked
```

Everything else is the same code twice, and that is what the library is for.

## What the library does not take from either

The credential's own plumbing. One receives it over a broker, the other writes it into a store it shares with x-core, and both are deployment topologies rather than protocol. The library **reads a hash and asks for one to be stored**, and knows nothing about where either comes from ([08-library-contract.md](08-library-contract.md)).

The internal proxy that one of them signs its own API calls with, the tables the other keeps for its API keys and invitations, and the pages, menus and screens of both.
