import "server-only";
import { SsoError } from "@gestionpratique/node-sso-consumer";
import { requests, xcore } from "./runtime";

/**
 * What a Server Component or a Server Action asks, and it costs NOTHING.
 *
 * The account was resolved once, by the custom server, before Next was handed the
 * request - so this is a read out of `AsyncLocalStorage` and not a round trip. Ten
 * components asking ten times ask x-core zero times.
 *
 * That is the difference with `fetch("/api/auth/session")`, which is what an
 * application without a custom server would have to write: an HTTP call to itself,
 * per component, with the cookie forwarded by hand.
 */
export const currentAccount = () => requests().getStore()?.me ?? null;

/**
 * The same, refusing rather than answering null.
 *
 * For an Action: a component that renders for nobody paints zeros, and an ACTION
 * that runs for nobody writes.
 */
export const requireAccount = () => {
  const me = currentAccount();
  if (!me) throw new SsoError("UNAUTHORIZED", "No session");
  return me;
};

/**
 * Refuse unless every action is held, against what x-core answered for THIS request.
 *
 * THE POINT OF THE WHOLE POC IS HERE. A Server Action is a POST that React wires up
 * for you, and it is easy to read it as "a function the page calls" - which is
 * exactly how it gets shipped with no check in it. It is a public endpoint: its id
 * is in the page, anybody can post to it, and nothing but this line stands in front.
 *
 * Hiding the button is a courtesy. This is the control.
 */
export const requirePermissions = (...actions: string[]) => {
  const scope = requests().getStore();
  if (!scope?.me) throw new SsoError("UNAUTHORIZED", "No session");
  // Throws FORBIDDEN naming what is missing.
  xcore().assert(scope.req, ...actions);
  return scope.me;
};

/**
 * The raw request and response of the current exchange.
 *
 * For the one thing that needs them: `xcore.logout(req, res)` clears the sealed
 * cookie, and a cookie is written on a response. Reachable from a Server Action
 * because the action runs inside the custom server's own async context, on a
 * response Next has not sent yet.
 */
export const currentExchange = () => {
  const scope = requests().getStore();
  if (!scope) throw new Error("No request scope: this ran outside the custom server");
  return scope;
};
