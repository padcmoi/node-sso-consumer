import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from "@nestjs/common";
import { redirect, sendJson, SsoError, type WebRequest, type WebResponse } from "@gestionpratique/node-sso-consumer";
import { XcoreService } from "./xcore.service";

/**
 * Where a refusal is SPOKEN, and the only place on this side that speaks one.
 *
 * The distinction that matters: `FORBIDDEN` is about the ACCOUNT and must not be
 * redirected to a sign-in, which would loop - signing in again changes nothing about
 * what it holds. `UNAUTHORIZED` is about the SESSION, which a round trip does fix.
 *
 * Nothing is recomputed here. The guard decided whether and why - it is the only
 * thing that talks to x-core, so it is the only thing that can - and this turns that
 * conclusion into an answer.
 *
 * `sendJson` and `redirect` come from the library rather than from Express's `res`:
 * this file writes on the minimal response shape every Node framework agrees on, and
 * a `res.json` here is what would pin this API to one platform.
 */
@Catch(SsoError)
export class XcoreExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Sso");

  constructor(private readonly xcore: XcoreService) {}

  catch(error: SsoError, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<WebRequest>();
    const res = http.getResponse<WebResponse>();

    if (error.code === "FORBIDDEN") {
      this.logger.warn(error.message);
      return sendJson(res, 403, { error: error.message });
    }

    if (error.code === "UNAUTHORIZED") {
      // An XHR gets a status it can act on; a NAVIGATION gets the portal, which is
      // the only thing in this ecosystem that signs a human in. The `302` travels
      // back through the console's relay untouched - it is set to follow nothing -
      // and the browser walks it.
      const wantsJson = String(req.headers?.accept ?? "").includes("application/json");
      const portal = this.xcore.bridge.portalUrl;

      if (wantsJson || !portal) return sendJson(res, 401, { error: "No session" });
      return redirect(res, portal);
    }

    // NO_CREDENTIAL, NOT_XCORE, NOT_CONFIGURED, UNREACHABLE, MALFORMED_ANSWER,
    // REFUSED: this application's problem, and never the reader's to act on. A `401`
    // here would tell them to sign in to an application that cannot sign anyone in.
    this.logger.error(`${error.code}: ${error.message}`);
    sendJson(res, 503, { error: "The identity provider is unavailable" });
  }
}
