import { SsoError } from "./errors.js";
import type { SsoHttpClient } from "./http.js";
import type { SsoClientContext, SsoLogger } from "./types.js";

const ACTIVITY_PATH = "/api/v1/sso/consumer/activity";

/**
 * One thing a reader did in this application, published to x-core's journal.
 *
 * The application's own vocabulary: x-core has none for what happens inside an
 * application, so it keeps `action` as a code to filter on and shows `label` as
 * it is given. It refuses the prefixes it writes itself (`auth.`, `account.`,
 * `acl.`, `app.` and the rest), so an application can never forge a sign-in or an
 * administration gesture - that rule lives THERE and nowhere else, which is why
 * nothing here checks it: a second copy would be a second list to drift.
 *
 * Never a secret, in any field: the journal is read by the account itself and by
 * the console, and x-core cannot tell a password from a name.
 */
export interface XcoreActivity {
  /** `^[a-z0-9]+([.-][a-z0-9]+)*$`, 64 characters at most. `invoice.paid`, `note.shared`. */
  action: string;
  /** What a reader of the journal sees. 191 characters at most. */
  label?: string;
  /** What it was done to, as it was called at the time: the object may be gone when the line is read. */
  entity?: { type: string; id?: string | number | null; label?: string | null };
  /** Another account it concerns, when the reader acted on somebody else. */
  subjectId?: string;
  /** Small facts, 4 KB of JSON at most. */
  details?: Record<string, unknown>;
}

/** Whether x-core wrote the line. Never a throw: see `publish`. */
export interface XcoreActivityResult {
  published: boolean;
}

export interface SsoActivityServiceOptions {
  http: SsoHttpClient;
  logger?: SsoLogger;
}

/**
 * The one call that tells x-core what a reader did here.
 *
 * Signed as this application, like every `/sso/consumer/**` call, and carrying the
 * reader's access token: x-core writes the line under the account that token
 * stands for, and refuses a token belonging to another application. So an
 * application publishes for a reader it really holds a session for, and for no
 * one else.
 */
export class SsoActivityService {
  constructor(private readonly options: SsoActivityServiceOptions) {}

  /**
   * Publish, and NEVER throw.
   *
   * A journal must not fail the gesture it describes: the invoice was paid whether
   * or not the line was written. So a refusal, an unreachable provider or a missing
   * credential all come back as `published: false`, said once in the log.
   */
  async publish(accessToken: string, activity: XcoreActivity, context: SsoClientContext = {}) {
    try {
      await this.options.http.call(ACTIVITY_PATH, "POST", {
        accessToken,
        action: activity.action,
        label: activity.label,
        entity: activity.entity,
        subjectId: activity.subjectId,
        details: activity.details,
        clientIp: context.clientIp ?? null,
        clientUserAgent: context.clientUserAgent ?? null,
      });
      return { published: true } satisfies XcoreActivityResult;
    } catch (error) {
      // A refusal carries a status and was already logged, with x-core's own words,
      // by the transport. Everything else - unreachable, no credential - was not.
      if (!(error instanceof SsoError && error.status !== null)) {
        this.options.logger?.warn?.(
          `[sso] activity "${activity.action}" was not published: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return { published: false } satisfies XcoreActivityResult;
    }
  }
}
