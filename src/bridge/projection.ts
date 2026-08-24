import type { XcoreBridgeOptions, XcoreMode, XcoreSeenAccount } from "./contract.js";
import type { SsoMe } from "../types.js";

// Telling the application that a reader was just seen, so it can keep a row to hang
// a foreign key on.
//
// The library persists nothing - it never has and this does not change it. What it
// does here is say WHEN, because it is the only thing that knows, and it says it once
// per account rather than once per request, because saying it every time would be a
// write on every click.

/**
 * The accounts this process has already announced.
 *
 * PER PROCESS, and that is the whole justification for this living in the library
 * rather than in an application's own guard. `sessionOf()` hands the account back on
 * every request; an application wiring the write there would write on every asset,
 * every poll, every navigation. Here it fires once, and again at each sign-in.
 *
 * A `Set` of ids and nothing more: it holds no account, no token and no personal
 * data, so a long-running process does not accumulate anything worth protecting. It
 * grows by one string per distinct reader, which is the same order as the sessions
 * that process is already serving.
 */
export class SeenAccounts {
  private readonly announced = new Set<string>();

  /** Forget one, so the next read announces it again and refreshes its row. */
  forget(id: string) {
    this.announced.delete(id);
  }

  /** Forget every one. For a process that has just lost its provider. */
  clear() {
    this.announced.clear();
  }

  /**
   * Announce a reader, unless this process already has.
   *
   * `force` is what a SIGN-IN passes: a reader coming back has a name and an avatar
   * that may have changed at the provider since the row was written, and the sign-in
   * is both the rare moment and the one where the fresh values are already in hand.
   *
   * NOT AWAITED by the caller, deliberately. This is a projection: a table that is
   * slow, locked or broken must not turn a good session into a refused one. What a
   * failure costs is a stale row, and it is logged loudly rather than swallowed.
   */
  announce(options: XcoreBridgeOptions, me: SsoMe, mode: XcoreMode, force = false) {
    const store = options.di.accounts;
    if (!store?.seen) return;

    const id = me.user.id;
    if (!force && this.announced.has(id)) return;
    this.announced.add(id);

    // Called ON the store rather than through a detached reference, so an
    // implementation that is a method of a class still finds its own `this`.
    void Promise.resolve(store.seen(rowOf(me, mode))).catch((error: unknown) => {
      // Forgotten on failure, so the next read tries again rather than believing the
      // row exists. A projection that fails silently and is never retried is the one
      // shape of this that is worse than not having it.
      this.announced.delete(id);
      options.logger?.error?.(`[sso] could not project the account ${id}: ${String(error)}`);
    });
  }
}

/**
 * The row, out of the account.
 *
 * The permissions are NOT carried, and that is the one deliberate omission: x-core
 * recomputes them with every `me`, so a copy in a table is a second truth that goes
 * stale without saying so - and the day somebody joins against it, a revoked right is
 * still granted by a query. What is kept is the identity and what a screen shows
 * beside it.
 */
const rowOf = (me: SsoMe, origin: XcoreMode) =>
  ({
    id: me.user.id,
    origin,
    email: me.user.email || null,
    displayName: me.user.displayName || null,
    firstName: me.profile?.firstname ?? null,
    lastName: me.profile?.lastname ?? null,
    avatarUrl: me.user.avatarUrl ?? null,
  }) satisfies XcoreSeenAccount;
