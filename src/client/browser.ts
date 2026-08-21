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
  /** Beyond the two that are always on. */
  topics?: string[];
  /** Told when the stream comes and goes, for a badge saying so. */
  onConnectionChange?(connected: boolean): void;
}

/** Followed for the whole session, whatever page is showing. */
const ALWAYS = ["me-changed", "me-signed-out"];

/**
 * The session and its stream, from a page.
 *
 * Two things and they are one object on purpose: a page that reads the session
 * without following it is a page showing rights that were revoked ten minutes ago,
 * and every screen would have to remember to wire the second half.
 */
export class SsoBrowserClient {
  private socket: WebSocket | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private stopped = false;
  private me: SsoMe | null = null;

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
    this.me = readMe(asFields(await answer.json())?.data);
    return this.me;
  }

  /** What this application's account may do here, without the prefix. */
  actions(resource?: string) {
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
  async logout() {
    await fetch(`${this.base}/logout`, { method: "POST", credentials: "same-origin", redirect: "manual" });
    this.close();
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
    const me = await this.session();
    if (!me) return null;

    this.options.onAccount?.(me);
    await this.dial();
    return me;
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

  private async ticket() {
    const answer = await fetch(`${this.base}/realtime-ticket`, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!answer.ok) return null;

    const data = asFields(asFields(await answer.json())?.data);
    return typeof data?.ticket === "string" ? data.ticket : null;
  }

  private async dial() {
    if (this.stopped || this.socket) return;

    // A fresh one every dial, reconnections included: it lives thirty seconds and
    // is spent on arrival, so the one that opened the last socket is long gone.
    const ticket = await this.ticket();
    if (!ticket) {
      // No ticket means no session: the route asks the same question the reads do,
      // and it just answered no.
      this.stopped = true;
      this.options.onSignedOut?.();
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
        this.stopped = true;
        this.me = null;
        this.options.onSignedOut?.();
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
      this.me = readMe(frame.data);
      this.options.onAccount?.(this.me);
      return;
    }
    if (topic === "me-signed-out" && frame.data === true) {
      this.stopped = true;
      this.me = null;
      this.socket?.close();
      this.options.onSignedOut?.();
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
      if (Date.now() - this.lastFrameAt > SILENCE_LIMIT_MS) {
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
