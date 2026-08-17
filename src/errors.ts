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

/** True when the session is over and the reader has to sign in again. */
export function isSessionOver(error: unknown) {
  return error instanceof SsoError && (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN");
}
