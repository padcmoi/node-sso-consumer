import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { SsoAuthService } from "../auth.service.js";
import { asFields } from "../parse.js";
import type { SsoLogger } from "../types.js";
import { MemoryTicketStore, TICKET_TTL_S, mintTicket, type TicketStore } from "./tickets.js";

/**
 * The socket the BROWSER opens, bridged to the one the provider serves.
 *
 * A WebSocket is not bound by the same-origin policy: any page on the internet can
 * open one to this host and the browser will attach the session cookie to it. So
 * the cookie must not be what opens the stream. And the two credentials the
 * provider wants are both server secrets - the HMAC signature on the handshake,
 * and the access token in the first frame - so the page cannot dial it directly
 * either.
 *
 * Four moves, and one refusal:
 *
 *   1. the page asks over its authenticated session for a TICKET - an ordinary
 *      XHR, which CORS does protect, unlike a socket;
 *   2. it dials `wss://<own host><path>?ticket=…`;
 *   3. this bridge redeems the ticket, once, and dials the provider with the
 *      signature;
 *   4. it sends the `auth` frame itself, with the token the ticket stood for.
 *
 * And it REFUSES an `auth` frame coming from the page: the account behind a socket
 * is decided by the ticket that opened it, never by what the page asks for.
 */

/** Worth asking for another: the ticket was spent, or it expired. Not fatal. */
const TICKET_REFUSED = 4402;

export interface SsoRealtimeBridgeOptions {
  auth: SsoAuthService;
  /** The provider's socket, on its own port. */
  upstreamUrl: string;
  /** The path the page dials on THIS host. */
  path?: string;
  tickets?: TicketStore;
  /**
   * Whether this bridge can hold anything, asked at each upgrade.
   *
   * A function, and asked at the upgrade rather than at `attach`: a boot that has
   * not finished pairing has no credential to sign a handshake with, and an
   * application that withdrew has no upstream at all.
   *
   * The upgrade is then LEFT ALONE rather than answered - and that is a refusal
   * here, not a stand-aside: nothing else in the application listens on this path,
   * so the socket never opens. A bridge that accepted it would be a live feed with
   * no account behind it.
   */
  serving?(): boolean;
  logger?: SsoLogger;
}

export class SsoRealtimeBridge {
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly tickets: TicketStore;

  constructor(private readonly options: SsoRealtimeBridgeOptions) {
    this.tickets = options.tickets ?? new MemoryTicketStore();
  }

  get path() {
    return this.options.path ?? "/_ws/realtime";
  }

  /**
   * Thirty seconds, single use.
   *
   * The access token never reaches the page: what it gets is this, and what it
   * stands for is redeemed here.
   */
  async ticket(accessToken: string) {
    const value = mintTicket();
    await this.tickets.put(value, accessToken, TICKET_TTL_S);
    return { ticket: value, expiresIn: TICKET_TTL_S };
  }

  /**
   * Hang the bridge on the application's own HTTP server.
   *
   * Handles the upgrades on its path and returns for every other, so several
   * bridges - this one, an application's own feeds - can share one server without
   * knowing about each other.
   */
  attach(server: { on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown }) {
    server.on("upgrade", (req, socket, head) => {
      if (this.options.serving?.() === false) return;

      const url = new URL(req.url ?? "/", "http://internal");
      // Matched EXACTLY. A path that is a prefix of another means two handlers
      // answer one upgrade, the second `handleUpgrade` throws out of a promise
      // nobody can catch, and that unhandled rejection is the worker gone and
      // restarted for as long as anybody opens that page.
      if (url.pathname !== this.path) return;

      const ticket = url.searchParams.get("ticket");
      if (!ticket) {
        // Refused before it ever becomes a socket, so an unticketed dial gets a
        // plain HTTP answer rather than a connection that closes a moment later.
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.server.handleUpgrade(req, socket, head, (client) => {
        void this.open(client, ticket);
      });
    });
    return server;
  }

  private async open(client: WebSocket, ticket: string) {
    const accessToken = await this.tickets.take(ticket);
    if (!accessToken) {
      client.close(TICKET_REFUSED, "Ticket spent or expired");
      return;
    }

    let upstream: WebSocket;
    try {
      // WHICH APP: the handshake is signed exactly as any other call, and the
      // provider verifies it before the upgrade completes.
      const headers = await this.options.auth.realtimeHandshake({ url: this.options.upstreamUrl });
      upstream = new WebSocket(this.options.upstreamUrl, { headers });
    } catch (error) {
      this.options.logger?.error?.(`[sso] realtime bridge could not sign its handshake: ${String(error)}`);
      client.close(1011, "Upstream unavailable");
      return;
    }

    // The page subscribes the instant its own socket opens, which is before this
    // one is up. Held rather than dropped: a lost subscription is a screen that
    // never updates and nothing saying why.
    const queued: string[] = [];

    upstream.on("open", () => {
      // WHICH USER: the first frame, within seconds, or the provider closes (4002).
      upstream.send(JSON.stringify(this.options.auth.realtimeAuthFrame({ accessToken })));
      for (const frame of queued.splice(0)) upstream.send(frame);
    });

    upstream.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      if (client.readyState === WebSocket.OPEN) client.send(textOf(raw));
    });

    // The close code travels through untouched: 4001 / 4002 / 4003 mean "do not
    // retry, the session is over", and a client cannot tell them from a transport
    // failure any other way.
    upstream.on("close", (code: number, reason: Buffer) => {
      if (client.readyState === WebSocket.OPEN) client.close(usableCode(code), reason.toString());
    });

    upstream.on("error", (error: Error) => {
      this.options.logger?.warn?.(`[sso] realtime upstream error: ${error.message}`);
      if (client.readyState === WebSocket.OPEN) client.close(1011, "Upstream error");
    });

    client.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const frame = textOf(raw);
      if (!forwardable(frame)) {
        this.options.logger?.warn?.("[sso] a frame from the page was refused: it named `auth`, or could not be read");
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
      else queued.push(frame);
    });

    client.on("close", () => upstream.close());
    client.on("error", () => upstream.close());
  }
}

const textOf = (raw: Buffer | ArrayBuffer | Buffer[]) => {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return Buffer.from(new Uint8Array(raw)).toString("utf8");
};

/**
 * Whether a frame from the page may travel upstream.
 *
 * Two refusals, and both matter. An `auth` frame is refused because the account
 * behind this socket was decided by the TICKET that opened it - a page asking to be
 * somebody else is a page asking for somebody else's data.
 *
 * Anything that will not parse is refused too, and that is the stricter half:
 * forwarded, it is a byte string this end never looked at, arriving at the provider
 * over a signed connection that vouches for this application. What cannot be read
 * cannot be vouched for.
 */
const forwardable = (frame: string) => {
  try {
    return asFields(JSON.parse(frame))?.event !== "auth";
  } catch {
    return false;
  }
};

/**
 * A close code a browser is allowed to receive.
 *
 * The provider's own `4xxx` travel through untouched: they mean "do not retry, sign
 * in again", and a client cannot tell that from a transport failure any other way.
 *
 * Everything else becomes 1011. 1005 and 1006 are "no code" and "abnormal": they
 * describe what happened to a connection and cannot be SENT, so passing them on
 * throws instead of closing.
 */
const usableCode = (code: number) => (code === 1000 || (code >= 4000 && code <= 4999) ? code : 1011);
