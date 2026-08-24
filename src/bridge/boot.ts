import { SsoError } from "../errors.js";
import { ENV, mintSessionPassword } from "../environment.js";
import { LOCAL_CLIENT_ID, LOCAL_COOKIE_NAME, standingIn } from "./stand-in.js";
import type { SsoConfigService } from "../config.service.js";
import type { SsoEnvironment } from "../environment.js";
import type { ProviderAddresses } from "../provider.js";
import type { XcoreBridgeOptions, XcoreStartResult } from "./contract.js";

/** What a boot touches: the store behind the identity, and the provider it declares to. */
export interface BootContext {
  options: XcoreBridgeOptions;
  identity: SsoEnvironment;
  config: SsoConfigService;
  provider: ProviderAddresses;
}

/**
 * Read the store and hold what it said. Idempotent, and safe on every worker.
 *
 * Its own function because a deployment running several processes elects ONE of them
 * to declare - PM2's instance 0, typically - and the others still have to know what
 * they sign as. Election belongs outside this library: it knows nothing of PM2, of
 * how many workers there are, or of how they are numbered.
 */
export async function load(ctx: BootContext) {
  ctx.identity.hydrate(await ctx.options.di.environment.load());
  return ctx.identity;
}

/**
 * Boot with the switch OFF.
 *
 * With a directory lent, this library stands in for the provider: it draws the
 * cookie password, names the cookie and serves sessions out of that list. No
 * pairing, no declaration, no broker and no socket - there is nothing on the other
 * side to do any of it with - but everything a reader touches behaves the same.
 *
 * With NOTHING lent, it is a misconfiguration and it says so. Not a stand-aside:
 * an application in that state has no provider to ask and no directory to read, so
 * nobody can ever sign in, and pretending otherwise would serve every guarded page
 * to anybody.
 */
export async function standIn(ctx: BootContext) {
  if (!standingIn(ctx.options)) {
    ctx.options.logger?.error?.(
      '[sso] NOT SERVING: `mode` is "local" and no `di.local_accounts` were lent, so there is no provider to ask ' +
        'and no directory to read. Nothing behind a guard is served. Set `mode: "sso"`, or lend a directory.'
    );
    return {
      ok: false,
      status: "not-paired",
      paired: false,
      declared: false,
      reason: 'mode is "local" and no local accounts were lent',
    } satisfies XcoreStartResult;
  }

  try {
    await load(ctx);
    await ensureSessionPassword(ctx);
    // The two values the pairing would have brought. Named locally and stored the
    // same way, so the session code that reads them does not know the difference -
    // and so a cookie survives a restart, which it would not if these were drawn
    // fresh each time.
    const missing: Record<string, unknown> = {};
    if (typeof ctx.identity.all[ENV.SSO_CLIENT_ID] !== "string") missing[ENV.SSO_CLIENT_ID] = LOCAL_CLIENT_ID;
    if (typeof ctx.identity.all[ENV.SSO_SESSION_COOKIE_NAME] !== "string") {
      missing[ENV.SSO_SESSION_COOKIE_NAME] = LOCAL_COOKIE_NAME;
    }
    if (Object.keys(missing).length) {
      await ctx.options.di.environment.save(missing);
      await load(ctx);
    }
  } catch (error) {
    return {
      ok: false,
      status: "not-paired",
      paired: false,
      declared: false,
      reason: `this application's own store could not be read: ${message(error)}`,
    } satisfies XcoreStartResult;
  }

  ctx.options.logger?.info?.(
    `[sso] standing in for the provider: ${ctx.options.di.local_accounts?.length ?? 0} local account(s), ` +
      "sessions held here, guards enforcing. No pairing, no propagation, no socket."
  );
  return { ok: true, status: "ready", paired: false, declared: false, reason: null } satisfies XcoreStartResult;
}

/**
 * Exchange the install token, and record the whole of what comes back.
 *
 * NOTHING IS CREATED by this call. The queue, the broker account, the SSO consumer
 * and the HMAC credential were all made when the token was MINTED, on the console,
 * in front of whoever minted it. This collects them; x-core deletes its row in the
 * same breath. The manager key an operator lent to build it stays theirs and is
 * not touched: one key installs as many applications as they have to install.
 *
 * `INSTALLED` is written in the SAME `save` as everything else and never before
 * it. Written first, a boot falling between the two would believe itself paired
 * while holding none of what that announces - and would never try again, since it
 * no longer looks at the token.
 */
export async function pair(ctx: BootContext) {
  const token = ctx.options.installToken?.trim();
  if (!token) {
    return {
      ok: false,
      status: "not-paired",
      paired: false,
      declared: false,
      reason:
        "this application is not paired and carries no install token. Mint one on x-core's console, under " +
        "Portails applicatifs, and put it in `installToken`.",
    } satisfies XcoreStartResult;
  }

  let paired: Awaited<ReturnType<SsoConfigService["pair"]>>;
  try {
    paired = await ctx.config.pair({ token });
  } catch (error) {
    // x-core's own words are what an operator needs here, and they are precise:
    // an unknown token, one withdrawn, one expired, one already redeemed, or one
    // still a draft - which is a form somebody left half finished, with no queue,
    // no broker account and no credential behind it to hand over.
    return {
      ok: false,
      status: "not-paired",
      paired: false,
      declared: false,
      reason: `the install token was refused by ${ctx.provider.apiBase}: ${message(error)}`,
    } satisfies XcoreStartResult;
  }

  // The secret this answer carries is NOT written anywhere, and that is not an
  // omission. x-core stores `hashClientSecret(secret, pepper)` and verifies against
  // that; the pepper is its own and never travels. An application that hashed this
  // secret itself would store something else, sign with it, and collect a
  // `401 BAD_SIGNATURE` on every call while holding the right secret.
  //
  // What signs is the hash x-core computed, and it only ever arrives on the
  // propagation queue - which is why that queue is not a convenience.
  const values = {
    ...paired.environment,
    // Minted here and never received: two applications sharing this password could
    // open each other's cookies, while each holds its own row on the provider,
    // revocable separately.
    [ENV.SSO_SESSION_PASSWORD]: ctx.identity.all[ENV.SSO_SESSION_PASSWORD] ?? mintSessionPassword(),
    [ENV.INSTALLED]: true,
  };

  try {
    await ctx.options.di.environment.save(values);
  } catch (error) {
    // The token is spent over there and the answer is gone with this process. It
    // has to be said in the loudest terms available: what repairs this is a new
    // token, not another boot.
    return {
      ok: false,
      status: "not-paired",
      paired: false,
      declared: false,
      reason:
        `paired as ${paired.clientId}, but this application's store refused to keep it: ${message(error)}. ` +
        "The install token is spent: mint a new one once the store is writable.",
    } satisfies XcoreStartResult;
  }

  ctx.identity.hydrate({ ...ctx.identity.all, ...values });
  ctx.options.logger?.info?.(`[sso] paired as ${paired.clientId}; the install token is spent`);

  return { ok: true, status: "ready", paired: true, declared: false, reason: null } satisfies XcoreStartResult;
}

/**
 * A sealing password, minted if the store holds none.
 *
 * Deleting that key is how an operator signs everyone out at once - every existing
 * cookie stops opening - so a boot finding it gone mints a new one rather than
 * refusing to start. It is a tool, not a fault.
 */
export async function ensureSessionPassword(ctx: BootContext) {
  if (typeof ctx.identity.all[ENV.SSO_SESSION_PASSWORD] === "string") return;

  const password = mintSessionPassword();
  await ctx.options.di.environment.save({ [ENV.SSO_SESSION_PASSWORD]: password });
  ctx.identity.hydrate({ ...ctx.identity.all, [ENV.SSO_SESSION_PASSWORD]: password });
  ctx.options.logger?.warn?.("[sso] no session password in the store: a new one was minted, every existing cookie is now void");
}

/** The declaration, with its outcome as a value rather than as an exception. */
export async function declareOnce(ctx: BootContext) {
  try {
    await ctx.config.declare();
    return { ok: true, status: "ready", paired: true, declared: true, reason: null } satisfies XcoreStartResult;
  } catch (error) {
    return {
      ok: false,
      status: "not-declared",
      paired: true,
      declared: false,
      reason: `${ctx.provider.apiBase} was not told how this application plugs in: ${message(error)}`,
    } satisfies XcoreStartResult;
  }
}

/**
 * Say the outcome once in the log.
 *
 * Loud on purpose: an application that failed to declare itself boots perfectly and
 * refuses every sign-in afterwards, which is the failure that costs an afternoon
 * to trace back to here.
 */
export function announce(ctx: BootContext, result: XcoreStartResult) {
  if (result.ok && result.status === "ready") {
    ctx.options.logger?.info?.(`[sso] ready against ${ctx.provider.apiBase} as ${ctx.identity.clientId}`);
  } else if (!result.ok) {
    ctx.options.logger?.error?.(
      `[sso] NOT SERVING (${result.status}): ${result.reason ?? "no reason given"}. ` +
        "This application is up, and nobody can sign in through the SSO until that line is fixed."
    );
  }
  return result;
}

/** What went wrong, in one line, with the provider's own words when it gave any. */
export const message = (error: unknown) => {
  if (error instanceof SsoError) return error.detail ? `${error.message} (${error.detail})` : error.message;
  return error instanceof Error ? error.message : String(error);
};
