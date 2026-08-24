import type { XcoreAccountStore } from "@gestionpratique/node-sso-consumer";

/**
 * `di.accounts` in `mode: "sso"` - ONE function, and it is the only one that makes
 * sense here.
 *
 * There is no directory to read: x-core answers who is there. What this application
 * needs instead is a ROW to hang a foreign key on. A key cannot cross two databases,
 * and the account lives in x-core's, so `services.owner` - or any column of this
 * application that belongs to somebody - has nothing local to point at until this
 * writes one.
 *
 * `findByEmail`, `findById`, `create` and `update` are all optional and all absent:
 * they belong to `"local"`, where the library reads the directory rather than the
 * provider. Lending them here would be four functions nothing ever calls.
 *
 * WHEN it fires is the library's business and not this file's: once per account per
 * process, and again after a sign-out, rather than on every request. That is the
 * whole reason the hook lives over there - `sessionOf()` hands the account back on
 * every call, and wiring the write to that would write on every asset a page pulls.
 */
export const accounts: XcoreAccountStore = {
  async seen(account) {
    await dbExecute(
      `INSERT INTO app_sso_accounts (id, origin, email, display_name, first_name, last_name, avatar_url, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE
         email = VALUES(email),
         display_name = VALUES(display_name),
         first_name = VALUES(first_name),
         last_name = VALUES(last_name),
         avatar_url = VALUES(avatar_url),
         -- WRITTEN EXPLICITLY rather than left to ON UPDATE CURRENT_TIMESTAMP:
         -- MariaDB only fires that when a column value actually changes, and a
         -- reader signing in with the same name changes nothing - so the column
         -- would have stayed at its creation time and read as "seen once".
         last_seen_at = CURRENT_TIMESTAMP(6)`,
      [account.id, account.origin, account.email, account.displayName, account.firstName, account.lastName, account.avatarUrl]
    );
  },
};
