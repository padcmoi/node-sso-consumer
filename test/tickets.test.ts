import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryTicketStore, TICKET_TTL_S, mintTicket } from "../src/realtime/tickets.js";

afterEach(() => vi.useRealTimers());

describe("the realtime ticket", () => {
  it("is long enough that guessing one is not a strategy", () => {
    expect(mintTicket()).toHaveLength(43);
    expect(mintTicket()).not.toBe(mintTicket());
  });

  it("is spent on the first read", () => {
    const store = new MemoryTicketStore();
    store.put("t", "access-1", TICKET_TTL_S);

    // Read AND removed in one move: a ticket read twice is a ticket replayed.
    expect(store.take("t")).toBe("access-1");
    expect(store.take("t")).toBeNull();
  });

  it("answers null for one nobody minted", () => {
    expect(new MemoryTicketStore().take("never-minted")).toBeNull();
  });

  it("stops standing for anything once its thirty seconds are up", () => {
    vi.useFakeTimers();
    const store = new MemoryTicketStore();
    store.put("t", "access-1", TICKET_TTL_S);

    vi.advanceTimersByTime((TICKET_TTL_S + 1) * 1000);
    expect(store.take("t")).toBeNull();
  });
});
