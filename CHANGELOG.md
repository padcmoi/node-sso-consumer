# CHANGELOG

## [Unreleased] - 2026-08-17

- Add `createXcoreBridge`, the single entry point linking an application to the x-core SSO
- Add the pairing service: install token redeemed once, credential written into the HMAC store, consumer configuration declared at every boot
- Add the auth service: session opening, token rotation with concurrent-call dedup, account read and permission checks
- Add the sealed session cookie (AES-256-GCM) and its cookie jar over raw Node headers
- Add the framework-agnostic middleware: the five SSO routes, the session guard, the permission guard and the error mapping
- Add the realtime client following each account, so a permission change lands within seconds instead of at the next navigation
- Add the browser WebSocket bridge: single-use tickets, signed upstream handshake, refusal of page-sent `auth` frames and close-code passthrough
- Add the provider address book, written down per environment rather than configured per deployment
- Document the package README and the Express and NestJS integration guides

## [0.0.0] - 2026-04-23

- First commit
