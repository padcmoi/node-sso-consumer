# Consuming the realtime

[02-protocol-realtime.md](02-protocol-realtime.md) is what x-core serves. This is what an application has to build to receive it, and every piece of it exists for a reason that is not negotiable.

## Why the browser cannot dial x-core itself

Two reasons, and either one alone is enough:

- the HMAC signature the handshake needs is a **server secret**;
- a WebSocket is **not bound by the same-origin policy**. Any page on the internet can open one to this host and the browser will attach the session cookie to it, so the cookie must not be what opens a socket.

So there are three hops instead of one: the page asks for a **ticket** over its authenticated session, dials **this application's** socket with it, and this application dials x-core. The account behind a socket is decided by the ticket that opened it and never by what the page sends afterwards.

## The ticket

```
POST <app>/…/realtime-ticket        authenticated like any other route
-> { ticket }                        32 random bytes, base64url
```

Held against the access token it stands for, with a **30 second** expiry: the time between asking for a ticket and dialling a socket, and nothing more. A ticket is not a session.

Read AND removed in one move, so it is consumed by whoever gets there first and a replayed handshake finds nothing. Where that store is and how it spells its keys is the application's business - a Redis `GETDEL` is the obvious shape, and the library only ever calls `take`.

**In memory by default, and shared when there is more than one process.** The store is `put(ticket, accessToken, ttlSeconds)` and `take(ticket)`, where `take` reads AND removes - a ticket read twice is a ticket replayed.

The default holds them in the process that minted them, which is exactly right for one: nothing to configure, nothing to run alongside. It is wrong the moment there are two, because a ticket minted by one worker has to be spendable by the other, and in development it also has to survive a server reload between the mint and the dial. Both cases hand a shared store through `realtime.tickets`. See [Running several processes](../../guides/en/multi-process.md).

Getting it wrong is not silent, and it is not fatal either: the second worker has never heard of the ticket, closes with `4402`, the page asks for another, and the loop is stable - a socket that reconnects for ever and never carries a frame.

The access token stays server side throughout: the ticket stands for it, and the browser never holds a credential. Asking for it is an ordinary XHR, which CORS does protect, and that is the whole reason a ticket exists rather than the cookie opening the socket.

## The bridge

One socket from the page, one socket to x-core, and a queue between them.

```
upgrade
  read ?ticket=, spend it. No token -> refuse before the upgrade completes
open
  sign the handshake, dial x-core
  on open: send { event: "auth", data: { accessToken } } FIRST, then flush the queue
page -> x-core
  forward every frame, EXCEPT any frame whose event is "auth"
x-core -> page
  forward verbatim
close
  map the code, close the other side, drop the bridge
```

**The queue is not an optimisation.** The page subscribes the instant its own socket opens, which is before the upstream one is up. Without it those frames are dropped and the page waits for topics it believes it asked for.

**`auth` is refused from the page, always.** It is the frame that names the account, and it is this end's alone. A page allowed to send it could name somebody else.

**Identity travels first**, before anything the page asked for: x-core closes a socket that has not authenticated within five seconds.

**Close codes are mapped, not passed blindly.** `1000` and the `4xxx` range travel through, because they mean "do not retry, sign in again" and a client cannot infer that from a transport failure any other way. Everything else becomes `1011`: several `1xxx` codes, `1006` above all, are the runtime's to set and cannot legally be sent back out.

A note on where the upstream sits. When the application reaches x-core over an internal address while the certificate names the public one, the dial has to be told so explicitly. That is a deployment fact and belongs in configuration; it is never a default, and never a reason to stop verifying elsewhere.

Where the bridge is mounted is the application's business: an existing HTTP server's `upgrade` event, or the framework's own WebSocket handler. If it shares a server with other sockets, its path is matched **exactly**. A path that is a prefix of another means two handlers answer one upgrade, the second `handleUpgrade` throws out of a promise nobody can catch, and that is an unhandled rejection, which is the worker gone and restarted for as long as anybody opens that page.

## The browser client

Opened once the page knows it is signed in, re-opened if that changes, and held for the **whole session** whatever page is showing.

```
connect
  ask for a ticket. Refused -> retry on the same backoff, do not give up
  open ws://<this host>/<bridge path>?ticket=…
  on open: subscribe to me-changed, me-signed-out and me-sessions,
           plus whatever the page asked for
frames
  #pong                  ignored, but it counts as a sign of life
  me-changed             the account, written straight in. No HTTP read behind it
  me-signed-out === true sign out, now
  me-sessions            the account's own sign-ins. See below
  anything else          the page's data, for whoever declared an interest
close
  4001 / 4002 / 4003     sign out. Retrying earns the same answer
  4402                   the ticket was spent or expired. Dial again AT ONCE,
                         with a fresh ticket and no backoff
  anything else          reconnect, backoff 1 s doubling to 30 s
```

**Three always-on topics, not two.** `me-sessions` is the third and it is what makes one revocation land: the provider computes `me-signed-out` from the IdP session and the account's access, and ending ONE application's session from the sign-ins screen moves neither. So that frame never comes and the page keeps painting. The provider already marks the caller's own row `current` in the list, so nothing had to be added anywhere.

It is read latched, and it has to be: a socket with no row to match would read "none is mine" from its very first frame and sign everybody out. It means something only once a row HAS been seen and then goes - and even then the answer is confirmed rather than acted on, by ONE read of `/session`, because rotation replaces the row every fifteen minutes and a frame read in the gap shows no row of ours while the session is perfectly alive.

**`4402` is the consuming application's own code, not x-core's.** It says the ticket was spent or expired, which is not a session that is over: the next ticket is minted by a route that asks the provider the same question the reads do, and will refuse it if the session really has ended.

**Heartbeat.** A ping every 25 s, and a socket silent for 60 s is closed as dead. The silence check runs **only while the tab is visible**: a hidden tab has its timers throttled to about one firing a minute, so the check would read a silence that never happened and hang up a healthy socket, precisely when a pushed change matters most, since nothing else is going to ask.

**Reconnect at once on `online`, on `focus` and on `visibilitychange`.** Coming back to a tab is exactly when a dead connection gets noticed, and waiting out a backoff there is a page that stays stale for half a minute in front of somebody.

**A fresh ticket per attempt.** A spent one is refused, so a reconnect cannot replay the first.

**Topics are declared, never dialled.** A component says it is interested, the client subscribes and unsubscribes to match, and a topic nobody watches costs nothing on either side. `me-changed`, `me-signed-out` and `me-sessions` are outside that mechanism: all three are subscribed on open and never released.

**Sending is best effort.** The one client-to-server action beyond subscribing is ending a session, and the authoritative state comes back as a pushed frame rather than as a reply. A message fired while the socket is down is dropped, which shows up as "nothing changed" and is retried by the reader, rather than being silently believed to have worked.

## Signing out, in full

`me-signed-out: true` and the fatal close codes are the same event seen twice, and both do the whole thing:

1. stop the client, so nothing reconnects into a session that is over;
2. drop the account the page is holding;
3. **call the application's own sign-out route** and let it clear the sealed cookie and close the consumer session at x-core. A WebSocket has no response to write a cookie onto, so this is the only way the server-side half dies now rather than at the next request;
4. leave, to the portal or to the application's own login page.

A frame landing after a sign-out must not put an account back: the account is only applied while a session is held.

## What the page does with a change

The frame replaces what the page holds, whole. A permission removed in another application is gone here within seconds, with nothing to invalidate.

That is not enough on its own. A route guard runs when a route is **entered**, so a right revoked while somebody sits on the page it opens takes the menu entry away and leaves the page itself standing, offering an action the API now refuses. So the same question is asked again whenever the answer can have moved: when the rights change, and when the route does. See [06-permissions.md](06-permissions.md).
