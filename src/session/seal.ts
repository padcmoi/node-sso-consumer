import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Sealing what the session cookie carries.
//
// The cookie holds the token pair, and a refresh token is a password with a month
// of life: it may leave this process, it may not be readable by the browser it
// authenticates, and it may not be forgeable. So it is encrypted AND authenticated
// - AES-256-GCM, whose tag is what makes an edited cookie a failure rather than a
// different session.
//
// node:crypto and nothing else. A library that seals sessions has no business
// pulling a dependency in to do it, and the format below is four base64url fields
// anybody can read in a debugger.

const VERSION = "v1";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
/** Bound by iron's own floor, and for the same reason: this seals an administrator's session. */
const MIN_PASSWORD_LENGTH = 32;

const encode = (value: Buffer) => value.toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url");

/**
 * The key, derived once per password rather than per call.
 *
 * scrypt is deliberately slow, which is right for a password and wrong for a
 * per-request derivation - a session read on every request would spend more time
 * here than in the network call it guards.
 */
const keys = new Map<string, Buffer>();

const keyFor = (password: string) => {
  const known = keys.get(password);
  if (known) return known;

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The session password must be at least ${MIN_PASSWORD_LENGTH} characters: this seals a live session`);
  }

  // A fixed salt, and it is not an oversight: the password is already high-entropy
  // and per-deployment, and a random salt would have to travel in the cookie for
  // every read to derive the same key - which is one more thing to get wrong for
  // no attacker made poorer by it.
  const key = scryptSync(password, "node-sso-consumer", KEY_LENGTH);
  keys.set(password, key);
  return key;
};

export const seal = (password: string, payload: unknown) => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", keyFor(password), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return [VERSION, encode(iv), encode(cipher.getAuthTag()), encode(body)].join(".");
};

/**
 * Open one, or null.
 *
 * Null for everything: a cookie from another deployment, one sealed under a
 * password since rotated, one somebody edited. None of them is an error worth
 * raising - they all mean the same thing, that nobody is signed in, and a thrown
 * exception here would turn a signed-out visitor into a 500.
 */
export const unseal = (password: string, value: string | null | undefined) => {
  if (!value) return null;

  const [version, rawIv, rawTag, rawBody] = value.split(".");
  if (version !== VERSION || !rawIv || !rawTag || !rawBody) return null;

  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(password), decode(rawIv));
    decipher.setAuthTag(decode(rawTag));
    const opened = Buffer.concat([decipher.update(decode(rawBody)), decipher.final()]);
    const parsed: unknown = JSON.parse(opened.toString("utf8"));
    return parsed;
  } catch {
    return null;
  }
};

/** Comparing two opaque values without leaking where they differ. */
export const sameValue = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
