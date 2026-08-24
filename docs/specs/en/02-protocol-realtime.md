# The realtime gateway

x-core's second transport, in front of the same services the HTTP routes call. It is what makes a permission revoked in another application land here in seconds rather than at the next click, and what closes an application the moment the SSO session behind it is ended somewhere else.

An application that consumes this SSO **keeps one socket open for the whole session**. It is not an optimisation and not a page feature: `GET /sso/me` on every request tells the server side that a session is over, but nothing tells the **page** in front of somebody, and a signed-in shell left on screen for an account the API already refuses is exactly what this closes.

## Where it is

Its **own port**, not the API's: a long-lived connection has no business sharing the pool the HTTP API serves requests from. Same host, same TLS material, one port further.

```
wss://<same host as the API>:<ws port>/realtime
```

The port is a deployment fact, not a protocol one: x-core defaults to `3002`, and a consumer reaching it through a published port meets whatever that port was published as. It is configuration, derived from the API's own base so a second address cannot drift from the first.

## The handshake

Signed **exactly like an HTTP call**: an upgrade request has a method, a path and headers, which is the whole of what the signature covers. It is a `GET` over an empty body, built the same way as any other call ([01-protocol-http.md](01-protocol-http.md)).

x-core verifies it in `verifyClient`, **before the upgrade completes**, so an unsigned dial is answered a plain HTTP `401` and never becomes a socket at all. The verification is the same chain the HTTP routes run: signature, clock skew, nonce replay, credential expiry, address allowlist, from the same credential store.

Outside production x-core bypasses this check, so a local stack is reachable without a signature. That is a property of the provider's deployment, and no reason for a consumer to sign less.

## The two credentials, answering two questions

The socket carries **two** identities, and they are not interchangeable:

- the **HMAC signature on the handshake** says which APPLICATION is connecting;
- the **SSO access token in the first frame** says which USER it is acting for.

Then the two are tied: the token must have been issued to the very application that signed the handshake, checked against the `x-client-id` header. Holding a valid token is therefore not enough to read it from somewhere else.

## The frames

One JSON object per frame, both ways.

Sent by the client:

| Frame                                                  | Effect                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `{ "event": "auth", "data": { "accessToken": "…" } }`  | names the user. **Required within 5 s**, or the socket is closed `4002` |
| `{ "event": "subscribe", "data": { "topic": "…" } }`   | starts one poller, for this socket alone                                |
| `{ "event": "unsubscribe", "data": { "topic": "…" } }` | stops it                                                                |
| `{ "event": "ping", "data": {} }`                      | answered `{ "topic": "#pong", "data": null }`                           |
| `{ "event": "revoke", "data": { "sessionId": "…" } }`  | ends one of the caller's OWN sign-ins                                   |

Sent by x-core:

```jsonc
{ "topic": "me-changed", "data": { … } }
```

`revoke` is the one thing this socket may change, and only the caller's own: the account comes from the authenticated socket and never from the frame, so a frame naming somebody else's session id reaches nothing. It answers nothing, by design. The updated list arrives as a pushed frame, which is the acknowledgement.

`ping` exists because a dead connection does not always raise a close event. A suspended tab or a NAT dropping its mapping leaves a socket half open, claiming to be open and delivering nothing. Answering a ping is what lets a client tell live from dead.

## The topics

A topic is a **poller**, run per socket, that publishes only when the JSON differs from the last frame it sent. Its interval is the watcher's own when it states one and `1 s` when it does not, with a `500 ms` floor - so the figures below are x-core's current settings rather than promises of the protocol. So an idle page costs one bounded query every few seconds and an unchanged one costs no traffic at all. Each is answered at once on subscription, so a subscriber never waits a full interval for its first frame.

| Topic           | Frame                                                            | Interval | What it is for                                                                                                   |
| --------------- | ---------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `me-changed`    | the whole account, the shape of [session.json](session.json)     | 3 s      | identity, profile, permissions and groups, pushed whenever any of them moves                                     |
| `me-signed-out` | `false` while it holds, `true` once                              | 1 s      | the session is gone: signed out of the SSO elsewhere, account deactivated, or access to this application revoked |
| `me-sessions`   | the account's sign-ins, 50 max, same shape the HTTP read answers | 1 s      | the sessions screen, subscribed only while it is mounted                                                         |

`me-changed` and `me-signed-out` are followed for the **whole session** and never unsubscribed, whatever page is showing and whether or not the window has focus. Both or neither: a state fed by `me-changed` alone is a cache, and a revoked account would keep walking around holding the last rights it was pushed.

**The frame is the new value.** It carries the account itself, so nothing re-reads `/sso/me` behind it. That is the entire point of the socket.

## Latency, stated honestly

Polling, not an event bus, and for a reason: the values published here are rows several services write, including expiries no code path touches, so "has it changed" is a question only the read can answer.

| What happens                                                               | How it arrives        | Within |
| -------------------------------------------------------------------------- | --------------------- | ------ |
| a permission granted or revoked, a group moved, a profile edited elsewhere | `me-changed`          | ~3 s   |
| the SSO session closed, the account deactivated, access revoked            | `me-signed-out: true` | ~1 s   |
| the same, seen from the gateway                                            | close `4003`          | ~10 s  |

Realtime here means one to three seconds depending on the topic: `me-changed` carries the whole account and is the expensive one, so it runs at three, while the end of a session runs at one. A library that promised the instant would be lying by a second at best.

## Revalidation, and why the close code matters

A socket outlives the token that opened it: consumer sessions rotate every quarter of an hour and the row a token resolved to is replaced each time. So the right to stay connected is re-asked against what does **not** rotate, on a ten second interval: the IdP session must still be alive and the account must still hold its access. The moment either is gone the socket is closed rather than left streaming to somebody the HTTP API already refuses.

| Code   | Meaning                                    |
| ------ | ------------------------------------------ |
| `4001` | unauthorized: the `auth` frame was refused |
| `4002` | the socket did not authenticate in time    |
| `4003` | the session or the access is gone          |

These are in the 4000-4999 range reserved for applications, and a client reads them to tell **"you are not welcome"**, where retrying is pointless, from a transport failure, where retrying with backoff is the right answer. A consumer that relays them must let them through unchanged: see [05-consuming-realtime.md](05-consuming-realtime.md).
