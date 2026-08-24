import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SsoError, type WebRequest, type WebResponse } from "@gestionpratique/node-sso-consumer";
import { XcoreService } from "./xcore.service";

export const PERMISSIONS = "sso:permissions";

/** Every action listed, or the call is refused. */
export const RequirePermissions = (...actions: string[]) => SetMetadata(PERMISSIONS, actions);

/**
 * ONE guard for both doors: it resolves the session, puts it on the request, then
 * checks whatever the route asked for.
 *
 * Authenticating and authorising cannot come apart, and nothing defaults to open. Two
 * guards would be two things to remember, and the one that gets forgotten is the
 * first - which is a route asserting rights against an account nobody read.
 *
 * `sessionOf` ASKS X-CORE, every time. There is no held view to answer from, because
 * the only thing entitled to say whether a reader is still a reader is x-core, and
 * the only moment its answer is true is the moment it gives it.
 */
@Injectable()
export class XcoreGuard implements CanActivate {
  constructor(
    private readonly xcore: XcoreService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    // The library's own request shape, and not Express's. It is what `IncomingMessage`
    // and `ServerResponse` carry underneath, which is what Nest hands over whichever
    // platform it sits on - so this file names no framework and reaches for no `any`
    // to get `me` onto a request.
    const req = http.getRequest<WebRequest>();
    const res = http.getResponse<WebResponse>();

    const resolved = await this.xcore.bridge.sessionOf(req, res);
    // UNAUTHORIZED rather than a redirect written here: the filter decides what a
    // browser sees, and an XHR must not be answered with the portal's HTML.
    if (!resolved) throw new SsoError("UNAUTHORIZED", "No session");

    req.me = resolved.me;
    req.ssoTokens = resolved.tokens;
    req.ssoUserId = resolved.userId;

    const actions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS, [context.getHandler(), context.getClass()]);
    // Throws FORBIDDEN naming what is missing.
    if (actions?.length) this.xcore.bridge.assert(req, ...actions);
    return true;
  }
}
