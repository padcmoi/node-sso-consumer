# x-core SSO consumer, specified

What an application has to do to **be** a consumer of the x-core SSO. Written down before any of it was implemented as a library, and kept since as the reason behind what the library does.

Nothing here is designed. Every rule below was read off three sources and is quoted with its origin, so a disagreement between this folder and the code is a bug in this folder:

| Source                                                        | What it settles                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `x-core/src/api/v1/sso/**` and `x-core/src/core/websocket/**` | the protocol, both ends of it. It is the authority and the only implementation              |
| `manager-infra/` (NestJS API + Nuxt console, two processes)   | one integration shape: the session lives in an API, the interface is a separate application |
| `x-core/app_manager/` (Nuxt + Nitro, one process)             | the other shape: the session lives in the framework's own server half                       |

The two applications implement the same protocol twice. What differs between them is never the logic: it is an identity, a store address, a route path, an exit URL. That is the whole reason a library is possible, and the list of what must become configuration is in [07-reference-apps.md](07-reference-apps.md).

## The specifications

| #   | File                                              | What it covers                                                                   |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| 01  | [protocol-http.md](01-protocol-http.md)           | the signed HTTP surface: signature scheme, every route, every payload            |
| 02  | [protocol-realtime.md](02-protocol-realtime.md)   | the WebSocket gateway: handshake, frames, topics, latency, close codes           |
| 03  | [session-model.md](03-session-model.md)           | the session lives in x-core. What the application holds, which is one cookie     |
| 04  | [lifecycle.md](04-lifecycle.md)                   | boot declaration, sign-in round trip, per-request liveness, rotation, sign-out   |
| 05  | [consuming-realtime.md](05-consuming-realtime.md) | the ticket, the bridge and the browser client an application needs to receive it |
| 06  | [permissions.md](06-permissions.md)               | the rights x-core answers, and what an application may and may not do with them  |
| 07  | [reference-apps.md](07-reference-apps.md)         | what the two applications do, step by step, and where they diverge               |
| 08  | [library-contract.md](08-library-contract.md)     | the surface the library exposes, and what it refuses to own                      |
| 09  | [invariants.md](09-invariants.md)                 | the rules that cannot be broken, and what breaking each one looks like           |

[session.json](session.json) is the payload the account is read as. Every document that names a field means a field of that file. **The values in it are fabricated** - the shape is what it documents, and a live capture has no business shipping in a package.

## Three places where the ground is the application's

The library exists now, and it draws its line short of three rules written here. That line is where it is on purpose, and each document says what the library does rather than what it fails to do - but the rules stay, because they are still the rules whoever covers that ground has to write against.

| Ground                            | Where                                                                     | What the library does                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| The return path after a sign-in   | [04](04-lifecycle.md), [09](09-invariants.md)                             | keeps none, and lands every sign-in on `routes.afterLogin`. An application that wants the deep link back stores it, and owes the validation       |
| A rotation lost to another worker | [04](04-lifecycle.md), [07](07-reference-apps.md), [09](09-invariants.md) | deduplicates in process and reads a refused rotation as a session that is over. Right on one process; on several it forces the occasional sign-in |
| Where a realtime ticket waits     | [05](05-consuming-realtime.md), [09](09-invariants.md)                    | holds it in memory, which is right for one process. More than one hands a shared store through `realtime.tickets`                                 |

Two things arrived after these documents were first written and are folded in: `permissions.portail`, which is the door answered back with every `me` ([06](06-permissions.md)), and `me-sessions`, the third always-on topic, which catches the one ending the other two cannot report ([05](05-consuming-realtime.md)).

## Where to go for how, rather than why

This folder says what the protocol is and why. [The service file](../../guides/en/service.md) says how to write it, option by option, with what the store holds. The [integration guides](../../guides/en/) say how to mount it under Express, NestJS and Nitro, and the [sequence diagrams](../../diagrams/) draw the socket end to end.

## The one sentence the rest expands

An application consuming this SSO holds **no user table, no session table, no permission table, no password, no login page and no cache**. It holds one sealed cookie carrying a token pair that x-core issued, it asks x-core who the reader is on every request, and it keeps a WebSocket open for the whole session so a change made in another application lands in seconds rather than at the next click.
