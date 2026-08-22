import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import type { WebRequest } from "@gestionpratique/node-sso-consumer";
import { XcoreGuard } from "../sso/xcore.guard";
import { XcoreService } from "../sso/xcore.service";

/**
 * The whole business surface of this POC: two routes, and one of them is public.
 *
 * It is deliberately this thin. What is being proved is not what an API can do - it
 * is that an ORDINARY Nest controller gets the account behind a request without
 * writing a line of session code, and refuses without writing a line of refusal.
 */
@Controller("api")
export class SessionController {
  constructor(private readonly xcore: XcoreService) {}

  /**
   * Where a browser goes when it has no session, and where it lands after a
   * sign-out.
   *
   * ONE address for three exits, and they are the same exit seen from three sides: a
   * reader who signs out, a session refused because it is over, and a session
   * revoked from somewhere else.
   *
   * Served rather than written into the console's build, because x-core is what
   * knows where its own portal lives: it answers the address at pairing, and a copy
   * baked into a page would keep sending readers to one that has moved.
   *
   * NOT GUARDED, and it must not be: it is a public URL and it is the one thing
   * somebody with no session legitimately needs.
   */
  @Get("portal")
  portal() {
    return { url: this.xcore.bridge.portalUrl || null };
  }

  /**
   * The account, read by a controller rather than by one of the library's routes.
   *
   * `req.me` is put there by the guard, which asked x-core a moment ago. Nothing is
   * asked again here: a second read would be another round trip - and another token
   * rotation - for the same answer.
   *
   * Add `@RequirePermissions("some-action")` to see the other half work: the guard
   * refuses with `403` naming what is missing, before this method is entered.
   */
  @Get("me")
  @UseGuards(XcoreGuard)
  me(@Req() req: WebRequest) {
    return { data: req.me };
  }
}
