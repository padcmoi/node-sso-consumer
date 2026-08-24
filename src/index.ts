// @gestionpratique/node-sso-consumer
//
// What a Node application needs to BE a consumer of the x-core SSO, rather than to
// build one: it pairs once, declares itself at every boot, holds its reader's
// session, reads their rights and follows the account over a socket - without a
// login page, without a copy of anybody's personal data and without a permission
// stored anywhere.
//
// One entry point, `createXcoreBridge`: the link to the API that holds the portal
// and the SSO. What an application still writes is its own handlers; everything
// between them is here.
//
// Nothing reads `process.env`, opens a store or holds a secret.

export { XcoreBridge, createXcoreBridge } from "./xcore-bridge.js";
export type { SsoRefusal, XcoreBridgeOptions, XcoreInjection, XcoreStartResult } from "./bridge/contract.js";

export { SsoConfigService, type SsoConfigServiceOptions } from "./config.service.js";
export { SsoAuthService, type SsoAuthServiceOptions, type SsoResolution } from "./auth.service.js";
export {
  SsoSessionService,
  type CookieJar,
  type CookieOptions,
  type SealedSession,
  type SsoResolvedSession,
  type SsoSessionServiceOptions,
} from "./session/session.service.js";
export { SsoRealtimeClient, type SsoRealtimeOptions } from "./realtime/realtime.client.js";

export { SsoMiddleware } from "./http/middleware.js";
export type { SsoMiddlewareOptions } from "./http/middleware-options.js";
export {
  clientContextOf,
  jarOf,
  pathOf,
  queryOf,
  redirect,
  sendJson,
  type WebErrorHandler,
  type WebHandler,
  type WebNext,
  type WebRequest,
  type WebResponse,
} from "./http/web.js";
export { SsoRealtimeBridge, type SsoRealtimeBridgeOptions } from "./realtime/bridge.js";
export { MemoryTicketStore, type TicketStore } from "./realtime/tickets.js";

export { SsoHttpClient, type SsoHttpOptions, type XcoreHmacInjection, type HttpAnswer } from "./http.js";

// The application's own store, and the keys this library reads and writes in it.
export { ENV, SsoEnvironment, mintSessionPassword, type XcoreEnvironmentStore } from "./environment.js";

export { createPermissionReader, holds, type PermissionReader } from "./permissions.js";
export { addressesOf, type ProviderAddresses, type ProviderEndpoint } from "./provider.js";

export { SsoError, isSessionOver, statusOf, type SsoErrorCode } from "./errors.js";
export type { StandInAccount } from "./session/local-accounts.js";

export { readMe, readSession } from "./parse.js";
export { seal, unseal } from "./session/seal.js";

export type {
  HttpMethod,
  SsoClientContext,
  SsoConsumerDeclaration,
  SsoGroup,
  SsoLogger,
  SsoMe,
  SsoPermissions,
  SsoProfile,
  SsoSession,
  SsoTokens,
  SsoUser,
} from "./types.js";
