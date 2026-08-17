/**
 * Where the identity provider answers, written down.
 *
 * Not read from an environment, and that is the point rather than a shortcut. The
 * four addresses below do not vary per deployment - they vary per ENVIRONMENT, and
 * there are two - so an application configuring them is an application given the
 * chance to get them wrong, in the one way that fails silently:
 *
 *   https://x-sso.gestionpratique.ovh          the login window. NOT the API.
 *   https://x-core.gestionpratique.ovh:13001   the API. THIS is the base.
 *
 * They differ by a port, and the login window answers `204 No Content` to anything
 * it does not know, unsigned included. So an application pointed at it declares
 * itself "successfully" at every boot, logs its own success, and nothing exists on
 * the other side. A value living in a `.env` is a value nobody can check by
 * reading the code; these can be read here.
 *
 * An application on another ecosystem passes `provider` and overrides the lot.
 */
export interface ProviderAddresses {
  /** The API. WITH its port. */
  apiBase: string;
  /** The login window a browser is sent to. */
  frontUrl: string;
  /** Where a signed-out browser goes. The only thing that signs anyone in. */
  portalUrl: string;
  /** The socket, on a port of its own: a long-lived connection has no business
   *  sharing the pool the API serves requests from. */
  realtimeUrl: string;
}

export type ProviderEnvironment = "dev" | "prod";

export const PROVIDERS: Record<ProviderEnvironment, ProviderAddresses> = {
  dev: {
    apiBase: "https://d-sso.gestionpratique.ovh:13001",
    frontUrl: "https://d-sso.gestionpratique.ovh",
    portalUrl: "https://d-portal.gestionpratique.ovh/",
    realtimeUrl: "wss://d-sso.gestionpratique.ovh:13002/realtime",
  },
  prod: {
    apiBase: "https://x-core.gestionpratique.ovh:13001",
    frontUrl: "https://x-sso.gestionpratique.ovh",
    portalUrl: "https://portail.gestionpratique.ovh/",
    realtimeUrl: "wss://x-core.gestionpratique.ovh:13002/realtime",
  },
};

/**
 * What an application may write in place of the set above.
 *
 * A bare string is the API - the one address worth writing down beside the code
 * that uses it, and the only one whose mistake is silent. Everything else keeps
 * the environment's value unless an object names it.
 */
export type ProviderOverride = string | Partial<ProviderAddresses>;

/**
 * The set an application runs against, with anything it overrides on top.
 *
 * An application may deliberately be told to use the PROD provider in both of its
 * own environments - one account list, one set of permissions, one place to grant
 * them - and that is a decision, not a mistake to correct. It is spelled by naming
 * `prod` while deploying to dev, which reads as what it is.
 */
export const providerFor = (environment: ProviderEnvironment, override?: ProviderOverride) => {
  const overrides = typeof override === "string" ? { apiBase: override } : override;
  const addresses: ProviderAddresses = { ...PROVIDERS[environment], ...overrides };
  return addresses;
};
