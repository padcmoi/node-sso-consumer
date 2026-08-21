/**
 * Why a call failed, as a code rather than as a message.
 *
 * The consuming app has to tell three situations apart and they all look like "it
 * did not work": a session that is over and must send the reader back to the
 * portal, a credential that never arrived and is an operator's problem, and a
 * provider that is unreachable and is nobody's fault yet. Matching on a string
 * message is how the three end up handled as one.
 */
export type SsoErrorCode =
  /**
   * This library cannot reach the provider AT ALL: never paired, withdrawn, its
   * boot unfinished, or its credential never delivered.
   *
   * Apart from every code below, because it is not a call that failed - it is a
   * call that could not be made. Nothing behind a guard may be served in this
   * state: with no provider there is no account, so there is no one to check a
   * right against and nothing to decide with. It is the APPLICATION that is
   * misconfigured, which is why it answers `500` and never a redirect: there is
   * nowhere to send a reader, and no round trip they could make that would fix it.
   */
  | "NOT_CONFIGURED"
  /** No signature could be built: the credential is not in the store yet. */
  | "NO_CREDENTIAL"
  /** `apiBase` answers, but not as x-core does. Almost always the login window. */
  | "NOT_XCORE"
  /** x-core refused the call: token expired, session revoked, IdP session closed. */
  | "UNAUTHORIZED"
  /** The account may not enter this app, or may not do this. */
  | "FORBIDDEN"
  /** x-core answered something this library cannot read. */
  | "MALFORMED_ANSWER"
  /** The transport failed: unreachable, timed out, refused. */
  | "UNREACHABLE"
  /** x-core answered an error status that is none of the above. */
  | "REFUSED";

export class SsoError extends Error {
  readonly code: SsoErrorCode;
  /** The HTTP status x-core answered, when there was one. */
  readonly status: number | null;
  /** What the far side said, truncated. For a log, never for a browser. */
  readonly detail: string | null;

  constructor(
    code: SsoErrorCode,
    message: string,
    options: { status?: number | null; detail?: string | null; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "SsoError";
    this.code = code;
    this.status = options.status ?? null;
    this.detail = options.detail ?? null;
  }
}

/**
 * The HTTP status one of these codes deserves, decided ONCE.
 *
 * Here rather than in each application, because getting it wrong is not a
 * cosmetic mistake: `NOT_CONFIGURED` answered as `401` tells a reader to sign in
 * to an application that cannot sign anyone in, and every one of them would have
 * to rediscover that on their own.
 *
 *   500  the application is misconfigured. No round trip fixes it.
 *   401  nobody is signed in. A round trip through the portal does fix it.
 *   403  somebody IS signed in and does not hold the right. A round trip changes
 *        nothing about what they hold, so it must never be a redirect.
 *   503  the provider is there and did not answer this time.
 */
export function statusOf(error: unknown) {
  if (!(error instanceof SsoError)) return 500;

  // Never paired: there is no portal address either, since it arrives WITH the
  // pairing. Nowhere to send anybody, and no round trip that would help.
  if (error.code === "NOT_CONFIGURED") return 500;
  // The account is known and lacks the right. Never a redirect: signing in again
  // changes nothing about what it holds.
  if (error.code === "FORBIDDEN") return 403;
  // All the rest are one answer: nobody has been identified. x-core refused, x-core
  // could not be reached, the credential is missing, the answer was unreadable -
  // the cause differs and what is known about the reader does not, which is
  // nothing. `401`, and the caller sends them to the portal.
  return 401;
}

/** True when the session is over and the reader has to sign in again. */
export function isSessionOver(error: unknown) {
  return error instanceof SsoError && (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN");
}
