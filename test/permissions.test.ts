import { describe, expect, it } from "vitest";
import { SsoError } from "../src/errors.js";
import { createPermissionReader, holds } from "../src/permissions.js";

const reader = createPermissionReader("infrastructure");

const permissions = (global: string[], isRoot = false) => ({ global, isRoot, groups: [], portail: [] });

describe("reading what an account may do here", () => {
  it("prefixes an action with the resource this application is", () => {
    expect(reader.permission("view-queues")).toBe("infrastructure:view-queues");
  });

  it("lists only this application's actions, without their prefix", () => {
    const held = reader.held(permissions(["core:access", "infrastructure:access", "infrastructure:view-queues"]));

    // A right granted on another application stays invisible here, on purpose.
    expect(held).toEqual(["access", "view-queues"]);
  });

  it("refuses when there are no permissions at all", () => {
    // A gate that opens when it cannot see is not a gate.
    expect(reader.can(null, "view-queues")).toBe(false);
    expect(reader.can(undefined, "view-queues")).toBe(false);
  });

  it("needs every action for canAll and one for canAny", () => {
    const held = permissions(["infrastructure:view-queues"]);

    expect(reader.canAll(held, "view-queues")).toBe(true);
    expect(reader.canAll(held, "view-queues", "delete-queues")).toBe(false);
    expect(reader.canAny(held, "delete-queues", "view-queues")).toBe(true);
    expect(reader.canAny(held, "delete-queues")).toBe(false);
  });

  it("lets a root account pass everything, list or no list", () => {
    // Reversed in 0.2.0, and the lent directory is why: against x-core a root
    // account comes back holding the whole catalogue, so reading the flag changes
    // nothing there - but offline there is no catalogue to expand, and a root
    // account arrived holding whatever list it was written with. The browser half
    // has always read the flag first; now both halves agree.
    expect(reader.can(permissions(["infrastructure:delete-queues"], true), "delete-queues")).toBe(true);
    expect(reader.can(permissions([], true), "delete-queues")).toBe(true);
    expect(reader.can(permissions([], false), "delete-queues")).toBe(false);
  });

  it("names what is missing when it refuses", () => {
    const held = permissions(["infrastructure:view-queues"]);

    expect(() => reader.assert(held, "view-queues")).not.toThrow();

    let refusal: unknown;
    try {
      reader.assert(held, "view-queues", "delete-queues", "protect-queues");
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(SsoError);
    if (!(refusal instanceof SsoError)) return;
    expect(refusal.code).toBe("FORBIDDEN");
    expect(refusal.message).toBe("Missing infrastructure:delete-queues, infrastructure:protect-queues");
  });

  it("refuses a request carrying nothing", () => {
    expect(() => reader.assert(null, "view-queues")).toThrow(/no permissions/);
  });

  it("checks a whole permission this application does not own", () => {
    expect(holds(permissions(["core:access"]), "core:access")).toBe(true);
    expect(holds(permissions(["core:access"]), "billing:access")).toBe(false);
    expect(holds(null, "core:access")).toBe(false);
  });
});
