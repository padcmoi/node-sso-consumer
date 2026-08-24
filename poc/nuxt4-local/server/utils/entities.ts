import { EntitySchema } from "typeorm";

/**
 * ── THE SHELF ─────────────────────────────────────────────────────────────────
 *
 * `type` is a COLUMN and not a convention. The library hands over JavaScript values
 * and takes JavaScript values back, and stored as one opaque blob that shape
 * survives only as long as whoever reads it remembers to parse - the first reader who
 * does not is a boot comparing the string 'false' to `false`.
 */
export interface AppSettingRow {
  key: string;
  type: "string" | "number" | "boolean" | "array" | "object" | "null";
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

export const AppSettingEntity = new EntitySchema<AppSettingRow>({
  name: "AppSetting",
  tableName: "app_sso_settings",
  columns: {
    key: { name: "key", type: String, length: 190, primary: true },
    type: { name: "type", type: "enum", enum: ["string", "number", "boolean", "array", "object", "null"] },
    value: { name: "value", type: "longtext" },
    createdAt: { name: "created_at", type: "datetime", createDate: true },
    updatedAt: { name: "updated_at", type: "datetime", updateDate: true },
  },
});

/**
 * ── THE DIRECTORY, AND THE FK TARGET ──────────────────────────────────────────
 *
 * One table for BOTH modes, and that is the whole reason it looks like this.
 *
 * In `mode: "local"` it is the source: the passwords, the names and the rights live
 * nowhere else. In `mode: "sso"` it would be a PROJECTION - a row written the first
 * time an account is seen, so that this application's own tables have something to
 * put a foreign key on. A key cannot cross two databases, and the account lives in
 * x-core's.
 *
 * `id` is a `varchar(64)`, not a `char(36)`, and that is the trap this table exists
 * to avoid: x-core answers a 36-character UUID, and a local account's id is either
 * what the application wrote or `local-<sha256(email)[0:24]>`. One column has to hold
 * both, or `notes.owner` changes target when the mode changes - which is exactly what
 * the single table buys.
 *
 * `origin` says which of the two a row came from, so nothing has to guess.
 *
 * The last four columns belong to `'local'` only. In `"sso"` x-core answers the
 * rights with every `me`, and copying them here would be two truths with one of them
 * stale.
 */
export type AccountOrigin = "sso" | "local";

export interface SsoAccountRow {
  id: string;
  origin: AccountOrigin;
  firstSeenAt: Date;
  lastSeenAt: Date;
  email: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  passwordScrypt: string | null;
  permissions: string | null;
  isRoot: boolean;
  profile: string | null;
}

export const SsoAccountEntity = new EntitySchema<SsoAccountRow>({
  name: "SsoAccount",
  tableName: "app_sso_accounts",
  columns: {
    id: { name: "id", type: String, length: 64, primary: true },
    origin: { name: "origin", type: "enum", enum: ["sso", "local"] },

    firstSeenAt: { name: "first_seen_at", type: "datetime", createDate: true },
    // WRITTEN EXPLICITLY by `seen`, not `updateDate: true`. MariaDB only fires
    // `ON UPDATE CURRENT_TIMESTAMP` when a column value actually changes, and an
    // upsert that rewrites the same name and the same email changes nothing - so the
    // column would have stayed at its creation time forever and read as "seen once".
    lastSeenAt: { name: "last_seen_at", type: "datetime", default: () => "CURRENT_TIMESTAMP(6)" },

    // Refreshed at every sign-in. SOURCE in `'local'`, CACHE in `'sso'` - same
    // columns, opposite meaning, which is the one thing to keep in mind when reading
    // this table: a screen that writes `email` on an `'sso'` row believes it is
    // correcting a value and is overwriting a cache the next sign-in rewrites.
    email: { name: "email", type: String, length: 320, nullable: true, unique: true },
    displayName: { name: "display_name", type: String, length: 190, nullable: true },
    firstName: { name: "first_name", type: String, length: 190, nullable: true },
    lastName: { name: "last_name", type: String, length: 190, nullable: true },
    avatarUrl: { name: "avatar_url", type: String, length: 1024, nullable: true },

    // `'local'` only, and nullable for that reason.
    passwordScrypt: { name: "password_scrypt", type: String, length: 255, nullable: true },
    permissions: { name: "permissions", type: "longtext", nullable: true },
    isRoot: { name: "is_root", type: Boolean, default: false },
    profile: { name: "profile", type: "longtext", nullable: true },
  },
});

/**
 * This application's OWN data, and the point of the table above.
 *
 * `owner` is a `varchar(64)` pointing at `app_sso_accounts.id`. `ON DELETE RESTRICT`
 * rather than `CASCADE`: a row of that table is a record of who came through here,
 * and deleting an account should not take its notes with it. An account that leaves
 * is marked, not erased.
 */
export interface NoteRow {
  id: number;
  owner: string;
  title: string;
  body: string;
  createdAt: Date;
}

export const NoteEntity = new EntitySchema<NoteRow>({
  name: "Note",
  tableName: "notes",
  columns: {
    id: { name: "id", type: Number, primary: true, generated: "increment" },
    owner: { name: "owner", type: String, length: 64 },
    title: { name: "title", type: String, length: 190 },
    body: { name: "body", type: "text" },
    createdAt: { name: "created_at", type: "datetime", createDate: true },
  },
  relations: {
    // Named apart from the `owner` column on purpose: the column is what a query
    // reads and writes, the relation is what makes TypeORM emit the constraint.
    ownerAccount: {
      type: "many-to-one",
      target: "SsoAccount",
      joinColumn: { name: "owner", referencedColumnName: "id" },
      onDelete: "RESTRICT",
      onUpdate: "CASCADE",
    },
  },
});
