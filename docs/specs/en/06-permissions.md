# Permissions

x-core answers what an account may do with every read of `GET /sso/me`, recomputed on that request. An application stores none of it, and holds no opinion of its own about who may do what.

## The shape

```jsonc
"permissions": {
  "global": ["core:access", "example:view-records", "example:create-records", …],
  "isRoot": true,
  "groups": [{ "id": "…", "name": "…", "description": null }],
  "portail": ["example:access"]
}
```

`global` is a flat list of `resource:action` strings. `resource` names an application or a domain of the ecosystem, `action` what may be done in it.

`groups` sits **inside** `permissions` rather than beside them: they are where the rights come from, granted through a group and nowhere else, so a reader of one always holds the other.

`isRoot` is answered upstream of the list. A root account comes back holding the whole catalogue, so an ordinary lookup already covers it and no check needs a special case. It is worth reading for one thing only: a gate must never be able to lock root out of the console that repairs the gate.

An object rather than a bare array because x-core keeps room there for a second tier. Reading `.global` means a key added later costs nothing on this side.

## Two gates, and they are not the same one

**The door**, declared once by the application as `dependGlobalRessource` and checked by x-core: the global resources an account must hold `access` on before x-core hands this application a code at all. It is re-checked on every call that keeps the session alive, `/sso/me` included, so an account whose access is revoked stops being answered on its next call without this side holding a list.

**What may be done once inside**, which is the application's own affair, page by page and route by route.

An application declaring `["core"]` says "holding `core:access` is enough to open me". An application declaring `[]` says "anyone the SSO signs in may enter". The list is sent on every declaration, empty or not, because an omitted optional field is never written: omitting it could set a gate and never clear one.

### The door, answered back: `permissions.portail`

The gate is not only checked over there. x-core answers what THIS application requires alongside what the account holds, in the same breath, and the door is then one comparison:

```
permissions.portail  ⊆  permissions.global
```

Both speak `resource:action`, so it is a subset test with nothing to parse, split or namespace. An empty `portail` requires nothing and admits everybody, which is the common case and stays cheap. Root needs no exception: it comes back holding the whole catalogue, so the subset holds by construction.

**It arrives with every `me` rather than being read from anything kept here.** It used to be read from what the pairing wrote into the application's own store, and a store is a copy: an operator adding a requirement on the console changed it over there while the application went on admitting whoever it had admitted the day it was installed.

The comparison is made on **both** sides, and they are two different jobs. The server makes it on every session read, and a failure ends the session here and clears the cookie: the account is signed in and simply not entitled to be in this application. The page makes it on every pushed `me-changed`, and a failure is a SIGN-OUT rather than a repaint - losing `<resource>:access` is not one right fewer, it is the door, and greying out the buttons would leave the reader sitting on a page the server has already started refusing.

## Display is not enforcement

Everything a page does with this list is about **hiding what the API would refuse anyway**. Hiding is not enforcing, and the two are separate jobs that happen to read the same list.

The refusal itself is a `403` from the server, on every route, against the permissions x-core recomputed on **that** request. Nothing on a page can grant anything, and a page that hid nothing would simply be a page whose buttons all answer `403`.

## The three questions a page asks

```
can(action)        holds this one
canAll(...actions) holds all of them, which is what a page needing two rights asks
canAny(...actions) holds any of them, for a section several rights can open
```

An application whose rights all live under one resource may name that resource once and ask in short form, rather than repeating the prefix at every call site. That is a convenience of the reader, not a rule of the protocol: what x-core answers is always the full `resource:action`.

## Guarding a route

A page nobody may open answers `403` rather than opening onto nothing. The menu already hides the link and the API already refuses the calls behind it, but a hidden link is not a closed door: the address can be typed, bookmarked, or followed from a message. Without a guard such a page renders its shell, fires its requests, and shows a broken screen made of refusals instead of saying the one thing that is true.

A `403` and never a redirect: the reader **is** signed in, so sending them to the portal would loop them straight back with the same rights. Fatal, so it replaces the page rather than rendering beside it, because what is behind it is exactly what must not be drawn.

Signed out is a different case and not this guard's business: it is a redirect, decided before this runs.

A page declares what it needs and nothing else. There is no second place to remember when adding one.

## The page already open

The guard runs when a route is entered, which leaves the case that matters most uncovered: a right revoked while somebody is **sitting on** the page it opens. The socket pushes the change within seconds, the nav entry disappears, and the form stays there offering an action the API now refuses.

So the same question is asked again whenever the answer can have moved: when the rights change, and when the route does.

Two details that only show up in use:

- **Granted back is also a change.** A right restored must bring the page back rather than leaving somebody on an error nobody can clear but by reloading.
- **Only what this raised is cleared.** A `403` can come from anywhere, and clearing one it did not cause would put a reader back on a page whose refusal still stands.

This belongs to the browser alone: it is about a page already open in front of somebody. The first render is the guard's job.
