# CHANGELOG

## [Unreleased] - 2026-08-17

- Add `createXcoreBridge`, the single entry point linking an application to the x-core SSO
- Add the pairing service: `install()` sends the pairing code to x-core's dedicated route, which creates the AMQP queue, records the SSO consumer config, mints the HMAC credential and withdraws the code; the secret comes back and is written into the injected credential store
- Add the auth service: session opening, token rotation with concurrent-call dedup, account read and permission checks
- Add the sealed session cookie (AES-256-GCM) and its cookie jar over raw Node headers
- Add the framework-agnostic middleware: the five SSO routes, the session guard, the permission guard and the error mapping
- Add the realtime client following each account, so a permission change lands within seconds instead of at the next navigation
- Add the browser WebSocket bridge: single-use tickets, signed upstream handshake, refusal of page-sent `auth` frames and close-code passthrough
- Add the provider address book, written down per environment rather than configured per deployment
- Add `@naskot/node-sso-consumer/client`, the browser half: it reads the session, asks for a ticket, dials this host's socket, reconnects and tells a session that is over from a connection that dropped
- Add `@naskot/node-sso-consumer/express`, imported once for its effect, declaring `req.me` / `req.ssoTokens` / `req.ssoUserId` on the framework's own request type
- Add `live.onAccount` and `live.onSignedOut`, so what the provider pushes reaches a store the library knows nothing about, and `follow()` for a socket of one's own on one account
- Add `bootstrap.elect`, so one worker out of several pairs and declares - the install code is single-use, and a second worker's attempt is refused
- Add `jar()`, the cookie jar of one exchange, for a handler that needs the sealed session rather than the account
- Add the test suite: 107 tests over the sealing, the signed channel, the pairing, the rotation and its dedup, the session, the guards, the tickets and the bridge
- Add `installQueue`, required by an application whose clientId carries a dot, an underscore or a colon: a queue name may not, so such an identity names its own rather than being silently renamed
- Document that this library is proprietary to x-core and runs against nothing else, in the README and at the head of every guide
- Document the package README, the installation guide, the Express, NestJS and Nuxt/Nitro integration guides, and running several processes

## [0.0.0] - 2026-04-23

- First commit
