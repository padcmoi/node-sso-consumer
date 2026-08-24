/**
 * The browser half, so a page holds no SSO code either.
 *
 * The server half of this library ends at the ticket: it mints one, bridges the
 * socket and refuses an `auth` frame from the page. What remained on every
 * application's side was the same two hundred lines - ask for the ticket, dial,
 * reconnect, tell a session that is over from a connection that dropped - written
 * again per application and drifting apart immediately. This is that, once.
 *
 * NOTHING from Node is imported here, and nothing may be: this file runs in a
 * browser, so `ws`, `node:crypto` and `Buffer` are all absent. It speaks to the
 * routes the middleware serves, on the application's own origin, and never to the
 * provider - the two credentials the provider wants are server secrets, and a page
 * that could hold them would be a page that could sign as the application.
 *
 * A FACADE, and only that. Four files hold what it does: `options.ts` is what a
 * page lends, `routes.ts` the three questions asked of this application, `rights.ts`
 * what the account may do, `stream.ts` the connection with its own state, and
 * `frames.ts` what each topic means. What is left here is the session itself.
 *
 * @module
 */

import { SsoStream } from "./stream.js";
import { actionsOf, admitted, can } from "./rights.js";
import { endSession, exitOf, readSession, takeTicket } from "./routes.js";
import { ownSessionVerdict, routeFrame } from "./frames.js";
import type { SsoBrowserOptions } from "./options.js";
import type { SsoMe } from "../types.js";

export type { SsoBrowserOptions } from "./options.js";

/**
 * The session and its stream, from a page.
 *
 * Two things and they are one object on purpose: a page that reads the session
 * without following it is a page showing rights that were revoked ten minutes ago,
 * and every screen would have to remember to wire the second half.
 */
export class SsoBrowserClient {
  private resourceName = "";
  private me: SsoMe | null = null;
  /** This session has been SEEN in the account's list of sign-ins. See `readOwnSession`. */
  private enrolled = false;

  private readonly stream: SsoStream;

  constructor(private readonly options: SsoBrowserOptions = {}) {
    this.stream = new SsoStream({
      realtimePath: options.realtimePath,
      topics: options.topics,
      ticket: () => takeTicket(this.base),
      onFrame: (raw) => this.onFrame(raw),
      onEnded: () => this.ended(),
      onConnectionChange: (connected) => options.onConnectionChange?.(connected),
    });
  }

  private get base() {
    return this.options.basePath ?? "/api/auth";
  }

  /** The last account seen, pushed or read. Null until the first read lands. */
  get account() {
    return this.me;
  }

  /** Which global ACL resource this application is, as the server answered it. */
  get resource() {
    return this.resourceName;
  }

  /**
   * The account, its details and its rights, from the application's own route.
   *
   * `null` means signed out, which is an answer rather than a failure: it is what
   * a page renders its signed-out state from.
   */
  async session() {
    const answer = await readSession(this.base);
    if (answer.resource !== null) this.resourceName = answer.resource;
    this.me = answer.me;
    return this.me;
  }

  /**
   * What this application's account may do here, without the prefix.
   *
   * The resource defaults to the one the server named, so a caller passes nothing
   * and gets the right answer.
   */
  actions(resource = this.resourceName) {
    return actionsOf(this.me, resource);
  }

  /** Hides a button; it never refuses a call. The server decides, always. */
  can(permission: string) {
    return can(this.me, permission);
  }

  /**
   * Sign out HERE, and go where the server says.
   *
   * The navigation is the point and it used to be missing: the route answered a
   * redirect, `fetch` does not follow one, and what a reader saw was a button that
   * cleared their cookie and left them looking at a page they no longer had a
   * session for - signed out, apparently still signed in, until they refreshed.
   *
   * The socket goes down BETWEEN the call and the reading of its answer, so nothing
   * dials back onto a session that has just ended.
   */
  async logout() {
    const answer = await endSession(this.base);

    this.close();

    const exit = await exitOf(answer);
    if (exit) location.assign(exit);
  }

  /**
   * Read the account, then follow it.
   *
   * In that order, and it matters: the first read is what proves there is a
   * session at all, and dialling a socket without one is a socket that opens and
   * closes on the ticket route's 401.
   */
  async connect() {
    this.stream.arm();
    const me = await this.session();
    if (!me) return null;

    this.options.onAccount?.(me);
    await this.stream.dial();
    return me;
  }

  /** Deliberate: no reconnection follows. */
  close() {
    this.stream.close();
  }

  send(event: string, data: unknown) {
    this.stream.send(event, data);
  }

  subscribe(topic: string) {
    this.stream.subscribe(topic);
  }

  unsubscribe(topic: string) {
    this.stream.unsubscribe(topic);
  }

  /** End one of the account's OWN sign-ins. The answer is the next frame, not a reply. */
  revoke(sessionId: string) {
    this.send("revoke", { sessionId });
  }

  /**
   * Sign out and leave, from wherever the reason was found.
   *
   * One place, because a session that is over has to end the same way whether the
   * provider closed the socket, pushed the frame, or simply answered `401` to the
   * next question. Everything is torn down BEFORE the application is told, so a
   * listener that navigates does not race a reconnection.
   */
  private ended() {
    this.close();
    this.me = null;
    this.options.onSignedOut?.();
  }

  private onFrame(raw: string) {
    routeFrame(raw, {
      onAccount: (me) => {
        this.me = me;
        this.options.onAccount?.(me);
      },
      onEnded: () => this.ended(),
      onSessions: (data) => this.readOwnSession(data),
      onOther: (topic, data) => this.options.onFrame?.(topic, data),
    });
  }

  /**
   * The latch behind `me-sessions`, and the ONE read that settles it.
   *
   * Nothing here is on a timer: this client polls NOTHING. The socket says when
   * something ended, which is what a socket is for, and the read that follows is
   * the answer to a question the socket already asked.
   */
  private readOwnSession(data: unknown) {
    const verdict = ownSessionVerdict(data, this.enrolled);
    if (verdict === "enrolled") {
      this.enrolled = true;
      return;
    }
    if (verdict !== "gone") return;

    void this.session().then(
      (me) => {
        if (!me || !admitted(me)) this.ended();
      },
      // The provider is unreachable, which is not a session that is over. Signing a
      // reader out on a network blink looks exactly like a mass revocation.
      () => undefined
    );
  }
}

export const createSsoClient = (options: SsoBrowserOptions = {}) => new SsoBrowserClient(options);

/** Where the middleware sends a browser that has to sign in. */
export const signInUrl = (basePath = "/api/auth") => `${basePath}/sso/start`;
