import { createHash } from "node:crypto";
import { verifyPassword } from "./password.js";
import type { XcoreAccountStore } from "../bridge/contract.js";
import type { SsoMe, SsoProfile } from "../types.js";

/**
 * A reader this application holds itself, for when the provider is not the one
 * answering - `mode: "local"`.
 *
 * WHAT IS WRITTEN IS THIN, and that is the whole point of this file: an application
 * lends a handful of fields and gets back a session with the exact shape x-core
 * answers. A stand-in that returned an approximate shape would be worse than none -
 * it would let weeks of code go by reading fields that exist offline and not in
 * production, and the day the switch is flipped every one of them breaks at once.
 *
 * THE PASSWORD IS HASHED, and this reverses what this file used to say. The old
 * argument was that nothing here claimed to be secure - these accounts lived in an
 * application's own source, never left it, and hashing would have suggested a
 * property that did not exist. It held exactly as long as the directory was a
 * literal in a file. A directory that lives in a TABLE is dumped, backed up,
 * replicated and opened with a SQL client, so the property has to become real, and a
 * format that is right in one place and not the other is a format nobody can move.
 *
 * Produced by `hashPassword`, never by hand. See `password.ts` for why that is not a
 * convenience.
 */
export interface StandInAccount {
  email: string;
  /** What `hashPassword` returned. Compared by `verifyPassword`, never as-is. */
  passwordHash: string;
  firstName: string;
  lastName: string;
  /**
   * What this account holds, as `resource:action` - or as a bare action, which is
   * namespaced with the application's own identity the way x-core namespaces it.
   */
  permissions?: string[];
  /** Stable across boots. Derived from the email when it is not given. */
  id?: string;
  avatarUrl?: string | null;
  /** Passes everything, the way a root account does over there. */
  isRoot?: boolean;
  /** Anything else an application wants on `me.profile`, carried through as-is. */
  profile?: SsoProfile;
}

/**
 * The id of an account that did not name one.
 *
 * Derived from the email rather than drawn at random, and that is what makes a
 * cookie sealed yesterday open tomorrow: the seal holds the id and nothing else, so
 * an id that changed at every boot would sign everybody out on every restart.
 *
 * A hash rather than the email itself: it lands in a cookie, and an address is not
 * something to write there in plain sight.
 */
const idOf = (account: StandInAccount) =>
  account.id ?? `local-${createHash("sha256").update(account.email.toLowerCase()).digest("hex").slice(0, 24)}`;

/**
 * `PRÉNOM NOM`, the way the provider composes it.
 *
 * Not a preference: a screen printing `me.user.displayName` beside an avatar has to
 * read the same thing in both modes, or the offline version is a mock-up of a layout
 * that does not exist.
 */
const displayNameOf = (account: StandInAccount) =>
  [account.firstName, account.lastName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

/**
 * `resource:action`, with the application's own resource in front of a bare action.
 *
 * x-core answers permissions already namespaced - `core:access`,
 * `infrastructure:view-queues` - because one account holds rights across the whole
 * ecosystem. An application writing its local accounts thinks in its own actions and
 * writes `read:user`, so the namespace is added here.
 *
 * A value that already carries one is left alone, which is what lets a local account
 * name a right of another application when a screen genuinely reads one.
 */
const namespaced = (permissions: string[], resource: string) =>
  permissions
    .map((permission) => permission.trim())
    .filter(Boolean)
    .map((permission) => (permission.includes(":") || !resource ? permission : `${resource}:${permission}`));

/**
 * The account, as `/sso/me` would have answered it.
 *
 * Every field of the real shape is present, `null` where nothing is known rather
 * than absent: a component reading `me.profile.city` gets an empty value and
 * renders, instead of throwing on a property of `undefined`. That difference is the
 * reason this function exists at all.
 *
 * The group is the one x-core creates for every account - `_sso_user_<email>` - so
 * a screen listing groups shows the same one line it will show in production.
 */
export function meOf(account: StandInAccount, resource: string) {
  const id = idOf(account);
  const avatarUrl = account.avatarUrl ?? null;

  const me: SsoMe = {
    user: { id, email: account.email, displayName: displayNameOf(account), avatarUrl },
    profile: {
      gender: null,
      lastname: account.lastName,
      firstname: account.firstName,
      birthDate: null,
      avatarUrl,
      locale: "fr-FR",
      address: null,
      address2: null,
      city: null,
      postalCode: null,
      country: null,
      latitude: null,
      longitude: null,
      phone1: null,
      phone2: null,
      groupAppsByCategory: false,
      // Last, so an application that wants a real address on a local account writes
      // it and it wins over the nulls above.
      ...account.profile,
    },
    permissions: {
      global: namespaced(account.permissions ?? [], resource),
      isRoot: account.isRoot === true,
      // Nothing is required, and nothing could be: a requirement is what a PORTAL
      // demands of an account before letting it into an application, and standing
      // in there is no portal - this application was never paired with one. Every
      // account in the lent directory is therefore admitted, which is what lending
      // a directory says.
      portail: [],
      groups: [
        {
          id: `local-group-${id}`,
          name: `_sso_user_${account.email}`,
          description: null,
        },
      ],
    },
  };
  return me;
}

/**
 * The account behind an email and a password, or nothing.
 *
 * ONE answer for a wrong email and a wrong password, and it is deliberate: telling
 * them apart tells whoever is asking which addresses exist.
 *
 * The email is matched case-insensitively because an address is, and a reader who
 * typed a capital on their phone is not making a mistake.
 *
 * ASYNC now, because scrypt is. The comparison is deliberately slow - that is what
 * the hash is for - and doing it synchronously would hold the event loop for every
 * concurrent sign-in.
 *
 * THE HASH IS STILL COMPUTED when no account matched the address, against a record
 * that cannot match. Returning early on an unknown address answers in a millisecond
 * where a known one takes fifty, and that difference is readable over the network:
 * it turns this route into a way of listing which addresses exist here.
 */
export async function signIn(store: XcoreAccountStore, email: string, password: string) {
  const account = (await store.findByEmail?.(email.trim().toLowerCase())) ?? null;

  const matched = await verifyPassword(password, account?.passwordHash ?? DECOY);
  return matched ? account : null;
}

/**
 * A record no password verifies against, hashed under the same parameters as a real
 * one so that failing against it costs the same as failing against a real one.
 *
 * Its own constant rather than a hash computed at import: computing one would run
 * scrypt at module load, in every process, for a value that never has to be secret.
 * It is the hash of a string nobody knows, and nothing depends on which one.
 */
const DECOY = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * The account a sealed cookie points at, re-read on EVERY request.
 *
 * `idOf` is applied to what comes back rather than trusted: a store that keys its
 * rows some other way would still answer the record, and the id in the cookie has to
 * be the id this library composed - otherwise a session opens onto the wrong reader.
 */
export async function findById(store: XcoreAccountStore, id: string) {
  const account = (await store.findById?.(id)) ?? null;
  if (!account) return null;
  return idOf(account) === id ? account : null;
}

/** The id this library composes for a record, for a store that has to write one. */
export const accountIdOf = idOf;
