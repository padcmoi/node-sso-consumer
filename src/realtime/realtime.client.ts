import WebSocket from "ws";
import type { SsoAuthService } from "../auth.service.js";
import { asFields, readMe } from "../parse.js";
import type { SsoLogger, SsoMe } from "../types.js";

/** Followed for the whole session, whatever page is showing. */
const ALWAYS: string[] = ["me-changed", "me-signed-out"];

/** The provider's own: the session is over, and retrying changes nothing. */
const FATAL = new Set([4001, 4002, 4003]);

const PING_EVERY_MS = 25_000;
const SILENCE_LIMIT_MS = 60_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface SsoRealtimeOptions {
  auth: SsoAuthService;
  /** The socket lives on a port of its own, next to the API's. */
  url: string;
  /** The account as it changes, pushed whole. Write it in; do not re-read `me`. */
  onAccount?(me: SsoMe): void;
  /** The session is over: empty everything and send the reader to the portal. */
  onSignedOut?(): void;
  /** Anything else subscribed to, `me-sessions` included. */
  onFrame?(topic: string, data: unknown): void;
  /** Beyond the two that are always on. */
  topics?: string[];
  logger?: SsoLogger;
}

/**
 * The pushed half of the protocol, so an app reads `me` once per page instead of
 * on every navigation and every window focus.
 *
 * Two credentials guard the stream and they answer two questions. The SIGNATURE,
 * on the handshake, says which app is dialling - and it is why a browser cannot
 * open this itself. The ACCESS TOKEN, in the first frame, says which account.
 *
 * Both always-on topics are subscribed together and neither can be dropped:
 * `me-changed` alone is a cache, and a revoked account would keep walking around
 * holding the last one it was pushed. `me-signed-out` is what tears it down.
 */
export class SsoRealtimeClient {
  private socket: WebSocket | null = null;
  private accessToken: string | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private stopped = false;

  constructor(private readonly options: SsoRealtimeOptions) {}

  /** Open it, and keep it open: a dropped socket comes back on its own. */
  async connect(accessToken: string) {
    this.accessToken = accessToken;
    this.stopped = false;
    await this.dial();
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

  private async dial() {
    if (this.stopped || this.socket || !this.accessToken) return;

    const headers = await this.options.auth.realtimeHandshake({ url: this.options.url });
    const socket = new WebSocket(this.options.url, { headers });
    this.socket = socket;

    socket.on("open", () => {
      this.reconnectDelay = RECONNECT_BASE_MS;
      // Within seconds, or the provider closes with 4002.
      this.send("auth", { accessToken: this.accessToken });
      for (const topic of [...ALWAYS, ...(this.options.topics ?? [])]) this.subscribe(topic);
      this.startHeartbeat();
    });

    // Frames arrive as a buffer, or as the fragments of one when the payload was
    // split: joined here rather than stringified blindly, which on an array of
    // buffers reads as "[object Object]".
    socket.on("message", (raw: WebSocket.RawData) => {
      if (Array.isArray(raw)) return this.onFrame(Buffer.concat(raw).toString("utf8"));
      if (Buffer.isBuffer(raw)) return this.onFrame(raw.toString("utf8"));
      this.onFrame(Buffer.from(new Uint8Array(raw)).toString("utf8"));
    });

    socket.on("close", (code: number) => {
      if (this.socket === socket) this.socket = null;
      this.stopHeartbeat();

      // The provider also closes on its own 10s check when the IdP session or the
      // access is gone: the topic is the fast path, this is the backstop.
      if (FATAL.has(code)) {
        this.stopped = true;
        this.options.onSignedOut?.();
        return;
      }
      this.retry();
    });

    socket.on("error", (error: Error) => this.options.logger?.warn?.(`[sso] realtime socket error: ${error.message}`));
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

    // The frame IS the new value: written straight in, with no re-read behind it,
    // which is the whole point of holding this socket open.
    if (topic === "me-changed") return this.options.onAccount?.(readMe(frame.data));
    if (topic === "me-signed-out" && frame.data === true) {
      this.stopped = true;
      this.socket?.close();
      return this.options.onSignedOut?.();
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

  private retry() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.dial();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}
