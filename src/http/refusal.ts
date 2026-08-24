import { SsoError, statusOf, type SsoErrorCode } from "../errors.js";
import { redirect, sendJson } from "./web.js";
import type { MiddlewareContext } from "./middleware-options.js";
import type { SsoRefusal } from "../bridge/contract.js";
import type { WebRequest, WebResponse } from "./web.js";

/**
 * THE refusal, and there is only one for every way a request can fail to prove
 * who is asking.
 *
 * x-core's consumer session decides life or death of a reader, and this library
 * is the only thing that asks it. So all of these are the same answer: nobody is
 * signed in, x-core refused, x-core could not be reached, or this application was
 * never paired and could not ask at all. In each case what is known about the
 * reader is nothing, and nothing is what may be served.
 *
 * The portal is where they go, because it is the only thing in this ecosystem
 * that signs a human in. And when there is no portal to go to - an application
 * nobody configured never received one - the answer is `500`: the fault is the
 * application's, no round trip fixes it, and a redirect built from an empty
 * string leaves the browser exactly where it is, painting the shell of a
 * signed-in application around no account.
 */
export function refuse(
  ctx: MiddlewareContext,
  req: WebRequest,
  res: WebResponse,
  code: SsoErrorCode = "UNAUTHORIZED",
  message?: string
) {
  // Standing in, the way back is this application's own sign-in screen. There is no
  // portal: that address arrives with a pairing that never happened.
  const portal = ctx.options.standingIn?.() ? (ctx.options.loginPath ?? "/login") : ctx.options.portalUrl();
  // No portal means never paired: the address arrives WITH the pairing. So there
  // is nowhere to send anybody, no round trip that would help, and the fault is
  // this application's - which is a `500` however it ends up being expressed.
  const refusal: SsoRefusal = portal
    ? { status: statusOf(new SsoError(code, "")), code, message: message ?? "Not signed in", redirectTo: portal }
    : {
        status: 500,
        code: "NOT_CONFIGURED",
        message: "This application is not configured for authentication",
        redirectTo: null,
      };

  if (refusal.status === 500) ctx.options.logger?.error?.(`[sso] ${refusal.message}`);

  // Lent by the application, and called from INSIDE the decision rather than
  // around it. It may throw - Nitro and Nest both want that - and the throw
  // travels untouched, which is why nothing here catches it.
  ctx.options.errors?.(refusal, req, res);

  // Reached when the application lent nothing, or lent something that answered
  // by returning. Either way the library never leaves a request hanging on a
  // refusal, and never writes over a response the application already ended.
  if (res.writableEnded) return;
  if (refusal.redirectTo) return redirect(res, refusal.redirectTo);
  sendJson(res, refusal.status, { error: refusal.message });
}
