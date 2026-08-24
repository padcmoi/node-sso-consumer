/**
 * The connection, and everything that keeps it alive.
 *
 * Its OWN object because it owns its own state and nothing else reads it: the
 * socket, the backoff, the reconnection timer, the heartbeat and the mark of the
 * last frame are seven fields that exist for one job. What is done with a frame is
 * decided elsewhere; this decides whether there is a socket to receive one.
 *
 * Nothing from Node here either. `WebSocket`, `location` and `window` are the
 * browser's own.
 *
 * @module
 */

import { ALWAYS } from "./frames.js";

/** The provider's own: the session is over, and retrying changes nothing. */
const FATAL = new Set([4001, 4002, 4003]);
/** The bridge's own: the ticket was spent or expired. Worth asking for another. */
const TICKET_REFUSED = 4402;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_EVERY_MS = 25_000;
const SILENCE_LIMIT_MS = 60_000;

export interface SsoStreamOptions {
  /** The path the realtime bridge listens on, when it was moved. */
  realtimePath?: string;
  /** Beyond the three that are always on. */
  topics?: string[];
  /** A fresh ticket, or the reason there is none. */
  ticket(): Promise<{ ticket: string | null; streamless: boolean }>;
  /** A frame, raw and unparsed: this object does not read them. */
  onFrame(raw: string): void;
  /** The session is over, and no reconnection follows. */
  onEnded(): void;
  /** Told when the stream comes and goes, for a badge saying so. */
  onConnectionChange?(connected: boolean): void;
}

export class SsoStream {
  private socket: WebSocket | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private stopped = false;
  /** The wake listeners are wired once, on the first `arm()`. */
  private listening = false;

  constructor(private readonly options: SsoStreamOptions) {}

  /**
   * Ready to hold a socket: reconnections allowed, wake listeners wired.
   *
   * Separate from `dial()` because the session is read BETWEEN the two, and a
   * reader coming back to their tab in that gap must already find a client that
   * answers rather than one that is still switched off.
   */
  arm() {
    this.stopped = false;
    this.listen();
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

  async dial() {
    if (this.stopped || this.socket) return;

    // A fresh one every dial, reconnections included: it lives thirty seconds and
    // is spent on arrival, so the one that opened the last socket is long gone.
    const { ticket, streamless } = await this.options.ticket();

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
      this.options.onEnded();
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

    socket.onmessage = (event: MessageEvent<string>) => {
      this.lastFrameAt = Date.now();
      this.options.onFrame(event.data);
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.socket === socket) this.socket = null;
      this.stopHeartbeat();
      this.options.onConnectionChange?.(false);

      if (FATAL.has(event.code)) {
        this.options.onEnded();
        return;
      }
      // A spent ticket is not a session that is over: dial again, and the next
      // one is minted by a route that will refuse it if it is.
      this.retry(event.code === TICKET_REFUSED ? 0 : this.reconnectDelay);
    };
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

  private retry(delay: number) {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.dial();
    }, delay);
    this.reconnectDelay = Math.min(Math.max(this.reconnectDelay, RECONNECT_BASE_MS) * 2, RECONNECT_MAX_MS);
  }
}
