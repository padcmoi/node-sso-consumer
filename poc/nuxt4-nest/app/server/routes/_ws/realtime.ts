import { WebSocket } from "ws";
import { PROXY_CFG } from "../../proxy.config";

// x-core's realtime, relayed.
//
// The bridge itself is the API's: it holds the HMAC credential that signs the
// handshake to x-core, and the access token the ticket stands for. This end carries
// bytes, both ways.
//
// What it must never do is decide anything. The ticket is what says who is at the
// other end, it is minted by the API and spent by the API, and this file cannot read
// it for anything - which is the point: a relay that authenticated would be a second
// opinion on a session, and the day the two disagree one of them is wrong.
//
// The reverse proxy in front of this console must pass `Upgrade` and `Connection`
// through, or this route is never reached at all and the page sits on "hors ligne"
// with nothing in any log.

interface RelayContext {
  ticket: string;
  upstream?: WebSocket;
  /** What the page sent before the far side was up: it subscribes the moment its own socket opens. */
  queue: string[];
}

function contextOf(peer: { context: Record<string, unknown> }) {
  return peer.context.relay as RelayContext | undefined;
}

export default defineWebSocketHandler({
  // Neither throws nor answers a status: Nitro registers this straight onto the
  // server's `upgrade` event, and a client that has walked away turns a rejection
  // into an unhandled one. A handshake with no ticket is completed here and closed
  // in `open`.
  upgrade(request) {
    request.context.relay = {
      ticket: /[?&]ticket=([\w-]+)/.exec(request.url)?.[1] ?? "",
      queue: [],
    } satisfies RelayContext;
  },

  open(peer) {
    const relay = contextOf(peer);
    if (!relay?.ticket) return peer.close(4402, "unauthorized");

    const upstream = new WebSocket(`${PROXY_CFG.wsBaseInternal}/_ws/realtime?ticket=${relay.ticket}`);
    relay.upstream = upstream;

    upstream.on("open", () => {
      for (const frame of relay.queue.splice(0)) upstream.send(frame);
    });
    upstream.on("message", (data) => peer.send(String(data)));
    // x-core's own 4xxx mean "do not retry, sign in again", and they travel through
    // both hops so the page can tell them from a transport failure.
    upstream.on("close", (code, reason) => peer.close(code >= 4000 && code <= 4999 ? code : 1000, String(reason)));
    upstream.on("error", () => peer.close(1011, "upstream unavailable"));
  },

  message(peer, message) {
    const relay = contextOf(peer);
    if (!relay) return;

    const frame = message.text();
    if (relay.upstream?.readyState === WebSocket.OPEN) relay.upstream.send(frame);
    else relay.queue.push(frame);
  },

  close(peer) {
    contextOf(peer)?.upstream?.close();
  },

  error(peer) {
    contextOf(peer)?.upstream?.close();
  },
});
