import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Storing a reader's password, for the directory this application lends at
// `mode: "local"`.
//
// It was in the CLEAR until now, and the argument for that was sound while the
// directory lived in an application's own source: nothing there claimed to be
// secure, the file never left the repository, and hashing would have suggested a
// property that did not exist. A directory that lives in a TABLE has none of those
// protections - a table is dumped, backed up, replicated, and opened with a SQL
// client - so the property has to become real.
//
// node:crypto and nothing else, like `seal.ts` beside it. scrypt is what Node
// carries, it is memory-hard, and this library will not pull a dependency in to
// compare two strings.

/**
 * The parameters, and they TRAVEL with the hash rather than being read from here.
 *
 * A stored hash that only says its digest is a hash nobody can ever re-tune: the
 * day these move, every row written before becomes unverifiable, silently, and what
 * that looks like is every reader's password suddenly being wrong. Written into the
 * record, an old row is still verified with the parameters it was made under and a
 * new one gets the new ones.
 *
 * `N = 16384` is Node's own default and the floor generally recommended for an
 * interactive login: about 16 MB of memory and a few tens of milliseconds. Raising
 * it is a one-line change here that costs nothing to what is already stored.
 */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * scrypt asks for its memory up front, and `N = 16384` needs more than the default
 * 32 MB ceiling once `r` is folded in. Left alone it throws `memory limit exceeded`
 * rather than running slowly, which is a boot that dies on its first sign-in.
 */
const MAX_MEMORY = 64 * 1024 * 1024;

const PREFIX = "scrypt";

const encode = (value: Buffer) => value.toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url");

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (error, key) =>
      error ? reject(error) : resolve(key)
    );
  });

/**
 * Hash one, for a row about to be written.
 *
 * EXPOSED, and it has to be. An application that creates accounts has to produce
 * exactly what `verifyPassword` will read, and asking it to reproduce the format
 * and the parameters by hand is asking for the day they drift apart - which does
 * not fail loudly, it fails as every password being wrong at once. One function
 * writes them, one reads them, and neither is the application's to write.
 *
 * A fresh random salt per record, unlike `seal.ts`, and for the opposite reason:
 * there the password is high-entropy and per-deployment, here it is whatever a human
 * chose, and a shared salt would let one table be attacked once for every row in it.
 *
 * ASYNC, deliberately. scrypt is slow on purpose - that is the whole point - and
 * `scryptSync` would hold the event loop for every concurrent sign-in.
 */
export async function hashPassword(password: string) {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, N, R, P);
  return [PREFIX, N, R, P, encode(salt), encode(key)].join("$");
}

/**
 * Compare one against a stored record. FALSE for everything that is not a match.
 *
 * A malformed record, a record written by something else, an unknown algorithm, a
 * truncated field: all `false` rather than thrown. A sign-in that throws on a bad
 * row is a `500` where the honest answer is a refusal, and it tells whoever is
 * asking that this particular account exists and is broken.
 *
 * `timingSafeEqual` on the derived key, and the length is checked first because it
 * throws on a mismatch rather than answering it.
 */
export async function verifyPassword(password: string, record: string) {
  const parts = record.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  // The parameters travel with the record, so a record could ask for a gigabyte.
  // Bounded here rather than trusted: this string comes out of a table.
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  const salt = decode(parts[4] ?? "");
  const expected = decode(parts[5] ?? "");
  if (!salt.length || expected.length !== KEY_LENGTH) return false;

  try {
    const key = await derive(password, salt, n, r, p);
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Whether a string is one of ours, for a caller that wants to know before trying. */
export const isPasswordHash = (value: string) => value.startsWith(`${PREFIX}$`);
