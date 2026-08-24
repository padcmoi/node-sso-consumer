import { SsoError } from "../errors.js";
import { clientContextOf, jarOf } from "../http/web.js";
import { localSessionOf, standingIn, type StandInContext } from "./stand-in.js";
import type { SsoLiveAccounts } from "../session/live-accounts.js";
import type { WebRequest, WebResponse } from "../http/web.js";
import type { SsoMe } from "../types.js";

/** Everything a guarded read touches: the seal, the followed accounts, the two states. */
export interface AccessContext extends StandInContext {
  live: SsoLiveAccounts | null;
  serving(): boolean;
  portalUrl(): string;
}

/**
 * The session behind a request, keeping the pair and the account id for whoever
 * needs them.
 *
 * IT ASKS THE PROVIDER, EVERY TIME. There is no held view to answer from and no
 * ceiling under which one is trusted, because the only thing entitled to say
 * whether a reader is still a reader is x-core, and the only moment its answer is
 * true is the moment it gives it.
 *
 * It did hold one - a followed account served for five minutes between proofs, on
 * the reasoning that the socket pushes what changes. A session revoked from the
 * portal pushes nothing: x-core re-checks a live socket against the IdP session and
 * the account's access, not against the consumer session row, because that row is
 * replaced at every rotation. So a reader whose session had been ended kept every
 * door open for five more minutes, which is exactly the forced access this library
 * exists to close.
 *
 * The socket keeps its job, and it is a real one: it repaints screens the instant a
 * right moves. It is not, and cannot be, what a door is opened on.
 */
export async function sessionOf(ctx: AccessContext, req: WebRequest, res: WebResponse) {
  // STANDING IN: the reader is in this application's own directory, and the
  // account is READ AGAIN here rather than taken from the seal. The seal holds an
  // id and nothing else, deliberately - a permission copied into a cookie is a
  // permission that survives being taken away, which is the one thing this whole
  // library exists not to do. Removing a right from the list therefore applies on
  // the next request, exactly as a revocation from x-core does.
  if (standingIn(ctx.options)) return localSessionOf(ctx, req, res);

  // LOCAL, and nothing lent. Nobody can sign in here at all: there is no provider to
  // ask and no directory to read. It is a misconfiguration rather than a signed-out
  // reader, so it throws like every other one.
  if (ctx.options.mode === "local") {
    throw new SsoError("NOT_CONFIGURED", "This application has no identity provider and no local accounts: nobody can sign in");
  }

  // ON, and unable to ask. THAT throws rather than answering "no reader", and the
  // difference is the whole point: `null` means nobody is signed in, which a
  // caller answers with a `401` and a way to sign in. This means the provider
  // cannot be reached at all, so there is no way to sign in and nothing that could
  // ever answer `401` usefully.
  //
  // Returned as `null` - which is what this did - the two collapsed, every caller
  // read "not signed in", and an application nobody had configured served the
  // shell of every protected page to anyone who asked.
  if (!ctx.serving()) {
    throw new SsoError("NOT_CONFIGURED", "This application cannot reach its identity provider: nothing behind a guard is served");
  }

  const jar = jarOf(req, res);
  const sealed = ctx.sessions.read(jar);
  if (!sealed) return null;

  const resolved = await ctx.sessions.resolve(jar, clientContextOf(req));

  if (!resolved) {
    ctx.live?.forget(sealed.userId);
    return null;
  }

  // Signed in, and not entitled to be HERE. The cookie is cleared rather than
  // left standing: it opens nothing any more, and a reader carrying one that is
  // refused on every request would be sent back to the portal by every page
  // without ever being told the session is over.
  if (!admitted(resolved.me)) {
    ctx.options.logger?.warn?.(
      `[sso] ${resolved.me.user.email} does not hold ${resolved.me.permissions.portail.join(", ")}: the session is over for this application`
    );
    ctx.sessions.clear(jar);
    ctx.live?.forget(resolved.userId);
    return null;
  }

  ctx.live?.remember(resolved.userId, resolved.me, resolved.tokens.accessToken);
  return resolved;
}

/**
 * May this account be here AT ALL - which is a different question from what it may
 * do once it is.
 *
 * ONE COMPARISON, between two lists the provider answered in the same breath:
 * `portail` is what THIS application requires, `global` is what this account
 * holds, and holding all of the first is the door. Nothing is parsed, split or
 * namespaced - both speak `resource:action`, which is what makes this a subset
 * test and not a convention two ends could read differently.
 *
 * EMPTY REQUIRES NOTHING and everybody passes. That is the common case and it has
 * to stay cheap: an application that declares no requirement, and one that gates
 * itself, both answer an empty list.
 *
 * Neither list is kept anywhere. It used to read the requirement out of what the
 * pairing wrote into this application's own store, which is a copy - so an
 * operator adding a requirement on the console changed it over there while this
 * application went on admitting whoever it had admitted the day it was installed.
 * Now it arrives with every `me`, for this application, and applies at once.
 *
 * Root needs no exception: the provider answers the whole catalogue in its
 * `global`, so the subset holds by construction.
 */
function admitted(me: SsoMe) {
  const required = me.permissions.portail;
  if (required.length === 0) return true;

  const held = new Set(me.permissions.global);
  return required.every((permission) => held.has(permission));
}

/**
 * End THIS application's session, and say where the reader goes next.
 *
 * Asymmetric on purpose, and it is the whole shape of this protocol: it closes the
 * session HERE and leaves the reader signed into the SSO and into every other
 * application. Signing out of the provider is done at the portal, by them.
 *
 * Answers the address to send them to rather than redirecting: the caller knows
 * whether it is answering a form or a fetch, and a redirect written into a fetch
 * is a response a browser never follows.
 */
export async function logout(ctx: AccessContext, req: WebRequest, res: WebResponse) {
  const jar = jarOf(req, res);
  // Read before ending: whatever follows this account has to be dropped with it,
  // or the process keeps a stream open for a session nobody holds.
  const sealed = ctx.sessions.read(jar);

  // Standing in there is no provider to tell, and nothing to tell it: the session
  // never existed anywhere but in this cookie. Clearing it IS the sign-out.
  if (standingIn(ctx.options)) ctx.sessions.clear(jar);
  else await ctx.sessions.end(jar);

  if (sealed) ctx.live?.forget(sealed.userId);

  return standingIn(ctx.options) ? (ctx.options.routes?.loginPath ?? "/login") : ctx.portalUrl();
}
