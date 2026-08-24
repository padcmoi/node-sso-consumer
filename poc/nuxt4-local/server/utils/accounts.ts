import { accountIdOf, type StandInAccount, type XcoreAccountStore } from "@gestionpratique/node-sso-consumer";
import { SsoAccountEntity, type SsoAccountRow } from "./entities";

/**
 * `di.accounts` - the four ways the library reaches this application's directory.
 *
 * ACCESS FUNCTIONS, and nothing above them. The library decides who may in, what a
 * wrong password answers and what a record has to contain; these four say where the
 * rows are. That is the same rule `di.hmac` and `di.environment` already follow.
 *
 * The password NEVER passes through here. `create` receives a record whose
 * `passwordScrypt` the library produced with `hashPassword`, and `update` the same -
 * so the scrypt format lives in exactly one place, which is the only way the day it
 * is re-tuned does not turn every password wrong at once.
 */

/** The row, as the library's record. `permissions` and `profile` are JSON columns. */
const toAccount = (row: SsoAccountRow): StandInAccount => ({
  id: row.id,
  email: row.email ?? "",
  passwordHash: row.passwordScrypt ?? "",
  firstName: row.firstName ?? "",
  lastName: row.lastName ?? "",
  permissions: row.permissions ? (JSON.parse(row.permissions) as string[]) : [],
  isRoot: row.isRoot,
  avatarUrl: row.avatarUrl,
  profile: row.profile ? (JSON.parse(row.profile) as StandInAccount["profile"]) : undefined,
});

/** The record, as a row. `origin: 'local'` - these accounts exist nowhere else. */
const toRow = (account: StandInAccount): Partial<SsoAccountRow> => ({
  id: account.id ?? accountIdOf(account),
  origin: "local",
  email: account.email,
  displayName: [account.firstName, account.lastName].filter(Boolean).join(" ").toUpperCase() || null,
  firstName: account.firstName,
  lastName: account.lastName,
  avatarUrl: account.avatarUrl ?? null,
  passwordScrypt: account.passwordHash,
  permissions: JSON.stringify(account.permissions ?? []),
  isRoot: account.isRoot ?? false,
  profile: account.profile ? JSON.stringify(account.profile) : null,
});

export const accounts: XcoreAccountStore = {
  /**
   * The sign-in read. The address arrives already folded to lower case by the
   * library, and the column is compared as MariaDB compares it - the collation is
   * case-insensitive, so a row written with a capital still answers.
   */
  async findByEmail(email) {
    const repo = await useRepo<SsoAccountRow>(SsoAccountEntity);
    const row = await repo.findOne({ where: { email, origin: "local" } });
    return row ? toAccount(row) : null;
  },

  /** The per-request read, from the id inside the sealed cookie. */
  async findById(id) {
    const repo = await useRepo<SsoAccountRow>(SsoAccountEntity);
    const row = await repo.findOne({ where: { id, origin: "local" } });
    return row ? toAccount(row) : null;
  },

  /** Write a record the library has just hashed. */
  async create(account) {
    const repo = await useRepo<SsoAccountRow>(SsoAccountEntity);
    const row = repo.create(toRow(account) as SsoAccountRow);
    await repo.save(row);
    return toAccount(row);
  },

  /** Change one. A patch carrying no `passwordHash` leaves the column alone. */
  async update(id, patch) {
    const repo = await useRepo<SsoAccountRow>(SsoAccountEntity);
    const written: Partial<SsoAccountRow> = {};

    if (patch.email !== undefined) written.email = patch.email;
    if (patch.firstName !== undefined) written.firstName = patch.firstName;
    if (patch.lastName !== undefined) written.lastName = patch.lastName;
    if (patch.avatarUrl !== undefined) written.avatarUrl = patch.avatarUrl;
    if (patch.passwordHash !== undefined) written.passwordScrypt = patch.passwordHash;
    if (patch.permissions !== undefined) written.permissions = JSON.stringify(patch.permissions);
    if (patch.isRoot !== undefined) written.isRoot = patch.isRoot;
    if (patch.profile !== undefined) written.profile = JSON.stringify(patch.profile);

    if (Object.keys(written).length) await repo.update({ id }, written);
  },
};
