import type { SsoAuthService } from "../auth.service.js";
import { SsoRealtimeClient } from "../realtime/realtime.client.js";
import type { SsoLogger, SsoMe } from "../types.js";

/**
 * The accounts this application is currently holding a session for, followed over
 * the provider's socket so that what changes about them is HEARD rather than asked
 * for.
 *
 * A RELAY, and nothing decides anything from it. What arrives is handed to
 * `di.onAccount` and `di.onSignedOut`: an application pushes it into its own store,
 * empties its own cache, fans it out to the browsers it holds. No guard reads from
 * here and no door opens on it.
 *
 * It used to answer the guards, for five minutes between proofs, on the reasoning
 * that a socket which pushes every change cannot go stale. The reasoning has one
 * hole and it is the one that matters: a session revoked from the portal pushes
 * NOTHING. x-core re-checks a live socket against the IdP session and the account's
 * access, deliberately not against the consumer session row - that row is replaced
 * at every rotation, so pinning a socket to it would close every socket a quarter of
 * an hour in. The frame therefore never comes, and what was held here was a session
 * the provider had already refused.
 *
 * So this was demoted rather than made cleverer. A held view is only ever as good as
 * the worst signal it depends on, and there is one signal it cannot receive.
 *
 * Keyed by account and not by session: two browsers signed into the same account
 * read the same rights, and the provider recomputes them per account anyway.
 */
interface LiveAccount {
  me: SsoMe;
  socket: SsoRealtimeClient;
}

export interface SsoLiveAccountsOptions {
  auth: SsoAuthService;
  realtimeUrl: string;
  /**
   * What the provider pushed, handed on to whoever else has to hear it: the
   * application's own store, the browsers it holds sockets for, a cache it keeps.
   *
   * The held view is written FIRST and this is called after, so anything the
   * listener does reads the new value rather than the one being replaced.
   */
  onAccount?(userId: string, me: SsoMe): void;
  /** The session is over. Called once, after the account has been let go. */
  onSignedOut?(userId: string): void;
  logger?: SsoLogger;
}

export class SsoLiveAccounts {
  private readonly accounts = new Map<string, LiveAccount>();

  constructor(private readonly options: SsoLiveAccountsOptions) {}

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
        this.options.onAccount?.(userId, pushed);
      },
      // The IdP session was closed, the account disabled, or its access to THIS
      // application revoked. Let go of it and say so - the reads were already going
      // to the provider, which refuses them properly on their own.
      onSignedOut: () => this.forget(userId),
    });

    this.accounts.set(userId, { me, socket });

    void socket.connect(accessToken).catch((error: unknown) => {
      // A socket that will not open is not a session that is over: the reads fall
      // back to asking the provider on every request, which is what an application
      // without this does all the time.
      this.options.logger?.warn?.(`[sso] could not follow ${userId}: ${String(error)}`);
      this.accounts.delete(userId);
    });
  }

  /** Stop following. Let whoever was listening know, once. */
  forget(userId: string) {
    const held = this.accounts.get(userId);
    if (!held) return;
    held.socket.close();
    this.accounts.delete(userId);
    this.options.onSignedOut?.(userId);
  }

  /** Every socket, for a process shutting down. */
  close() {
    for (const userId of [...this.accounts.keys()]) this.forget(userId);
  }
}
