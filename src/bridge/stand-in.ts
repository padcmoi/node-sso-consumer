import { SsoError } from "../errors.js";
import { accountIdOf, findById, meOf, signIn } from "../session/local-accounts.js";
import { hashPassword } from "../session/password.js";
import { jarOf } from "../http/web.js";
import type { StandInAccount } from "../session/local-accounts.js";
import type { SsoEnvironment } from "../environment.js";
import type { SsoSessionService } from "../session/session.service.js";
import type { WebRequest, WebResponse } from "../http/web.js";
import type { XcoreBridgeOptions } from "./contract.js";

/**
 * What an application calls itself while it stands in for the provider.
 *
 * Written into the store like everything the pairing writes, so the session code
 * reads it the same way and does not know the difference. `local` rather than a
 * borrowed-looking identity, because nothing signs with it: there is no provider to
 * sign to, and a name that looked like a real clientId would be read as one in a log.
 */
export const LOCAL_CLIENT_ID = "local";

/**
 * The cookie a stand-in session is sealed into.
 *
 * Its own name, distinct from `sso_<clientId>`: a machine that runs an application
 * offline and then pairs it holds two cookies that mean different things, and one
 * opened with the other's password is a reader signed out with no explanation.
 */
export const LOCAL_COOKIE_NAME = "sso_local";

/** What standing in needs, and nothing else: the lent directory and the seal. */
export interface StandInContext {
  options: XcoreBridgeOptions;
  identity: SsoEnvironment;
  sessions: SsoSessionService;
}

/**
 * STANDING IN: `mode` is `"local"` and this application lent a way to read its
 * directory.
 *
 * Not a degraded mode and not a stand-aside. The library holds real sessions, the
 * guards enforce, a missing right is a `403` - only the answer to "who is this"
 * comes from the application's own table instead of from x-core.
 *
 * THE ACCESSOR'S PRESENCE decides this, not a row count, and it could not be
 * otherwise: this is read on every request and synchronously, where counting rows is
 * a query. It is also the better question - an empty table is an application whose
 * first account has not been created yet, which refuses every sign-in without being
 * misconfigured. Lending nothing at all is the misconfiguration.
 */
export const standingIn = (options: XcoreBridgeOptions) => options.mode === "local" && Boolean(options.di.accounts);

/**
 * The reader behind the cookie, out of this application's own directory.
 *
 * No provider is called and none exists to call: the seal is opened, the id in it
 * is looked up AGAIN in the list, and what comes back is built into the same shape
 * `/sso/me` answers. An id nobody holds any more - an account deleted from the
 * source - clears the cookie rather than being tolerated, so the next request is
 * simply signed out instead of carrying a ghost.
 *
 * The tokens are empty strings, and that is honest rather than a placeholder:
 * there IS no token pair here, because there is no provider holding a session at
 * the other end. Nothing in this mode has one to spend - the socket does not open
 * and there is no rotation to make - and a caller reaching for one gets an empty
 * value rather than a convincing forgery.
 */
export async function localSessionOf(ctx: StandInContext, req: WebRequest, res: WebResponse) {
  const store = ctx.options.di.accounts;
  const jar = jarOf(req, res);
  const sealed = ctx.sessions.read(jar);
  if (!sealed || !store) return null;

  const account = await findById(store, sealed.userId);
  if (!account) {
    ctx.options.logger?.warn?.(`[sso] a local session pointed at ${sealed.userId}, which is no longer in the directory`);
    ctx.sessions.clear(jar);
    return null;
  }

  return {
    me: meOf(account, ctx.identity.resource ?? ""),
    tokens: { accessToken: "", accessTokenExpiresAt: "", refreshToken: "", refreshTokenExpiresAt: "" },
    userId: sealed.userId,
  };
}

/**
 * Sign a reader in against the lent directory, and seal the SAME cookie the SSO
 * seals.
 *
 * The same cookie name, the same password, the same shape inside: that is what
 * makes the switch a switch rather than a migration. A session opened here is read
 * back by exactly the code that reads an SSO one.
 *
 * Refuses with `null` and says nothing about which half was wrong. Telling a wrong
 * address from a wrong password tells whoever is asking which addresses exist.
 */
export async function signInLocally(
  ctx: StandInContext,
  req: WebRequest,
  res: WebResponse,
  credentials: { email: string; password: string }
) {
  const store = ctx.options.di.accounts;
  if (!standingIn(ctx.options) || !store) {
    throw new SsoError("NOT_CONFIGURED", "There is no local directory here: signing in goes through the provider");
  }

  const account = await signIn(store, credentials.email, credentials.password);
  if (!account) return null;

  const resolved = meOf(account, ctx.identity.resource ?? "");
  ctx.sessions.write(jarOf(req, res), {
    userId: resolved.user.id,
    tokens: { accessToken: "", accessTokenExpiresAt: "", refreshToken: "", refreshTokenExpiresAt: "" },
  });
  ctx.options.logger?.info?.(`[sso] ${resolved.user.email} signed in against this application's own directory`);
  return resolved;
}

/**
 * Create a reader in this application's own directory, hashing on the way in.
 *
 * THE HASH IS PRODUCED HERE, and that is the whole reason this exists rather than an
 * application calling `di.accounts.create` itself. `verifyPassword` reads a format
 * and a set of scrypt parameters; anything that writes them somewhere else has to
 * reproduce both, and the day one of the two moves nothing fails loudly - every
 * password is simply wrong at once.
 *
 * The id is composed the same way a lent record's is, so a store may write it or
 * leave it and the cookie opens either way.
 */
export async function createLocalAccount(
  ctx: StandInContext,
  input: Omit<StandInAccount, "passwordHash"> & { password: string }
) {
  const store = ctx.options.di.accounts;
  if (!store?.create) {
    throw new SsoError("NOT_CONFIGURED", "This application lent no way to create an account: `di.accounts.create`");
  }

  const { password, ...rest } = input;
  const account: StandInAccount = { ...rest, passwordHash: await hashPassword(password) };
  return store.create({ ...account, id: account.id ?? accountIdOf(account) });
}

/**
 * Change what a reader holds, hashing a new password on the way in.
 *
 * Same rule, same reason: a password given here is hashed by this library and by
 * nothing else. A patch carrying no password is passed through untouched.
 */
export async function updateLocalAccount(
  ctx: StandInContext,
  id: string,
  patch: Partial<Omit<StandInAccount, "passwordHash">> & { password?: string }
) {
  const store = ctx.options.di.accounts;
  if (!store?.update) {
    throw new SsoError("NOT_CONFIGURED", "This application lent no way to update an account: `di.accounts.update`");
  }

  const { password, ...rest } = patch;
  const written: Partial<StandInAccount> = password ? { ...rest, passwordHash: await hashPassword(password) } : rest;
  await store.update(id, written);
}
