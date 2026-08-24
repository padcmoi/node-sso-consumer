import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsoBrowserClient } from "../src/client/browser.js";

/**
 * The browser half, which had no suite at all.
 *
 * Eleven test files covered the server side and none covered this one, so the two
 * behaviours 0.1.2 changes - a heartbeat that hung up healthy sockets in a hidden
 * tab, and a client that reconnected on nothing - could break again without a single
 * red line.
 *
 * There is no DOM here: the suite runs in Node, and this file builds the three
 * globals the client reaches for. That is the whole point of doing it by hand - what
 * is asserted is exactly which browser facts the client reads, and a jsdom would hide
 * that behind an implementation nobody looks at.
 */

const PING_EVERY_MS = 25_000;
const SILENCE_LIMIT_MS = 60_000;

interface FakeSocket {
  readyState: number;
  sent: string[];
  closed: boolean;
  send(frame: string): void;
  close(): void;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
}

let sockets: FakeSocket[] = [];
let listeners: Record<string, (() => void)[]> = {};
let visibility: "visible" | "hidden" = "visible";

const globals = globalThis as unknown as Record<string, unknown>;

/** The last socket the client opened, which is the only one it holds. */
const current = () => sockets[sockets.length - 1];

const register = (target: Record<string, unknown>) => {
  target.addEventListener = (event: string, handler: () => void) => {
    (listeners[event] ??= []).push(handler);
  };
};

const fire = (event: string) => (listeners[event] ?? []).forEach((handler) => handler());

beforeEach(() => {
  sockets = [];
  listeners = {};
  visibility = "visible";

  globals.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    closed = false;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    constructor() {
      sockets.push(this);
    }
    send(frame: string) {
      this.sent.push(frame);
    }
    close() {
      this.closed = true;
      this.readyState = 3;
      this.onclose?.({ code: 1006 });
    }
  };

  const window = {} as Record<string, unknown>;
  register(window);
  globals.window = window;

  const document = {
    get visibilityState() {
      return visibility;
    },
  } as Record<string, unknown>;
  register(document);
  globals.document = document;

  globals.location = { protocol: "https:", host: "app.example.com" };

  // The session, then the ticket: the two calls `connect()` makes before it dials.
  globals.fetch = vi.fn((url: string) => {
    if (String(url).endsWith("/session")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              user: { id: "u1", email: "a@b.c", displayName: "A", avatarUrl: null },
              profile: {},
              permissions: { global: [], portail: [], isRoot: false, groups: [] },
            },
            resource: "demo",
          }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { ticket: "t-1" } }) });
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete globals.WebSocket;
  delete globals.window;
  delete globals.document;
  delete globals.location;
  delete globals.fetch;
});

describe("the heartbeat", () => {
  it("does NOT hang up a silent socket while the tab is hidden", async () => {
    vi.useFakeTimers();
    const client = new SsoBrowserClient();
    await client.connect();
    const socket = current();
    socket.onopen?.();

    // A hidden tab has its timers throttled to about one firing a minute, so the
    // check reads a silence that never happened. Closing here is what made a
    // background tab stop receiving - which is where a pushed change matters most.
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS + PING_EVERY_MS);

    expect(socket.closed).toBe(false);
  });

  it("hangs up a silent socket while the tab is visible", async () => {
    vi.useFakeTimers();
    const client = new SsoBrowserClient();
    await client.connect();
    // Held rather than read back: closing one makes the client dial another at once,
    // so `current()` would be the replacement and the assertion would read false on a
    // socket that was hung up correctly.
    const socket = current();
    socket.onopen?.();

    await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS + PING_EVERY_MS);

    expect(socket.closed).toBe(true);
  });

  it("counts any frame as a sign of life, `#pong` included", async () => {
    vi.useFakeTimers();
    const client = new SsoBrowserClient();
    await client.connect();
    const socket = current();
    socket.onopen?.();

    // Half the limit, a frame, then half again: never sixty seconds of silence.
    await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS - PING_EVERY_MS);
    socket.onmessage?.({ data: JSON.stringify({ topic: "#pong" }) });
    await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS - PING_EVERY_MS);

    expect(socket.closed).toBe(false);
  });
});

describe("waking up", () => {
  it("reconnects on `focus` without waiting out the backoff", async () => {
    const client = new SsoBrowserClient();
    await client.connect();

    const opened = sockets.length;
    current().onclose?.({ code: 1006 });
    fire("focus");
    await vi.waitFor(() => expect(sockets.length).toBe(opened + 1));
  });

  it("reconnects on `online` and on `visibilitychange` too", async () => {
    const client = new SsoBrowserClient();
    await client.connect();

    current().onclose?.({ code: 1006 });
    fire("online");
    await vi.waitFor(() => expect(sockets.length).toBe(2));

    current().onclose?.({ code: 1006 });
    fire("visibilitychange");
    await vi.waitFor(() => expect(sockets.length).toBe(3));
  });

  it("does not dial from a hidden tab", async () => {
    const client = new SsoBrowserClient();
    await client.connect();

    current().onclose?.({ code: 1006 });
    visibility = "hidden";
    const opened = sockets.length;
    fire("focus");

    expect(sockets.length).toBe(opened);
  });

  it("does not dial while one socket is already open", async () => {
    const client = new SsoBrowserClient();
    await client.connect();

    const opened = sockets.length;
    fire("focus");

    expect(sockets.length).toBe(opened);
  });

  it("stays quiet once the client has been closed for good", async () => {
    const client = new SsoBrowserClient();
    await client.connect();
    client.close();

    const opened = sockets.length;
    fire("focus");

    expect(sockets.length).toBe(opened);
  });
});
