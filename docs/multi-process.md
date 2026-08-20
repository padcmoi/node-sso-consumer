# Running several processes

Everything below is about one thing: three pieces of this library keep state in memory, and memory is per process. One process needs none of it. Several - a cluster, a few replicas behind a relay, or a dev server that reloads on every change - need all three.

## 1) One worker declares, not all of them

The election belongs to the DEPLOYMENT, not to this library: it knows nothing of PM2,
of how many workers there are, or of how they are numbered. So it exposes two calls
instead of one, and the guard lives outside.

```ts
// Every worker: read the store. Without it none of them knows what it signs as,
// which cookie it opens, or what it declares.
await xcore.load();

// One worker: pair if it must, and declare.
if (process.env.NODE_APP_INSTANCE === "0") await xcore.start();
```

`start()` does `load()` itself, so a single-process application calls it alone and
nothing else.

Declaring is idempotent, so several workers declaring the same thing is noise rather
than a fault. **Pairing is not.** The install code is single-use: a second worker
racing the first is refused, and its boot fails on a credential the first one has
already written. That race only exists on the very first boot of a brand-new
application - after that `INSTALLED` is true and no worker looks at the code at all.

A worker that is not elected must NOT give up on booting: the declaration it skipped is
one another worker is making, and everything it needs to serve came out of `load()`.

## 2) A ticket minted anywhere must be spendable anywhere

```ts
import type { TicketStore } from "@gestionpratique/node-sso-consumer";

const tickets: TicketStore = {
  put: (ticket, accessToken, ttl) => redis.set(`sso:ticket:${ticket}`, accessToken, "EX", ttl),
  // Read AND remove in one move, or a ticket read twice is a ticket replayed.
  take: (ticket) => redis.getdel(`sso:ticket:${ticket}`),
};

createXcoreBridge({ /* ... */ realtime: { tickets } });
```

The page asks one worker for a ticket over an ordinary XHR, then opens a socket - which the relay is free to send to another. With the default in-memory store, that second worker has never heard of the ticket and closes with `4402`, the browser asks for another, and the loop is stable and silent.

`getdel` matters: a `get` followed by a `del` is two round trips with a window between them, which is the window a replay lives in.

The same applies to a dev server that restarts on every change - the process holding the ticket is gone by the time the socket arrives.

## 3) The followed accounts are per process, and that is fine

`SsoLiveAccounts` holds one socket per account, in the worker that resolved a request for it. Four workers holding a session for the same reader hold four sockets, and each is corrected by the provider within seconds of any change.

There is nothing to share here and nothing to configure. What it costs is one socket per account per worker; what it buys is a read that costs no round trip. An application that would rather not pay it turns the following off, and every read asks the provider again:

```ts
createXcoreBridge({ /* ... */ live: { enabled: false } });
```

The `staleAfterMs` ceiling (five minutes by default) is what re-proves a session when nothing has changed, so a followed account is never served indefinitely from what was pushed.

## 4) What needs nothing

The sealed cookie. It carries the session whole - the account id and the token pair - so any worker reads it without asking any other, and there is no session store to share, expire or migrate. That is the reason there is no Redis in the list above for the session itself.
