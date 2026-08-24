# The signed HTTP surface

Every call an application makes to x-core is signed, server to server. There is no `client_id` / `client_secret` pair, no discovery document, no JWKS and no OIDC: **the HMAC clientId IS the SSO identity**, and a route resolves the caller from the signature rather than from anything in the payload.

## The signature

Built by `buildHttpSignedHeaders` from `@naskot/node-hmac-auth-core`, over:

- the **method**,
- the **path including its query string**,
- a timestamp and a nonce,
- the **hash of the body**.

Three consequences, worth knowing before meeting them as a 401:

- signing a `POST` and sending a `PUT` fails, so the verb is a parameter and never a constant;
- the query is covered, which is what makes `GET /sso/me?accessToken=…` legitimate rather than a credential leaking into a URL;
- **headers are not covered**, which is why no credential ever travels in one.

A `GET` sends no body and signs over the empty string, which is what the verifier hashes on its side. A `DELETE` with no body does the same.

The secret itself never lives in the calling process. What is read from the credential store is the **hash** x-core computed, and the library signs from it with `secretIsHashed: true`. It is re-read on every call: a client built once at boot would keep signing with a credential that a rotation has already replaced.

## The routes

Base path `/api/v1`. `SsoMe` below is the shape of [session.json](session.json).

| Verb and path                              | Body or query                                                                       | Answers                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------- |
| `PUT /sso/consumer/config`                 | `{ redirectUri, cancelUri?, template?, dependGlobalRessource[], skipAccessCheck? }` | `204`                                  |
| `GET /sso/consumer/config?consumer=`       | reserved to the SSO front's identity                                                | `{ data: … }`, or `401` to anyone else |
| `POST /sso/consumer/session`               | `{ code, clientIp, clientUserAgent }`                                               | `{ data: SsoSession }`                 |
| `PUT /sso/consumer/session`                | `{ refreshToken, clientIp, clientUserAgent }`                                       | `{ data: SsoSession }`                 |
| `DELETE /sso/consumer/session`             | `{ refreshToken }`                                                                  | `204`                                  |
| `GET /sso/me?accessToken=`                 |                                                                                     | `{ data: SsoMe }`                      |
| `PUT /sso/me`                              | `{ accessToken, ...profilePatch }`                                                  | `{ data: SsoMe }`                      |
| `GET /sso/me/sessions?accessToken=&limit=` |                                                                                     | `{ data: SsoMeSession[], count }`      |
| `DELETE /sso/me/sessions/:id?accessToken=` |                                                                                     | `204`                                  |

`POST /sso/consumer/config` also exists and is **not** for an application: it provisions a credential and is gated to x-core's own credential-management identity.

### Declaring how the application plugs in

`PUT`, not `POST`: re-sending the same payload leaves the same row, and the row is keyed by the HMAC identity that signed, never named in the body. Nobody registers an application by hand, and changing its callback, its login screen or its access gate is a change in configuration that deploys like any other.

`dependGlobalRessource` is an **array, sent on every declaration, empty or not**. An optional field is only written when provided, so omitting it could set a gate and never clear one.

`redirectUri` is resolved server side from this row when a browser comes back. **No `redirect_uri` ever travels in a query**, which is what makes an open redirect impossible.

### Opening, rotating and closing a session

The three verbs carry their credential (the code, or the refresh token) in the **body**, which is what the signed payload hashes. Neither has any business in a URL: access logs, `Referer` and traces would keep it.

`clientIp` and `clientUserAgent` are the **browser's**, forwarded by the application. They travel on the rotation too, not only on the opening: rotating replaces the row x-core keeps, so without them every renewal files the session under the calling container's address, which is what the account's owner then reads on the portal's sessions screen.

Rotation is **single use**. The presented refresh token is spent and a new pair is issued, so what comes back must be sealed back or the session dies on the next request. See [04-lifecycle.md](04-lifecycle.md) for what that forces.

`SsoSession` is the pair plus who it is for:

```jsonc
{
  "accessToken": "…",
  "accessTokenExpiresAt": "…",
  "refreshToken": "…",
  "refreshTokenExpiresAt": "…",
  "user": { "id": "…", "email": "…", "displayName": "…", "avatarUrl": "…|null", "hasPassword": true },
}
```

The identity is the same object everywhere, here and under `me`. `hasPassword` says whether the account holds a local password: it is `false` for one opened through an external provider that has never set one, which is what tells a profile screen to ask for a new password without asking for a current one.

`DELETE` ends **this application's** session. The SSO session it descends from stays open, deliberately: signing out of one application is not signing out of the ecosystem.

### Reading and writing the account

`GET /sso/me` is the account, whole, recomputed on every read: identity, civil profile, permissions and groups. It is also the **liveness probe**, because the access token carries the IdP session it descends from and x-core refuses it once that session is closed.

`PUT /sso/me` writes the civil identity and answers the account **after** the write, so nothing needs a second read. The writable fields are the profile's own, minus what belongs to the identity provider (`locale`, the external subject id) and to the database (timestamps). An omitted field is left untouched; an explicit `null` clears it.

```
avatarUrl gender lastname firstname birthDate address address2
city postalCode country latitude longitude phone1 phone2
```

`gender` is a stable code, never a label: `mr`, `mrs`, `other`.

### The account's own sign-ins

`GET /sso/me/sessions` lists them, `DELETE /sso/me/sessions/:id` ends one. A row is named by its id, which grants nothing on its own: the session token never leaves x-core.

```jsonc
{
  "id": "…",
  "consumer": "…|null",
  "ip": "…|null",
  "userAgent": "…|null",
  "createdAt": "…",
  "expiresAt": "…",
  "revokedAt": "…|null",
  "lastSeenAt": "…|null",
  "active": true,
  "online": true,
  "current": false,
}
```

Both are reachable over the socket as well, and that is how an application should do it: see [02-protocol-realtime.md](02-protocol-realtime.md).

## Answers, and the one that is not an answer

`204` carries no body and must not be parsed. A non-2xx is a refusal to surface, never to swallow.

**A base that answers `204` to everything is the failure this protocol invites.** The API and the login window differ by a port, and a Nitro answers `204 No Content` to a route it does not know. An application pointed at the login window therefore declares itself successfully at every boot, logs its own success, and nothing exists on the other side until a sign-in fails weeks later.

The probe against it is one unsigned call:

```
PUT <apiBase>/api/v1/sso/consumer/config     with no signature
expect 401
```

`401` is the right answer, and the only one that proves the far side checks signatures at all. Anything else, including a success, means the address is not x-core and nothing may be declared to it.

The verb is the one the declaration itself uses, and no query is sent: what is being tested is whether the far side verifies signatures, and an unsigned call to a signed route is the whole of the question.

## The one route that carries no signature

`POST /api/v1/portal/install`, which redeems the install token. It is the moment before the application has an identity at all, so there is no signature to make and nothing yet to make it with: what authenticates it is the token, single-use, short-lived and minted for this application alone.

It is also what hands back the credential everything else signs with. Every other route consumed requires the signature.
