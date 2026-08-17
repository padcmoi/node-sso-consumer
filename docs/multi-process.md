# Running several processes

Everything below is about one thing: three pieces of this library keep state in memory, and memory is per process. One process needs none of it. Several - a cluster, a few replicas behind a relay, or a dev server that reloads on every change - need all three.

## 1) One worker declares, not all of them

```ts
createXcoreBridge({
  // ...
  bootstrap: { elect: () => redlock.tryAcquire("sso:boot", 30_000).then(Boolean) },
});
```

Declaring is idempotent, so several workers declaring the same thing is noise rather than a fault. **Pairing is not.** The install code is single-use: the second worker's attempt is refused, and its boot fails on a credential the first one has already written.

The election is asked once and covers both halves - asking twice would let a worker lose the pairing and win the declaration, which is a worker declaring with a credential it has not got yet.

A worker that loses skips both and serves normally. What it must NOT do is give up on booting: the declaration it skipped is one another worker is making.

## 2) A ticket minted anywhere must be spendable anywhere

```ts
import type { TicketStore } from "@naskot/node-sso-consumer";

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
