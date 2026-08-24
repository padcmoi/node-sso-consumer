import { createHash } from "node:crypto";
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
 * The password is in the CLEAR, and it must be. Nothing here claims to be secure:
 * these accounts live in an application's own source, they never leave it, and they
 * are never read when the library is on. Hashing them would suggest otherwise, which
 * is the more dangerous of the two.
 */
export interface StandInAccount {
  email: string;
  /** In the clear, and compared as-is. See above. */
  password: string;
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
 * typed a capital on their phone is not making a mistake. The password is matched
 * exactly, because it is not an address.
 */
export const signIn = (accounts: StandInAccount[], email: string, password: string) =>
  accounts.find((account) => account.email.toLowerCase() === email.trim().toLowerCase() && account.password === password) ?? null;

/** The account a sealed cookie points at, re-read on EVERY request. */
export const findById = (accounts: StandInAccount[], id: string) => accounts.find((account) => idOf(account) === id) ?? null;
