# The session lives in x-core

The rule this whole library exists to enforce, in one line:

> **The application holds nothing.** One sealed cookie carrying a token pair x-core issued, and that is the entire local state of a signed-in reader.

No user table, no session table, no permission table, no password column, no reset flow, no login page, no cache. Not "as little as possible": none.

## Why there is nothing to keep

Two guarantees follow from holding nothing, and neither survives a local copy.

**A revocation lands on the very next call.** The account, the profile and the rights are asked of x-core on every request, so an account signed out at the portal, disabled, or stripped of its access to this application stops being answered here immediately. A local session row cannot do that: it would still be valid, and honouring it is precisely the forced access this model closes. There is nothing to invalidate and no webhook to expose.

**Nothing personal exists to drift or to survive a deletion.** An email changed in another application is already the value the next read answers. A copy would be a second truth, and the second truth always wins by accident.

## The cookie

The single local artefact. What it carries:

```jsonc
{
  "userId": "00000000-0000-4000-8000-000000000001",
  "tokens": {
    "accessToken": "…",
    "accessTokenExpiresAt": "…",
    "refreshToken": "…",
    "refreshTokenExpiresAt": "…",
  },
}
```

The account id is there so a request knows whose session it is without a round trip; everything else about the person comes from `GET /sso/me`.

What is **never** in it: an email, a name, an address, a permission, a role, an avatar, a local session id, a local refresh token, an expiry of the application's own.

### Its name belongs to x-core

```
sso_${clientId.replace(/[^A-Za-z0-9]/g, "_")}
```

`oauth-x-facturation` becomes `sso_oauth_x_facturation`. Underscores throughout, nothing else, because a cookie name is an RFC 6265 token where a dash would be legal but half the ecosystem already writes these names with underscores, and one name spelled two ways is the difference nobody notices until a session is read from the wrong jar.

It is **derived from the identity, and answered by x-core rather than guessed on this side**. Two applications served under one host would otherwise both write the same name and sign each other out on every navigation, silently, since from each one's point of view the cookie is simply absent.

### Its seal belongs to the application

AES-256-GCM, over an envelope `{ id, createdAt, data }`, with a password that is the application's own and comes from nowhere else. It is minted at the first boot and kept in the application's key/value store, never received from x-core: two applications sharing one could open each other's cookies, while each already holds its own revocable session over there. Deleting the key signs everybody out at once and the next boot mints a new one, which is a tool rather than a fault.

A cookie that does not unseal is a cookie from another password or another process. It reads as "no session", never as an error, because that is what it means to whoever is holding it.

### Its flags

```
httpOnly   the page must never read the pair
secure     production only: a Secure cookie is dropped over the plain HTTP dev serves
sameSite   lax, so it survives the redirect back from the SSO
path       /
ttl        none on the seal
```

**No ttl, deliberately.** x-core expires the session, not the cookie. A cookie carrying a pair x-core has finished with opens nothing, and an expiry of the application's own would be a second clock to disagree with the first.

## What the reader's page is given

The answer of `GET /sso/me`, which is [session.json](session.json): the account under `user`, the civil profile, the permissions with their groups, and the account's fields flattened at the root so a component reads `displayName` without walking an envelope.

```jsonc
{
  "user":        { "id": "…", "email": "…", "displayName": "…", "avatarUrl": "…", "hasPassword": true },
  "profile":     { "gender": "mr", "firstname": "…", "city": "…", … },
  "permissions": { "global": ["core:access", …], "isRoot": true, "groups": [ … ] },
  "id": "…", "email": "…", "displayName": "…", "avatarUrl": "…"
}
```

**The token pair is not in it and must never be.** A refresh token is a password with a month of life, and anything a page can read, anything running on that page can take. The socket is opened with a ticket rather than with a credential precisely so the page never has to hold one.

The page keeps this value for the length of a page load, fed afterwards by the socket ([02-protocol-realtime.md](02-protocol-realtime.md)). It is not persisted: a store written to `localStorage` would be a session that outlives the one it mirrors, which is the thing this model forbids.

## The one thing an application still owns

Its own data, and who may touch which row of it. The gate declared to x-core says who may come in at all; whether this reader may edit that invoice is the application's business, and always was.
