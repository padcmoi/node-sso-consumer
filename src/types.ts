// The protocol, as x-core answers it. Nothing here is invented: these are the
// shapes of `/sso/consumer/session` and `/sso/me`, named once so the two services
// and the consuming app read the same thing.

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** The identity x-core hands back. Everything else about the person is read at `me`. */
export interface SsoUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * The civil identity x-core holds beside the account.
 *
 * Every field is nullable and the object is always present, so nothing branches on
 * its absence. Left open: x-core owns this list, and a field added there must not
 * need a release here to reach the app.
 */
export interface SsoProfile {
  gender?: string | null;
  lastname?: string | null;
  firstname?: string | null;
  birthDate?: string | null;
  avatarUrl?: string | null;
  locale?: string | null;
  address?: string | null;
  address2?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  phone1?: string | null;
  phone2?: string | null;
  [field: string]: unknown;
}

export interface SsoGroup {
  id: string;
  name: string;
  description: string | null;
}

/**
 * What the account may do, recomputed by x-core on every read.
 *
 * `global` is flat `resource:action` strings. `isRoot` needs no special case when
 * enforcing: a root account comes back holding the whole catalogue, so a plain
 * lookup already covers it - the flag only says where the power comes from.
 */
export interface SsoPermissions {
  global: string[];
  isRoot: boolean;
  groups: SsoGroup[];
  /**
   * What THIS application demands before an account may be in it at all, in the
   * same `resource:action` vocabulary as `global`.
   *
   * So the door is one comparison and nothing else: `global` contains every entry
   * here, or the session is over. EMPTY MEANS EVERYBODY, and it is the common
   * case - an application that declares no requirement, and one that gates itself.
   *
   * Answered by the provider on every read, which is the point. This used to be
   * taken from what the pairing wrote into the application's own store, and a
   * store is a copy: an operator adding a requirement changed it over there while
   * every consuming application went on admitting whoever it had admitted the day
   * it was installed.
   */
  portail: string[];
}

/** The account behind a session, whole. Read live, never stored. */
export interface SsoMe {
  user: SsoUser;
  profile: SsoProfile;
  permissions: SsoPermissions;
}

/**
 * The token pair a session IS.
 *
 * Not a session opened after an SSO check: the pair descends from the IdP session
 * and dies with it. Rotating spends the refresh token AND invalidates the access
 * token that came with it, so both halves are replaced together or not at all.
 */
export interface SsoTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/** What opening or rotating a session answers: the pair, and who it is for. */
export interface SsoSession extends SsoTokens {
  user: SsoUser;
}

/**
 * Who is at the browser end.
 *
 * It travels on every call that opens or renews a session, and not only on the
 * opening: those are server-to-server calls, so without it x-core files the
 * session under the calling CONTAINER's address - which is what its owner then
 * reads on the portal's sessions screen.
 */
export interface SsoClientContext {
  clientIp?: string | null;
  clientUserAgent?: string | null;
}

/**
 * How this app plugs into the SSO, as `PUT /sso/consumer/config` takes it.
 *
 * `dependGlobalRessource` is an ARRAY and is sent on every declaration, empty or
 * not: an optional field is only written when provided, so omitting it could set a
 * gate and never clear one.
 */
export interface SsoConsumerDeclaration {
  redirectUri: string;
  cancelUri?: string;
  template?: string;
  dependGlobalRessource: string[];
  skipAccessCheck?: boolean;
}

/** Somewhere to say what happened. Absent means silent, never a thrown error. */
export interface SsoLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}
