# The lifecycle

Five moments, from a process starting to a reader being signed out by another application. Everything here is server side; the browser's half is [05-consuming-realtime.md](05-consuming-realtime.md).

## 1. Boot: declare, then serve

At every boot, once, the application declares to x-core how it plugs in:

```
PUT /api/v1/sso/consumer/config
{ redirectUri, cancelUri, template, dependGlobalRessource: [] }
```

Idempotent, keyed by the signing identity, so nothing is registered by hand and moving a callback is a deployment rather than an operation.

**Probe first.** An unsigned `PUT /sso/consumer/config` must be refused with `401`. Anything else means the address is not x-core, and nothing is declared: a `204` from something else reads as a success, and the application then boots perfectly and refuses every sign-in afterwards ([01-protocol-http.md](01-protocol-http.md)).

**Retry, loudly.** The credential may arrive over a broker in the same boot, and the provider's own API is not listening the instant its container exists. A first attempt landing on a closed port is the ordinary case, not the exception. So the declaration retries on anything that looks like "not up yet", fails fast on a `4xx` (that is this side's payload being wrong, and no amount of waiting fixes it), and says so in the log if it never succeeds. A declaration that failed silently is an afternoon of tracing back a sign-in that 404s.

**One worker declares.** Several would send the same idempotent `PUT`, which is harmless and still noise in x-core's audit. Election belongs to the deployment, which knows how many workers there are and how they are numbered; the library takes the answer, it does not compute it.

**Never awaited by the boot.** A registration that can legitimately take a minute must not be what decides whether the server listens.

## 2. Sign in: the round trip

The application offers one way in and no login screen. It does not sign anybody in; the portal does, and it is the only thing that does.

```
GET <app>/…/sso/start
  set-cookie  <session cookie>_state=<uuid>   httpOnly, secure, lax, path=/, 10 min
  302 -> <ssoFront>/authorize?consumer=<clientId>&state=<uuid>
```

The state cookie is named after the session cookie, which is itself derived from the identity: two applications under one host cannot collide on it any more than they can on the session itself.

`state` is the CSRF protection of the round trip and nothing else: compared on return, then dropped. `lax` so it survives the redirect back.

**No `redirect_uri` travels.** x-core resolves it from the declaration, which is what makes an open redirect impossible.

**Nothing else is remembered.** The state cookie is the whole of what the round trip carries, and every successful sign-in lands on `routes.afterLogin`. A reader who followed a deep link arrives on the application's front page rather than where they were going.

That is a deliberate floor rather than an omission: the alternative is a stored path, and a stored path is attacker-controlled text. An application that wants the deep link back keeps it itself, and owes the validation that goes with it - one leading slash, never `//host` (a protocol-relative URL leading off-site), and never the sign-in routes themselves, which would restart the round trip this ends. Kept on this side and never carried through x-core: a target travelling in a query across two hosts is a target anyone can rewrite.

```
GET <app>/…/sso/callback?code=&state=
  compare state with the cookie, clear the state cookie
  POST /api/v1/sso/consumer/session { code, clientIp, clientUserAgent }
  seal the pair into the session cookie
  302 -> routes.afterLogin, or /?error=sso when anything failed
```

`clientIp` and `clientUserAgent` are the **browser's**, forwarded explicitly: the exchange is a server-to-server call, so x-core would otherwise record this container as the reader, and that is what the account's owner reads on the portal's sessions screen.

**Every failure lands back on the way in**, never on an error page: a missing state, a mismatched one, a code already spent or expired are all things a reader should simply be able to try again. A lost cookie is a retry, not an incident.

## 3. Every request: liveness

A consuming session may not outlive the SSO session it descends from. So on every request carrying one:

```
read the cookie -> GET /sso/me?accessToken=…
  answered   -> the reader is here, with the account this request will use
  refused    -> rotate once, retry once
  refused    -> the session is over. Clear the cookie.
```

No cache in between, ever. That is the whole of "no consumer outlives the SSO session": a cookie still within any window of its own is worth nothing if the account signed out at the portal or lost its access, and asking is the only way to know, because nothing over there calls back.

A session carrying **no** token pair is refused outright rather than tolerated. There is no way to open one without x-core any more, so what holds one is a cookie sealed by an older shape, and honouring it is exactly the forced access this check exists to close. Its holder signs in again, which costs a click.

Which requests are checked is a policy, not a rule: an application checks the routes that serve data, and page requests reach the same guarantee through the data they load. The sign-out route must stay reachable with a session x-core has already dropped, or the local cookie could never be cleared. The route that resolves the account is that same check, so running it twice for one request is waste.

## 4. Rotation, and the trap in it

The access token is short lived, so a refusal is **first treated as an expiry**: rotate the pair and retry once. A genuine revocation fails the rotation too, and then the session is over for good. That is what makes an expiry invisible and a revocation immediate, with one code path.

Rotation is single use: x-core invalidates the presented refresh token and issues a new pair.

**Concurrent callers must share one rotation.** A page loading two resources at once holds the same cookie twice, therefore the same refresh token twice. Without dedup the second call spends a token the first has already consumed, is refused, and the session is cleared although it is perfectly alive. It happens constantly rather than rarely: every tab regaining focus fires several requests the moment the access token has expired. Rotations in flight are therefore keyed by the refresh token being spent, and everybody waiting receives the one result.

**The dedup is per process, and a refused rotation ends the session.** The in-flight map lives in the worker that holds it, so on ONE process it has seen every rotation there was: a refusal there really does mean the refresh token is spent for good, and clearing the cookie is the right answer.

Across several workers it is not. Another worker may have won the rotation, which invalidates this copy of the refresh token while the session stays perfectly alive - and this side reads that as a session that is over. In practice it signs a reader out whenever two workers race the same expired token, which is what a tab regaining focus produces.

**So a deployment that runs several workers of one application shares nothing here and cannot.** What it can do is keep the number of processes that resolve sessions to one, or accept the occasional forced sign-in. See [Running several processes](../../guides/en/multi-process.md).

**The new pair must be sealed back**, on every response that waited for it, or the session dies on the next call. Whichever response reaches the browser last is the one that decides what it keeps.

## 5. Sign out

```
DELETE /api/v1/sso/consumer/session { refreshToken }   best effort
clear the cookie                                       always
```

Failure over there is not worth refusing a sign-out over: the cookie is cleared either way and what is left expires on its own. Closing it properly is what stops the portal's sessions screen from listing a session nobody holds any more.

This ends **this application's** session only. The SSO session it descends from stays open, deliberately, and the reader stays signed into the portal and the other applications. The reverse is not symmetric, and that is the point: closing the SSO session closes this one too, because this one descends from it.

Where the browser goes afterwards is one address, and it is the same exit seen from three sides: a reader who signs out, a session refused because it is over, and a session revoked from somewhere else all land on the portal, which is the only thing in this ecosystem that signs a human in. An application with a login page of its own sends them there instead. It is configuration, and the only reason it is not written down here.
