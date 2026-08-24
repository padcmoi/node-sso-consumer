import { SsoAuthService } from "../auth.service.js";
import { SsoConfigService } from "../config.service.js";
import { SsoHttpClient } from "../http.js";
import { SsoLiveAccounts } from "../session/live-accounts.js";
import { SsoMiddleware } from "../http/middleware.js";
import { SsoRealtimeBridge } from "../realtime/bridge.js";
import { SsoSessionService } from "../session/session.service.js";
import { standingIn } from "./stand-in.js";
import type { SsoEnvironment } from "../environment.js";
import type { ProviderAddresses } from "../provider.js";
import type { WebRequest, WebResponse } from "../http/web.js";
import type { SsoMe, SsoTokens } from "../types.js";
import type { XcoreBridgeOptions } from "./contract.js";

/**
 * What the services need back from the bridge, lent as functions rather than values.
 *
 * All of them are read THROUGH: the identity, the portal address and the serving
 * state all arrive from the store, and the store is read inside `start()` - long
 * after any of this is built. Captured as values they would each be frozen on
 * whatever was true at construction, which is nothing.
 */
export interface BridgeHooks {
  serving(): boolean;
  portalUrl(): string;
  resolve(req: WebRequest, res: WebResponse): Promise<{ me: SsoMe; tokens: SsoTokens; userId: string } | null>;
  signIn(req: WebRequest, res: WebResponse, credentials: { email: string; password: string }): Promise<SsoMe | null>;
  signUp(
    req: WebRequest,
    res: WebResponse,
    input: { email: string; password: string; firstName: string; lastName: string }
  ): Promise<SsoMe | null>;
  logout(req: WebRequest, res: WebResponse): Promise<string>;
}

/**
 * Everything the bridge holds, built once and in this order.
 *
 * The order is not cosmetic: each one below is handed the ones above it, and the
 * middleware - which is handed nearly all of them - comes last.
 */
export function buildServices(
  options: XcoreBridgeOptions,
  identity: SsoEnvironment,
  provider: ProviderAddresses,
  hooks: BridgeHooks
) {
  const http = new SsoHttpClient({
    apiBase: provider.apiBase,
    identity,
    hmac: options.di.hmac,
    timeoutMs: options.timeoutMs,
    logger: options.logger,
  });

  const config = new SsoConfigService({
    http,
    // Read through, never captured: the provider may name its login window at
    // pairing, and the pairing happens inside `start()`.
    frontUrl: () => (identity.hydrated ? (identity.frontUrl ?? provider.frontUrl) : provider.frontUrl),
    identity,
    retry: options.retry,
    logger: options.logger,
  });

  // The resource this application IS, taken from the gate it already declares
  // rather than named a second time. What it may DO is never declared here: the
  // provider recomputes that per account and sends it back with every `me`.
  const auth = new SsoAuthService({
    http,
    identity,
    logger: options.logger,
  });

  const sessions = new SsoSessionService({
    auth,
    identity,
    cookie: options.session?.cookie,
    logger: options.logger,
  });

  const live =
    options.live?.enabled === false || options.mode === "local"
      ? null
      : new SsoLiveAccounts({
          auth,
          realtimeUrl: provider.realtimeUrl,
          // Called through the options object rather than handed over as a
          // reference, so a listener kept on its own `this` still finds it.
          onAccount: (userId, me) => options.di.onAccount?.(userId, me),
          onSignedOut: (userId) => options.di.onSignedOut?.(userId),
          logger: options.logger,
        });

  const realtime = new SsoRealtimeBridge({
    auth,
    upstreamUrl: provider.realtimeUrl,
    path: options.realtime?.path,
    tickets: options.realtime?.tickets,
    // NOT `serving`. Standing in, this library holds real sessions but there is no
    // provider at the other end of a socket: nothing pushes an account that changed
    // because nothing over there knows it changed. So the upgrade is left alone,
    // the ticket route refuses, and a browser stays on plain reads - which is the
    // honest picture rather than a stream that opens onto nothing.
    serving: () => options.mode === "sso" && hooks.serving(),
    logger: options.logger,
  });

  const middleware = new SsoMiddleware({
    auth,
    config,
    session: sessions,
    realtime,
    // Withdrawn, or standing up, or unpaired, or the provider unreachable: the
    // guards SHUT. This library is the bridge, and what sits behind a guard needs
    // to know who is asking - so an application that cannot ask serves none of it.
    serving: () => hooks.serving(),
    // Lent, never assumed: the library decides the refusal, this speaks it in
    // whatever the framework underneath expects.
    errors: options.di.errors ? (refusal, req, res) => options.di.errors?.(refusal, req, res) : undefined,
    resolve: (req, res) => hooks.resolve(req, res),
    forget: (userId) => live?.forget(userId),
    // Read through, never captured: the provider sends its own portal address at
    // pairing, and what is configured is only what answers before it has.
    portalUrl: () => hooks.portalUrl(),
    basePath: options.routes?.basePath,
    afterLogin: options.routes?.afterLogin,
    loginPath: options.routes?.loginPath,
    // Standing in, a refusal cannot go to a portal that does not exist: it goes to
    // this application's own sign-in screen.
    standingIn: () => standingIn(options),
    signIn: (req, res, credentials) => hooks.signIn(req, res, credentials),
    signUp: (req, res, input) => hooks.signUp(req, res, input),
    signUpOpen: options.routes?.signUp === true,
    logout: (req, res) => hooks.logout(req, res),
    logger: options.logger,
  });

  return { http, config, auth, sessions, live, realtime, middleware };
}
