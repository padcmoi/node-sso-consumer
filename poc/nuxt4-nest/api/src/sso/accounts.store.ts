import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { XcoreAccountStore, XcoreSeenAccount } from "@gestionpratique/node-sso-consumer";

/**
 * `di.accounts` in `mode: "sso"` - ONE function, and the only one that means anything
 * here.
 *
 * There is no directory to read: x-core answers who is there. What this API needs is
 * a ROW to hang a foreign key on, because a key cannot cross two databases and the
 * account lives in x-core's. `findByEmail`, `findById`, `create` and `update` belong
 * to `"local"`, and lending them here would be four functions nothing ever calls.
 *
 * WHEN it fires is the library's business: once per account per process, and again
 * after a sign-out. `sessionOf()` hands the account back on every request, so wiring
 * this to that would write on every call the console relays.
 */
@Injectable()
export class AccountsStore implements XcoreAccountStore {
  constructor(private readonly db: DatabaseService) {}

  async seen(account: XcoreSeenAccount) {
    await this.db.execute(
      `INSERT INTO app_sso_accounts (id, origin, email, display_name, first_name, last_name, avatar_url, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE
         email = VALUES(email), display_name = VALUES(display_name),
         first_name = VALUES(first_name), last_name = VALUES(last_name),
         avatar_url = VALUES(avatar_url),
         -- WRITTEN EXPLICITLY: MariaDB only fires ON UPDATE CURRENT_TIMESTAMP when a
         -- column value actually changes, and a reader signing in with the same name
         -- changes nothing - so the column would read as "seen once", forever.
         last_seen_at = CURRENT_TIMESTAMP(6)`,
      [account.id, account.origin, account.email, account.displayName, account.firstName, account.lastName, account.avatarUrl]
    );
  }
}
