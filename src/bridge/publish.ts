import { clientContextOf } from "../http/web.js";
import { sessionOf, type AccessContext } from "./access.js";
import type { SsoActivityService, XcoreActivity, XcoreActivityResult } from "../activity.service.js";
import type { WebRequest, WebResponse } from "../http/web.js";

/**
 * Publish what a reader did, on the session of the request being answered.
 *
 * THE TOKEN FIRST FROM THE REQUEST. Behind a guard, `req.ssoTokens` is the pair the
 * guard has just proven and rotated if it had to, so it is used as it is: asking
 * the provider a second time in the same request would only cost a round trip.
 * Anywhere else the session is resolved here, which rotates what has to be.
 *
 * `"local"` publishes nothing and asks nothing: only the provider keeps a journal,
 * and standing in there is no provider. No session, nothing either - there is
 * nobody to write the line under.
 *
 * Never a throw, like the service: a provider that cannot be asked who the reader
 * is comes back as `published: false`, said in the log.
 */
export async function publishActivity(
  ctx: AccessContext,
  service: SsoActivityService,
  req: WebRequest,
  res: WebResponse,
  activity: XcoreActivity
) {
  if (ctx.options.mode === "local") return { published: false } satisfies XcoreActivityResult;

  let accessToken = req.ssoTokens?.accessToken ?? null;
  if (!accessToken) {
    try {
      accessToken = (await sessionOf(ctx, req, res))?.tokens.accessToken ?? null;
    } catch (error) {
      ctx.options.logger?.warn?.(
        `[sso] activity "${activity.action}" was not published: ${error instanceof Error ? error.message : String(error)}`
      );
      return { published: false } satisfies XcoreActivityResult;
    }
  }
  if (!accessToken) return { published: false } satisfies XcoreActivityResult;

  return service.publish(accessToken, activity, clientContextOf(req));
}
