import { SsoError } from "./errors.js";
import type { SsoProfile, SsoUser } from "./types.js";

// Reading x-core's answers into the shapes above.
//
// The JWT is HS256-signed with a secret this side does not hold, so nothing here
// verifies anything: what makes an answer trustworthy is that it came back over
// the HMAC channel. What IS checked is that it can be READ - a missing field turns
// into a named error at the boundary rather than into `undefined` three layers
// later, in a page rendering a signed-in shell around nothing.

/**
 * The fields of a JSON object, or null for anything that is not one.
 *
 * Returns the narrowed value rather than a boolean: a type predicate has to be
 * written on the function itself, and an inferred one comes back as `value is
 * object`, which has no fields to read. Handing back a record instead narrows at
 * the call site through a plain null check, and costs a shallow copy of a payload
 * that was a string a moment ago.
 */
export const asFields = (value: unknown) => {
  if (typeof value !== "object" || value === null) return null;
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return fields;
};

// The `never` is on the const and not on the arrow, and it has to be written down:
// TypeScript only treats a call as an exit - and keeps the narrowing that follows
// it - when the callee carries an EXPLICIT never, inferring one is not enough.
const malformed: (field: string) => never = (field) => {
  throw new SsoError("MALFORMED_ANSWER", `The SSO answer is missing or mistyping \`${field}\``);
};

const readString = (value: unknown, field: string) => {
  if (typeof value !== "string") malformed(field);
  return value;
};

const readNullableString = (value: unknown, field: string) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") malformed(field);
  return value;
};

const readUser = (value: unknown, at: string) => {
  const fields = asFields(value);
  if (!fields) malformed(at);
  const email = readString(fields.email, `${at}.email`);
  const user: SsoUser = {
    id: readString(fields.id, `${at}.id`),
    email,
    // An account may carry no display name; its email is what every screen falls
    // back to, so the fallback belongs here rather than in each of them.
    displayName: readNullableString(fields.displayName, `${at}.displayName`) ?? email,
    avatarUrl: readNullableString(fields.avatarUrl, `${at}.avatarUrl`),
  };
  return user;
};

const readGroups = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value.map((entry: unknown, index: number) => {
    const fields = asFields(entry);
    if (!fields) malformed(`permissions.groups[${index}]`);
    return {
      id: readString(fields.id, `permissions.groups[${index}].id`),
      name: readString(fields.name, `permissions.groups[${index}].name`),
      description: readNullableString(fields.description, `permissions.groups[${index}].description`),
    };
  });
};

/**
 * The rights, as x-core recomputed them for THIS request.
 *
 * An empty `global` is a real answer and not a failure: the account holds nothing
 * here. What is refused is an answer with no `permissions` at all, because a
 * missing list read as an empty one is a gate that opens when it cannot see.
 */
const readPermissions = (value: unknown) => {
  const fields = asFields(value);
  if (!fields) malformed("permissions");

  const held = fields.global;
  if (!Array.isArray(held)) malformed("permissions.global");

  const global: string[] = held.map((entry: unknown, index: number) => readString(entry, `permissions.global[${index}]`));

  // What THIS application requires, as the provider answered it for THIS
  // application - not a copy kept here, so a requirement added on the console
  // applies on the next read.
  //
  // ABSENT reads as empty, deliberately, and it is the one place in this parser
  // that forgives: a provider that predates this key demands nothing by saying
  // nothing, and refusing would shut every door against every x-core not yet
  // upgraded. `permissions.global` keeps refusing when it is missing, because
  // there the empty reading is the one that opens a gate.
  const required = fields.portail;
  const portail: string[] = Array.isArray(required)
    ? required.map((entry: unknown, index: number) => readString(entry, `permissions.portail[${index}]`))
    : [];

  return { global, isRoot: fields.isRoot === true, groups: readGroups(fields.groups), portail };
};

/**
 * The civil identity, copied field by field rather than trusted whole.
 *
 * Every key x-core sends is kept, including ones this library predates: the list
 * belongs to x-core, and a field added there must reach the app without a release
 * here.
 */
const readProfile = (value: unknown) => {
  const profile: SsoProfile = {};
  const fields = asFields(value);
  if (!fields) return profile;
  for (const [field, entry] of Object.entries(fields)) profile[field] = entry;
  return profile;
};

/** What `GET /sso/me` answers. */
export const readMe = (payload: unknown) => {
  const fields = asFields(payload);
  if (!fields) malformed("me");
  return {
    user: readUser(fields.user, "user"),
    // Always present, even for an account with no profile row, so nothing branches
    // on its absence.
    profile: readProfile(fields.profile),
    permissions: readPermissions(fields.permissions),
  };
};

/** What opening or rotating a session answers. */
export const readSession = (payload: unknown) => {
  const fields = asFields(payload);
  if (!fields) malformed("session");
  return {
    accessToken: readString(fields.accessToken, "accessToken"),
    accessTokenExpiresAt: readString(fields.accessTokenExpiresAt, "accessTokenExpiresAt"),
    refreshToken: readString(fields.refreshToken, "refreshToken"),
    refreshTokenExpiresAt: readString(fields.refreshTokenExpiresAt, "refreshTokenExpiresAt"),
    user: readUser(fields.user, "user"),
  };
};
