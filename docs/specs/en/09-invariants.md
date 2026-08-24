# Invariants

The rules that cannot be broken, each with what breaking it looks like. Most of these were paid for once already.

Three of them are the application's to hold rather than this library's, and each says so where it stands: the return path and its validation, which this library does not keep at all; the cookie re-read when a rotation loses, which it does not do; and the ticket store, which is shared only when a deployment hands one over. What the library does is written under each - the rule stays, because it is still the rule whoever covers that ground has to write against.

## Credentials

**The secret never enters this library, and the hash is re-read on every call.** A signer built once at boot keeps signing with a credential a rotation has already replaced: every call answers `401`, the clientId still exists and the store looks perfectly healthy.

**The pepper must be x-core's own value.** A different one turns a credential that arrived perfectly into a `401` on every call, indistinguishable from a credential that never arrived.

**A missing credential is not a bad credential.** "Nothing has been propagated yet" is a state at boot, not a failure, and it deserves its own sentence in the log. Otherwise the hunt starts against the signature instead of against the queue.

## Addresses

**Probe before declaring.** The login window answers `204` to anything it does not know, so an application pointed at it declares itself successfully at every boot while nothing exists on the other side. The unsigned call that must be refused `401` is the only protection.

**A declaration that failed must be loud.** An application that failed to declare boots perfectly and refuses every sign-in afterwards. That is the failure that costs an afternoon.

**Never guess the callback from a request header.** It is derived from the configured address, or there is no address to register.

## The round trip

**No `redirect_uri` in a query, ever.** x-core resolves it from the declaration. A target travelling in a browser query is an open redirect.

**A return path is validated as a path of this application.** One leading slash, never `//host`, never the sign-in routes themselves. A stored path and a query are both attacker-controlled text.

> **What the library does:** it keeps no return path at all and sends every sign-in to `routes.afterLogin`. There is nothing to validate because there is nothing stored. An application that adds one takes this rule with it.

**Forward the browser's address and agent**, on the opening **and** on every rotation. Without it x-core files the session under the calling container, and that is what its owner reads on the portal's sessions screen.

**A failed sign-in goes back to the way in, not to an error page.** A reused code, an expired one or a lost cookie are all things a reader should be able to simply try again.

## The session

**The application holds nothing.** A local session row is a session that survives a revocation, which is the one thing this model exists to prevent.

**Nothing is cached, not even for a request.** The account, the profile and the rights are asked on every request. That is the guarantee.

**A session carrying no token pair is refused outright**, not tolerated. It is a cookie from an older shape, and honouring it is forced access.

**The cookie name is derived from the identity.** Two applications under one host that both write the same name sign each other out on every navigation, silently, since from each one's point of view the cookie is simply absent.

**`Secure` is production only.** A Secure cookie is dropped by the browser over the plain HTTP development serves, which reads as "the session never opens".

**No ttl on the seal.** x-core expires the session; a second clock can only disagree with the first.

**The sealing password is the application's own.** Two applications sharing one could open each other's cookies.

## Rotation

**Concurrent rotations share one result.** Rotation is single use: without dedup the second request spends a token the first consumed, and a perfectly live session dies. It happens on every tab that regains focus, not rarely.

**Losing a rotation is not proof the session is over.** Re-read the cookie: a different token is another worker's win, and the session is alive.

> **What the library does:** it deduplicates in process and reads a refused rotation as a session that is over. Correct on one process; on several it signs a reader out whenever two workers race the same expired token.

**The new pair must be sealed back on every response that waited for it.** Whichever response reaches the browser last decides what the browser keeps.

**One retry, never a loop.** An expiry is invisible after one rotation; a revocation fails the rotation too, and then it is over.

## The socket

**The page never holds a credential.** A WebSocket is not bound by the same-origin policy, so the cookie must not be what opens one. A ticket, 30 seconds, single use, read-and-remove, in a **shared** store.

> **What the library does:** the ticket, its 32 bytes, its 30 seconds and its single use are all enforced. The store defaults to memory, which is correct for one process - a deployment with more hands a shared one through `realtime.tickets`.

**The `auth` frame from a page is refused.** It names the account, and that is decided by the ticket that opened the socket.

**Identity is sent before anything else.** x-core closes a socket that has not authenticated within five seconds.

**Close codes are mapped.** `1000` and `4xxx` travel through, everything else becomes `1011`: `1006` and its neighbours are the runtime's to set and cannot legally be sent back out. A client that cannot tell "sign in again" from "the network blinked" either retries for ever or gives up wrongly.

**Frames sent before the upstream is open are queued.** The page subscribes the instant its own socket opens, which is first.

**The silence check runs only while the tab is visible.** Background timers are throttled to about one firing a minute, so it would read a silence that never happened and hang up a healthy socket, exactly when a pushed change matters most.

**A socket path is matched exactly.** A path that is a prefix of another means two handlers answer one upgrade, the second throws out of an uncatchable promise, and the worker restarts for as long as anybody opens that page.

**All three always-on topics, or none.** A state fed by `me-changed` alone is a cache, and a revoked account keeps the last rights it was pushed. `me-signed-out` is what tears it down, and `me-sessions` is what catches the one ending neither of the other two reports: a session cut from the sign-ins screen, which moves neither the IdP session nor the account's access.

**A frame arriving after a sign-out must not put an account back.**

## Rights

**Hiding is not enforcing.** The page hides what the API would refuse; the API refuses. Both jobs exist, and neither replaces the other.

**`dependGlobalRessource` is sent on every declaration, empty or not.** An optional field is only written when provided, so omitting it can set a gate and never clear one.

**A refused page answers `403`, never a redirect.** The reader is signed in; sending them to the portal loops them straight back with the same rights.

**The page already open is re-checked when the rights change.** A guard runs on entry, and the case that matters is somebody sitting on the page when the right disappears.

**Never expose the token pair to a page.** A refresh token is a password with a month of life, and anything a page can read, anything running on that page can take.
