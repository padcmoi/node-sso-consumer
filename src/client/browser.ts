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
 * @module
 */

import { asFields, readMe } from "../parse.js";
import type { SsoMe } from "../types.js";

/** The provider's own: the session is over, and retrying changes nothing. */
const FATAL = new Set([4001, 4002, 4003]);
/** The bridge's own: the ticket was spent or expired. Worth asking for another. */
const TICKET_REFUSED = 4402;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_EVERY_MS = 25_000;
const SILENCE_LIMIT_MS = 60_000;

export interface SsoBrowserOptions {
  /**
   * Where the middleware is mounted, on THIS origin. The same `routes.basePath`
   * the server was given, and the only thing that normally has to be said twice.
   */
  basePath?: string;
  /** The path the realtime bridge listens on, when it was moved. */
  realtimePath?: string;
  /** The account as it changes, pushed whole. */
  onAccount?(me: SsoMe): void;
  /**
   * The session is over - signed out elsewhere, account disabled, access revoked.
   *
   * Send the reader to the portal from here. Nothing reconnects afterwards, and
   * nothing should: the next frame would be refused for the same reason.
   */
  onSignedOut?(): void;
  /** Anything else subscribed to. */
  onFrame?(topic: string, data: unknown): void;
  /** Beyond the three that are always on. */
  topics?: string[];
  /** Told when the stream comes and goes, for a badge saying so. */
  onConnectionChange?(connected: boolean): void;
}

/**
 * Followed for the whole session, whatever page is showing.
 *
 * THREE, and the third is what makes a revocation land. `me-changed` carries the
 * account and `me-signed-out` carries the end of it - but the provider computes that
 * second one from the IdP session and the account's access, and neither moves when
 * ONE application's session is ended from the sign-ins screen. So the frame never
 * comes, and the page keeps painting.
 *
 * `me-sessions` is the list that screen is drawn from, and the provider already marks
 * the caller's own line `current` in it. Nothing had to be added anywhere: the topic
 * exists, the flag exists, and this simply subscribes to it.
 */
const ALWAYS = ["me-changed", "me-signed-out", "me-sessions"];

/**
 * The session and its stream, from a page.
 *
 * Two things and they are one object on purpose: a page that reads the session
 * without following it is a page showing rights that were revoked ten minutes ago,
 * and every screen would have to remember to wire the second half.
 */
export class SsoBrowserClient {
  private socket: WebSocket | null = null;
  private resourceName = "";
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private stopped = false;
  private me: SsoMe | null = null;
  /** This session has been SEEN in the account's list of sign-ins. See `readOwnSession`. */
  private enrolled = false;
  /** The wake listeners are wired once, on the first `connect()`. */
  private listening = false;

  constructor(private readonly options: SsoBrowserOptions = {}) {}

  private get base() {
    return this.options.basePath ?? "/api/auth";
  }

  /** The last account seen, pushed or read. Null until the first read lands. */
  get account() {
    return this.me;
  }

  /**
   * The account, its details and its rights, from the application's own route.
   *
   * `null` means signed out, which is an answer rather than a failure: it is what
   * a page renders its signed-out state from.
   */
  async session() {
    const answer = await fetch(`${this.base}/session`, {
      // The sealed cookie is the credential, and it is `httpOnly`: nothing here
      // reads it, and this is what sends it.
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });

    if (answer.status === 401) {
      this.me = null;
      return null;
    }
    if (!answer.ok) throw new Error(`The session could not be read: ${answer.status}`);

    // Read field by field rather than trusted whole, exactly as the server half
    // reads it: a malformed answer becomes a named error here instead of an
    // `undefined` three components later, under a signed-in shell around nothing.
    const body = asFields(await answer.json());
    // Answered by the server rather than worked out here. A page cannot know which
    // resource its application is, and the convention it used to guess from - the
    // permission ending in `:access` - simply does not exist on an application that
    // declares no gate.
    if (typeof body?.resource === "string") this.resourceName = body.resource;
    this.me = readMe(body?.data);
    return this.me;
  }

  /** Which global ACL resource this application is, as the server answered it. */
  get resource() {
    return this.resourceName;
  }

  /**
   * What this application's account may do here, without the prefix.
   *
   * The resource defaults to the one the server named, so a caller passes nothing
   * and gets the right answer. With no resource at all - an application that
   * declares no gate, or a library standing in - the permissions ARE the actions and
   * come back whole rather than filtered down to nothing.
   */
  actions(resource = this.resourceName) {
    const held = this.me?.permissions.global ?? [];
    if (!resource) return held;
    const prefix = `${resource}:`;
    return held.filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
  }

  /**
   * Hides a button; it never refuses a call.
   *
   * The server decides, always. This exists so a reader is not shown a door that
   * answers 403 - which is a courtesy, not a control.
   */
  can(permission: string) {
    if (this.me?.permissions.isRoot) return true;
    return (this.me?.permissions.global ?? []).includes(permission);
  }

  /** Close this application's session. The SSO's own stays open. */
  /**
   * Sign out HERE, and go where the server says.
   *
   * The navigation is the point and it used to be missing: the route answered a
   * redirect, `fetch` does not follow one, and what a reader saw was a button that
   * cleared their cookie and left them looking at a page they no longer had a
   * session for - signed out, apparently still signed in, until they refreshed.
   *
   * Where to go is the server's answer, never a constant here: the portal when this
   * application is paired, its own sign-in screen when the library is standing in.
   */
  async logout() {
    const answer = await fetch(`${this.base}/logout`, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }).catch(() => null);

    this.close();

    const data = asFields(asFields(await answer?.json().catch(() => null))?.data);
    const exit = typeof data?.exit === "string" ? data.exit : "";
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
    this.stopped = false;
    this.listen();
    const me = await this.session();
    if (!me) return null;

    this.options.onAccount?.(me);
    await this.dial();
    return me;
  }

  /**
   * The three moments a dead connection is noticed, wired ONCE.
   *
   * The backoff climbs to thirty seconds, and coming back to a tab is exactly when
   * a stale page is in front of somebody: waiting it out there is half a minute of
   * rights that may already have been revoked. `online` is the same event seen from
   * the network's side.
   *
   * This belonged in every application before, and every application forgot it. It
   * is the client's job: it is the client that knows whether it holds a socket.
   *
   * `dial()` returns at once when one is already open, so these are free when
   * nothing is wrong. Registered once and never removed while the client lives -
   * `close()` sets `stopped`, which every path checks.
   */
  private listen() {
    if (this.listening || typeof window === "undefined") return;
    this.listening = true;

    const wake = () => {
      if (this.stopped || this.socket) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      // Straight through the backoff: a reader who just came back does not wait.
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectDelay = RECONNECT_BASE_MS;
      void this.dial();
    };

    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
  }

  /** Deliberate: no reconnection follows. */
  close() {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
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

  send(event: string, data: unknown) {
    // `auth` is refused by the bridge, deliberately: the account behind a socket
    // is decided by the ticket that opened it, never by what this page asks for.
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ event, data }));
  }

  subscribe(topic: string) {
    this.send("subscribe", { topic });
  }

  unsubscribe(topic: string) {
    this.send("unsubscribe", { topic });
  }

  /** End one of the account's OWN sign-ins. The answer is the next frame, not a reply. */
  revoke(sessionId: string) {
    this.send("revoke", { sessionId });
  }

  /**
   * A ticket, or WHY there is none - and the two reasons are not the same thing.
   *
   * `401` is the session: it is over, and the reader has to be told. `404` is the
   * STREAM: this deployment has none - no bridge attached, or a library standing in
   * for a provider that is not there to push anything - and the reader is signed in
   * perfectly well.
   *
   * Collapsing them into "no ticket" signed everybody out on a deployment that
   * simply has no socket, and where the sign-out led back to a page that dialled
   * again, it did it forever.
   */
  private async ticket() {
    const answer = await fetch(`${this.base}/realtime-ticket`, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (answer.status === 404) return { ticket: null, streamless: true };
    if (!answer.ok) return { ticket: null, streamless: false };

    const data = asFields(asFields(await answer.json())?.data);
    return { ticket: typeof data?.ticket === "string" ? data.ticket : null, streamless: false };
  }

  private async dial() {
    if (this.stopped || this.socket) return;

    // A fresh one every dial, reconnections included: it lives thirty seconds and
    // is spent on arrival, so the one that opened the last socket is long gone.
    const { ticket, streamless } = await this.ticket();

    // No stream here at all. Nothing to reconnect to and nobody to sign out: this
    // client goes quiet and the application keeps reading normally.
    if (streamless) {
      this.stopped = true;
      this.options.onConnectionChange?.(false);
      return;
    }

    if (!ticket) {
      // Refused rather than absent: the route asks the same question the reads do,
      // and it just answered that this session is over.
      this.ended();
      return;
    }

    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const path = this.options.realtimePath ?? "/_ws/realtime";
    const socket = new WebSocket(`${scheme}//${location.host}${path}?ticket=${encodeURIComponent(ticket)}`);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelay = RECONNECT_BASE_MS;
      // No `auth` frame: the bridge sends it, with the token the ticket stood for.
      for (const topic of [...ALWAYS, ...(this.options.topics ?? [])]) this.subscribe(topic);
      this.startHeartbeat();
      this.options.onConnectionChange?.(true);
    };

    socket.onmessage = (event: MessageEvent<string>) => this.onFrame(event.data);

    socket.onclose = (event: CloseEvent) => {
      if (this.socket === socket) this.socket = null;
      this.stopHeartbeat();
      this.options.onConnectionChange?.(false);

      if (FATAL.has(event.code)) {
        this.ended();
        return;
      }
      // A spent ticket is not a session that is over: dial again, and the next
      // one is minted by a route that will refuse it if it is.
      this.retry(event.code === TICKET_REFUSED ? 0 : this.reconnectDelay);
    };
  }

  private onFrame(raw: string) {
    this.lastFrameAt = Date.now();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const frame = asFields(parsed);
    if (!frame) return;

    const topic = typeof frame.topic === "string" ? frame.topic : null;
    // `#pong` answers the heartbeat and carries nothing: it has already done its
    // job by arriving, which is what moved `lastFrameAt` above.
    if (!topic || topic === "#pong") return;

    if (topic === "me-changed") {
      // The frame IS the new value: written straight in, with no re-read behind
      // it, which is the whole point of holding this socket open.
      const pushed = readMe(frame.data);

      // Unless what it took away is the door. `<resource>:access` is not one right
      // among the others: an account that loses it is no longer a user of this
      // application, so this frame is a sign-out and not a repaint. Written in and
      // handed on, it would grey out every button and leave the reader sitting on a
      // page the server has already started refusing.
      if (!this.admitted(pushed)) return this.ended();

      this.me = pushed;
      this.options.onAccount?.(this.me);
      return;
    }
    if (topic === "me-signed-out" && frame.data === true) {
      this.ended();
      return;
    }

    // The caller's own line in its own list of sign-ins. The provider marks it
    // `current`, and it stops being there the instant that session is ended from
    // the sign-ins screen - which is the ONE way of ending a session that
    // `me-signed-out` does not report, because neither the IdP session nor the
    // account's access has moved.
    if (topic === "me-sessions") {
      this.readOwnSession(frame.data);
      this.options.onFrame?.(topic, frame.data);
      return;
    }
    this.options.onFrame?.(topic, frame.data);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastFrameAt = Date.now();
    this.heartbeat = setInterval(() => {
      // A silent socket is reclaimed by most reverse proxies after a minute, and a
      // dead connection does not always raise a close event.
      //
      // ONLY WHILE THE TAB IS VISIBLE, and this is the whole of the bug it fixes. A
      // hidden tab has its timers throttled to about one firing a minute, so this
      // interval stops running at twenty-five seconds and starts running at sixty or
      // more: the check then reads a silence that never happened and hangs up a
      // perfectly healthy socket - precisely when a pushed change matters most,
      // since a background tab has nothing else that is going to ask.
      //
      // What that produced is an application where the stream only ever worked while
      // somebody was looking at it: a permission revoked in another window moved
      // nothing until the tab was focused again, which is the opposite of what
      // holding a socket open is for.
      const visible = typeof document === "undefined" || document.visibilityState === "visible";
      if (visible && Date.now() - this.lastFrameAt > SILENCE_LIMIT_MS) {
        this.socket?.close();
        return;
      }
      this.send("ping", {});
    }, PING_EVERY_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Whether this session is still in the account's own list of sign-ins.
   *
   * LATCHED, and it has to be: `current` is computed from the account, the app and
   * the IdP session, and a socket opened outside that flow has no line to match, so
   * "none is mine" would be true from the first frame and sign everybody out. It
   * means something only once a line HAS been seen and then goes.
   *
   * And when it goes, the answer is confirmed rather than acted on. Rotation replaces
   * the row every fifteen minutes - the old one revoked, a new one issued - so a frame
   * read in the gap between the two shows no line of ours while the session is
   * perfectly alive. One read of `/session` settles it, and that read is the one that
   * rotates and re-seals anyway.
   *
   * ONE request, and ONLY on this frame. Nothing here is on a timer: this client polls
   * NOTHING. The socket says when something ended, which is what a socket is for, and
   * the one read that follows is the answer to a question the socket already asked.
   */
  private readOwnSession(data: unknown) {
    if (!Array.isArray(data)) return;

    if (data.some((row) => asFields(row)?.current === true)) {
      this.enrolled = true;
      return;
    }
    if (!this.enrolled) return;

    void this.session().then(
      (me) => {
        if (!me || !this.admitted(me)) this.ended();
      },
      // The provider is unreachable, which is not a session that is over. Signing a
      // reader out on a network blink looks exactly like a mass revocation.
      () => undefined
    );
  }

  /**
   * May this account be here at all: does `global` hold everything `portail` asks
   * for.
   *
   * The same one comparison the server half makes, on the same two lists the
   * provider answered together - never guessed from the shape of a permission, and
   * never read from anything this page was configured with. An empty `portail`
   * requires nothing and admits everybody.
   */
  private admitted(me: SsoMe) {
    const required = me.permissions.portail;
    if (required.length === 0) return true;

    const held = new Set(me.permissions.global);
    return required.every((permission) => held.has(permission));
  }

  private retry(delay: number) {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.dial();
    }, delay);
    this.reconnectDelay = Math.min(Math.max(this.reconnectDelay, RECONNECT_BASE_MS) * 2, RECONNECT_MAX_MS);
  }
}

export const createSsoClient = (options: SsoBrowserOptions = {}) => new SsoBrowserClient(options);

/** Where the middleware sends a browser that has to sign in. */
export const signInUrl = (basePath = "/api/auth") => `${basePath}/sso/start`;
