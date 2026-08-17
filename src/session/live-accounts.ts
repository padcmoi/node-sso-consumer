import type { SsoAuthService } from "../auth.service.js";
import { SsoRealtimeClient } from "../realtime/realtime.client.js";
import type { SsoLogger, SsoMe } from "../types.js";

/**
 * The accounts this application is currently holding a session for, kept in step
 * by the provider rather than by asking it.
 *
 * Without this, every request re-reads `me` - which is correct, and chatty: a
 * request per navigation, a token rotation behind each one, and a permission
 * revoked elsewhere landing only when the reader happens to click. With it, the
 * provider PUSHES the account the moment anything about it moves, so a read costs
 * nothing and a revocation lands within seconds of the grant being removed.
 *
 * It is not a cache, and the difference is not rhetorical: a cache goes stale in
 * silence, this is corrected by the provider within seconds of any change and torn
 * down by `me-signed-out` the moment the account may no longer be here. Both
 * topics or neither - one alone IS a cache, and the client subscribes to them
 * together.
 *
 * Keyed by account and not by session: two browsers signed into the same account
 * read the same rights, and the provider recomputes them per account anyway.
 */
interface LiveAccount {
  me: SsoMe;
  socket: SsoRealtimeClient;
  /** The provider said this account's session is over. Nothing is served from it. */
  signedOut: boolean;
}

export interface SsoLiveAccountsOptions {
  auth: SsoAuthService;
  realtimeUrl: string;
  logger?: SsoLogger;
}

export class SsoLiveAccounts {
  private readonly accounts = new Map<string, LiveAccount>();

  constructor(private readonly options: SsoLiveAccountsOptions) {}

  /**
   * What is held for an account, or null when nothing is - which is also what a
   * signed-out account answers, so a caller falls back to asking the provider and
   * gets the refusal from the one side entitled to give it.
   */
  view(userId: string) {
    const held = this.accounts.get(userId);
    if (!held || held.signedOut) return null;
    return held.me;
  }

  /**
   * Take what was just read, and start following it.
   *
   * The socket is opened once per account: the second session of the same account
   * finds it already there. Its access token is the one that opened it and is not
   * renewed with every rotation - the provider re-checks what does NOT rotate, the
   * IdP session and the access, every ten seconds, and closes on its own when
   * either is gone.
   */
  remember(userId: string, me: SsoMe, accessToken: string) {
    const held = this.accounts.get(userId);
    if (held) {
      held.me = me;
      held.signedOut = false;
      return;
    }

    const socket = new SsoRealtimeClient({
      auth: this.options.auth,
      url: this.options.realtimeUrl,
      logger: this.options.logger,
      // The frame IS the new value: written straight in, with no re-read behind
      // it. A permission granted or revoked from another application lands here.
      onAccount: (pushed) => {
        const entry = this.accounts.get(userId);
        if (entry) entry.me = pushed;
      },
      // The IdP session was closed, the account disabled, or its access to THIS
      // application revoked. Nothing is served from the entry afterwards, and the
      // next read asks the provider, which refuses it properly.
      onSignedOut: () => this.forget(userId),
    });

    this.accounts.set(userId, { me, socket, signedOut: false });

    void socket.connect(accessToken).catch((error: unknown) => {
      // A socket that will not open is not a session that is over: the reads fall
      // back to asking the provider on every request, which is what an application
      // without this does all the time.
      this.options.logger?.warn?.(`[sso] could not follow ${userId}: ${String(error)}`);
      this.accounts.delete(userId);
    });
  }

  /** Stop following, and stop serving: the next read goes to the provider. */
  forget(userId: string) {
    const held = this.accounts.get(userId);
    if (!held) return;
    held.signedOut = true;
    held.socket.close();
    this.accounts.delete(userId);
  }

  /** Every socket, for a process shutting down. */
  close() {
    for (const userId of [...this.accounts.keys()]) this.forget(userId);
  }
}
