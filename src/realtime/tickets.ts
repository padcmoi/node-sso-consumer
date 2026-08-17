import { randomBytes } from "node:crypto";

/**
 * Where a realtime ticket waits between the page asking for one and the socket
 * spending it.
 *
 * A port, with the obvious implementation below. An application running one
 * process needs nothing else; one running several - or reloading its server on
 * every change, as a dev server does - hands a Redis-backed store instead, or the
 * ticket minted a second ago is gone by the time the socket arrives.
 */
export interface TicketStore {
  /** Keep it for `ttlSeconds`, no longer. */
  put(ticket: string, accessToken: string, ttlSeconds: number): Promise<void> | void;
  /** Read AND remove, in one move: a ticket read twice is a ticket replayed. */
  take(ticket: string): Promise<string | null> | string | null;
}

interface HeldTicket {
  accessToken: string;
  expiresAt: number;
}

/**
 * The default: in memory, single process.
 *
 * Expiry is checked on read rather than swept on a timer - a ticket lives thirty
 * seconds and a process holding a few of them at a time has nothing to sweep.
 */
export class MemoryTicketStore implements TicketStore {
  private readonly held = new Map<string, HeldTicket>();

  put(ticket: string, accessToken: string, ttlSeconds: number) {
    this.held.set(ticket, { accessToken, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  take(ticket: string) {
    const found = this.held.get(ticket);
    this.held.delete(ticket);
    if (!found || found.expiresAt < Date.now()) return null;
    return found.accessToken;
  }
}

/** 32 bytes, which is what makes guessing one pointless. */
export const mintTicket = () => randomBytes(32).toString("base64url");

export const TICKET_TTL_S = 30;
