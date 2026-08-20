/**
 * Where the identity provider answers, and which one this process runs against.
 *
 * Three of the four addresses below do not vary per deployment - they vary per
 * ENVIRONMENT, and there are two - so they are written down here rather than
 * configured. The fourth, the API, IS configured, and deliberately: it is the one
 * whose mistake is silent.
 *
 *   https://x-sso.gestionpratique.ovh          the login window. NOT the API.
 *   https://x-core.gestionpratique.ovh:13001   the API. THIS is the base.
 *
 * They differ by a port, and the login window answers `204 No Content` to anything
 * it does not know, unsigned included. So an application pointed at it declares
 * itself "successfully" at every boot, logs its own success, and nothing exists on
 * the other side.
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
 * One environment's provider, as an application writes it.
 *
 * `baseUrl` is the API with its port, and it is the only required field: it is the
 * one address an integrator has to have looked at and typed. The other three keep
 * the address book's values unless this names them, which is what an application on
 * another ecosystem does.
 */
export interface ProviderEndpoint extends Partial<Omit<ProviderAddresses, "apiBase">> {
  baseUrl: string;
}

/**
 * One provider per environment, and `dev` may be absent.
 *
 * ITS ABSENCE IS A DECISION rather than a hole. Without a dev address there is
 * nowhere to call, so this library stands down in development: no pairing, no
 * declaration, no SSO. It does not throw - a missing key here is how an application
 * says "not in dev", and what it does instead with its own local login is its own
 * business.
 *
 * `prod` is not optional. It is the environment that always exists.
 */
export interface ProviderConfig {
  dev?: ProviderEndpoint;
  prod: ProviderEndpoint;
}

/**
 * Which environment this process is, read rather than configured.
 *
 * READ, because the whole point of a pair of providers and a pair of pairing codes
 * is that the same configuration ships to both. A key naming the environment would
 * put the edit back where it was: one line to change at every deployment, and a
 * deployment that forgets it installs production against the dev provider.
 *
 * Anything that is not a production build is `dev`, which is the safe way round: a
 * developer's machine offering to install into production is the wrong default to
 * get wrong.
 */
export const currentEnvironment = () => (process.env.NODE_ENV === "production" ? "prod" : "dev") satisfies ProviderEnvironment;

/**
 * The addresses this process runs against, or `null` when it has none.
 *
 * `null` is only ever the dev answer, and it means the library stands down. Every
 * caller has to read it as a state rather than as a failure, which is why it is a
 * value and not a throw.
 */
export function providerFor(config: ProviderConfig, environment: ProviderEnvironment) {
  const endpoint = environment === "prod" ? config.prod : config.dev;
  if (!endpoint) return null;

  const { baseUrl, ...overrides } = endpoint;
  return { ...PROVIDERS[environment], ...overrides, apiBase: baseUrl } satisfies ProviderAddresses;
}

/**
 * The pairing code for this process, or nothing.
 *
 * TWO CODES, unrelated to each other: each is minted on its own console, against its
 * own x-core, and brings back the queue, the broker account and the credential of
 * that ecosystem. One field for both would have meant editing the configuration at
 * every deployment - or worse, installing production with the dev code, which
 * succeeds silently and wires the application to the wrong provider.
 *
 * `dev` follows the provider's: without a dev address there is nothing to pair
 * against, so there is nothing to put there. One switch, not two - two keys deciding
 * the same thing are two keys that end up contradicting each other.
 */
export interface InstallTokens {
  dev?: string;
  prod: string;
}

export const installTokenFor = (tokens: InstallTokens | undefined, environment: ProviderEnvironment) =>
  (environment === "prod" ? tokens?.prod : tokens?.dev)?.trim() || null;
