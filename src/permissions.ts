import { SsoError } from "./errors.js";
import type { SsoPermissions } from "./types.js";

/**
 * Reading what an account may do inside THIS application.
 *
 * There is no catalogue to declare here, and that is the whole shape of this file:
 * the actions belong to the provider, which recomputes them for the account on
 * every read and sends the lot back with `me`. An application declaring its own
 * list would be keeping a mirror of somebody else's table, and a mirror drifts -
 * an action renamed over there becomes a route nobody can reach over here, found
 * by a person who cannot get in rather than by a compiler.
 *
 * So the only thing this needs is the resource this application IS, which it
 * already declares as its access gate. The actions come with the account.
 *
 * A colon separates the two halves, never a dot: `:` cannot appear inside a
 * resource or an action name, so splitting stays correct however the catalogue
 * grows.
 */
export interface PermissionReader {
  /** The global ACL resource this application is, as the provider spells it. */
  readonly resource: string;
  /** `infrastructure:view-queues`, the shape `permissions.global` carries. */
  permission(action: string): string;
  /** The actions of THIS application the account holds, without their prefix. */
  held(permissions: SsoPermissions | null | undefined): string[];
  can(permissions: SsoPermissions | null | undefined, action: string): boolean;
  canAll(permissions: SsoPermissions | null | undefined, ...actions: string[]): boolean;
  canAny(permissions: SsoPermissions | null | undefined, ...actions: string[]): boolean;
  /** Refuses unless every action is held. Names what is missing. */
  assert(permissions: SsoPermissions | null | undefined, ...actions: string[]): void;
}

/**
 * Bind the checks to one resource.
 *
 * `isRoot` PASSES EVERYTHING, and it did not use to. The argument for leaving it
 * out was that a root account comes back holding the whole catalogue, so a plain
 * lookup already covered it - which is true of x-core and false of the directory an
 * application lends at `mode: "local"`. Offline there is no catalogue to expand: an
 * account marked root arrives with whatever list it was written with, and with an
 * empty one it held nothing at all.
 *
 * So the flag decided nothing where it was written down, and the two modes disagreed
 * about the same account - which is the one divergence this library exists not to
 * have, and which three files claimed did not exist.
 *
 * Reading it costs nothing on the other side: a root account already holds every
 * entry, so the check is answered before a list is walked rather than differently.
 */
export function createPermissionReader(resource: string) {
  const prefix = resource ? `${resource}:` : "";
  // An action that already carries a namespace keeps it: one account holds rights
  // across the whole ecosystem, so a route genuinely reading `core:access` says so.
  // And with no resource at all - an application that declares no gate, or one
  // standing in for the provider - actions are compared exactly as written.
  const permission = (action: string) => (action.includes(":") ? action : `${prefix}${action}`);

  const can = (permissions: SsoPermissions | null | undefined, action: string) => {
    // No list means no decision, and no decision is a refusal: a gate that opens
    // when it cannot see is not a gate.
    if (!permissions) return false;
    if (permissions.isRoot) return true;
    return permissions.global.includes(permission(action));
  };

  const reader: PermissionReader = {
    resource,
    permission,
    held: (permissions) =>
      (permissions?.global ?? []).filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length)),
    can,
    canAll: (permissions, ...wanted) => wanted.every((action) => can(permissions, action)),
    canAny: (permissions, ...wanted) => wanted.some((action) => can(permissions, action)),
    assert: (permissions, ...wanted) => {
      if (!permissions) throw new SsoError("FORBIDDEN", "This request carries no permissions");
      const missing = wanted.filter((action) => !can(permissions, action));
      if (missing.length) {
        throw new SsoError("FORBIDDEN", `Missing ${missing.map((action) => permission(action)).join(", ")}`);
      }
    },
  };

  return reader;
}

/** The same check against a whole string, for a permission this app does not own. */
export function holds(permissions: SsoPermissions | null | undefined, entry: string) {
  if (!permissions) return false;
  if (permissions.isRoot) return true;
  return permissions.global.includes(entry);
}
