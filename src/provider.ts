import { SsoError } from "./errors.js";
import type { SsoLogger } from "./types.js";

/**
 * Where the identity provider answers.
 *
 * ONE address is written by an application, and it is the API with its port. There
 * is no second environment, no address book and no pair of anything: a deployment
 * points at one x-core, and the install token it presents belongs to that same one.
 *
 *   https://x-core.gestionpratique.ovh:13001   the API. THIS is the base.
 *
 * The other three come from it, and they are NOT equally sound:
 *
 *   the portal         answered by the pairing, under `SSO_PORTAL_URL`. A fact.
 *   the socket         the same host, one port further, path `/realtime`. A fact:
 *                      the provider serves it beside its API, deliberately.
 *   the login window   the same host WITHOUT the port - A GUESS, and one that has
 *                      been wrong in production. It is served from a name of its
 *                      own there (`x-sso` where the API is `x-core`), nothing in
 *                      the pairing answers it, and what a wrong guess produces is a
 *                      `502` from a reverse proxy at the instant a reader clicks
 *                      the portal card - on an application that paired, declared
 *                      and signs perfectly.
 *
 * So a deployment STATES `frontUrl`, and the derivation is a last resort that says
 * so in the log. Naming one changes nothing about the others.
 */
export interface ProviderEndpoint {
  /**
   * The API, WITH its port.
   *
   * THE PORT IS THE TRAP. The login window lives on the same names without one and
   * answers `204 No Content` to anything it does not know, unsigned calls included -
   * so an application pointed at it declares itself "successfully" at every boot,
   * writes its own success into its logs, and nothing exists on the other side.
   * That is the one mistake in this whole configuration that shows up nowhere,
   * which is why `start()` proves the address before declaring anything to it.
   */
  baseUrl: string;

  /**
   * The login window a browser is sent to, when it is not `baseUrl` without its port.
   *
   * Only the way IN uses it, and only for a reader who reached this application
   * directly: the ordinary path is the portal, which is what signs a human in and
   * what points its card at `…/sso/start`.
   */
  frontUrl?: string;

  /**
   * The socket, when it is not one port past the API's.
   *
   * `wss://<host>:<port + 1>/realtime` is x-core's own layout - the gateway listens
   * on `3002` beside the API's `3001`, and a deployment publishing `13001` publishes
   * `13002`. A long-lived connection has no business sharing the pool the API serves
   * requests from, which is why it is a port of its own rather than a path.
   */
  realtimeUrl?: string;

  /**
   * Where a signed-out browser lands, when the pairing has not said.
   *
   * Normally nothing: x-core answers it at pairing under `SSO_PORTAL_URL`, because
   * x-core is what serves the portal and what knows which one an application belongs
   * to. A copy written down here outlives the address the day it moves, and a
   * sign-out landing on nothing reads as broken rather than as stale.
   */
  portalUrl?: string;
}

/** The four addresses in use, once the three that are derived have been. */
export interface ProviderAddresses {
  apiBase: string;
  frontUrl: string;
  realtimeUrl: string;
  portalUrl: string;
}

/** `https://host:13001/` and `https://host:13001` are the same base. */
const trimSlashes = (value: string) => value.replace(/\/+$/, "");

/**
 * The API base, read as a URL or refused by name.
 *
 * Refused rather than carried: a base that is not a URL fails later, inside a
 * signature, as a `401` that reads like a credential problem - and the value that
 * caused it is three files away from where it is felt.
 */
const urlOf = (baseUrl: string) => {
  try {
    return new URL(trimSlashes(baseUrl));
  } catch {
    throw new SsoError(
      "NOT_XCORE",
      `\`provider.baseUrl\` is not an address: ${JSON.stringify(baseUrl)}. It is the API of one x-core, WITH its port, ` +
        "and it is the only address this application writes itself."
    );
  }
};

/** The login window: the same names, without the port. */
const frontUrlOf = (api: URL) => `${api.protocol}//${api.hostname}`;

/**
 * The socket: the same host, one port further.
 *
 * The API's port plus one, which is x-core's own layout rather than an arbitrary
 * convention. A deployment that publishes them any other way names `realtimeUrl`
 * itself, and nothing here tries to be clever about it.
 */
const realtimeUrlOf = (api: URL) => {
  const scheme = api.protocol === "https:" ? "wss:" : "ws:";
  const apiPort = Number(api.port || (api.protocol === "https:" ? 443 : 80));
  return `${scheme}//${api.hostname}:${apiPort + 1}/realtime`;
};

/**
 * The four addresses, from the one an application wrote.
 *
 * Called once at construction. What it derives is what a deployment did not have to
 * type, and what it was given wins over what it would have derived - both without a
 * second key deciding which.
 */
export function addressesOf(endpoint: ProviderEndpoint, logger?: SsoLogger) {
  const api = urlOf(endpoint.baseUrl);

  // Said out loud, because a wrong one is silent until a reader clicks. Everything
  // this library does keeps working - pairing, declaring, signing - and the only
  // sign is a `502` on a host that was never asked to serve anything.
  if (!endpoint.frontUrl) {
    logger?.warn?.(
      `[sso] no frontUrl was stated: falling back to ${frontUrlOf(api)}, which is a GUESS. ` +
        "The provider often serves its login window from a name of its own. State `provider.frontUrl` if a reader lands on a 502 signing in."
    );
  }

  const addresses: ProviderAddresses = {
    apiBase: trimSlashes(endpoint.baseUrl),
    frontUrl: trimSlashes(endpoint.frontUrl ?? frontUrlOf(api)),
    realtimeUrl: trimSlashes(endpoint.realtimeUrl ?? realtimeUrlOf(api)),
    // Empty until the pairing answers it. The store is read through at every use,
    // so an application paired against a portal that has moved follows it.
    portalUrl: endpoint.portalUrl ?? "",
  };
  return addresses;
}
