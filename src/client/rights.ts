/**
 * What the account may do, read from what the provider already answered.
 *
 * Pure, and deliberately so: nothing here asks anything, holds anything or is
 * configured with anything. Every answer comes out of the `me` in hand, which is
 * the one the server sent a moment ago.
 *
 * @module
 */

import type { SsoMe } from "../types.js";

/**
 * What this application's account may do here, without the prefix.
 *
 * With no resource at all - an application that declares no gate, or a library
 * standing in - the permissions ARE the actions and come back whole rather than
 * filtered down to nothing.
 */
export function actionsOf(me: SsoMe | null, resource: string) {
  const held = me?.permissions.global ?? [];
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
export function can(me: SsoMe | null, permission: string) {
  if (me?.permissions.isRoot) return true;
  return (me?.permissions.global ?? []).includes(permission);
}

/**
 * May this account be here at all: does `global` hold everything `portail` asks
 * for.
 *
 * The same one comparison the server half makes, on the same two lists the
 * provider answered together - never guessed from the shape of a permission, and
 * never read from anything this page was configured with. An empty `portail`
 * requires nothing and admits everybody.
 *
 * Written twice on purpose, here and in `bridge/access.ts`. Sharing it would pull
 * server code into a browser bundle, which this half of the library may not do.
 */
export function admitted(me: SsoMe) {
  const required = me.permissions.portail;
  if (required.length === 0) return true;

  const held = new Set(me.permissions.global);
  return required.every((permission) => held.has(permission));
}
