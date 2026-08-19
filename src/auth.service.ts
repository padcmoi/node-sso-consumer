import { SsoError } from "./errors.js";
import type { SsoEnvironment } from "./environment.js";
import type { SsoHttpClient } from "./http.js";
import { readMe, readSession } from "./parse.js";
import { createPermissionReader, type PermissionReader } from "./permissions.js";
import type { SsoClientContext, SsoLogger, SsoMe, SsoPermissions, SsoSession, SsoTokens } from "./types.js";

const SESSION_PATH = "/api/v1/sso/consumer/session";
const ME_PATH = "/api/v1/sso/me";
const REALTIME_PATH = "/realtime";

export interface SsoAuthServiceOptions {
  http: SsoHttpClient;
  /**
   * Where the global ACL resource this app IS comes from: the first entry of the
   * gate it declares, read back from its own store rather than named a second time.
   *
   * What it may DO is never declared anywhere - the provider recomputes that per
   * account and sends it with every `me`.
   */
  identity: SsoEnvironment;
  logger?: SsoLogger;
}

/** What resolving a session answered, and whether the pair moved doing it. */
export interface SsoResolution {
  me: SsoMe;
  tokens: SsoTokens;
  /** True when the pair was rotated: re-seal it, or the session dies next call. */
  rotated: boolean;
}

/**
 * The whole of the authentication, and the reading of the rights behind it.
 *
 * The one thing to hold on to: the token pair IS the session. Not a local session
 * opened after a check passed once - a session that descends from the provider's
 * own and may not outlive it. That is why `resolve` asks on EVERY request instead
 * of trusting what it verified a minute ago, and why nothing here caches an
 * account, a profile or a permission.
 *
 * Everything is injected and every method acts on what it is called with, so this
 * class holds no request state and can be a singleton in any framework.
 */
export class SsoAuthService {
  /** Rotations in flight, keyed by the refresh token they spend. */
  private readonly rotating = new Map<string, Promise<SsoSession>>();
  /** Built on first use: the resource is read from the store, which is filled at boot. */
  private reader: PermissionReader | null = null;

  constructor(private readonly options: SsoAuthServiceOptions) {}

  /**
   * Open the session by redeeming the authorization code.
   *
   * The browser's address and agent travel with it: this is a server-to-server
   * call, so without them the provider files the session under the calling
   * container's address, which is what its owner reads on the sessions screen.
   */
  async openSession(params: { code: string } & SsoClientContext) {
    const payload = await this.options.http.call(SESSION_PATH, "POST", {
      code: params.code,
      clientIp: params.clientIp ?? null,
      clientUserAgent: params.clientUserAgent ?? null,
    });
    return readSession(payload);
  }

  /**
   * Rotate the pair, once per refresh token however many callers ask at once.
   *
   * A refresh token is single-use. A page load firing several requests together
   * has each of them wanting to spend the same one, and the answer that lands last
   * decides what the session keeps - which is how a session dies under load and
   * nowhere else. Callers arriving during a rotation share its result.
   */
  rotateSession(params: { refreshToken: string } & SsoClientContext) {
    const inFlight = this.rotating.get(params.refreshToken);
    if (inFlight) return inFlight;

    const rotation = this.options.http
      .call(SESSION_PATH, "PUT", {
        refreshToken: params.refreshToken,
        clientIp: params.clientIp ?? null,
        clientUserAgent: params.clientUserAgent ?? null,
      })
      .then((payload) => readSession(payload))
      .finally(() => this.rotating.delete(params.refreshToken));

    this.rotating.set(params.refreshToken, rotation);
    return rotation;
  }

  /**
   * Close this app's session. The provider's own stays open, deliberately: a
   * consumer signing out leaves the reader signed into the SSO and the other apps.
   * The reverse is not true.
   */
  async closeSession(params: { refreshToken: string }) {
    await this.options.http.call(SESSION_PATH, "DELETE", { refreshToken: params.refreshToken });
  }

  /**
   * The account behind an access token: identity, details, rights.
   *
   * The access token travels in the QUERY, and legitimately so: the signature
   * covers `path + search`, so it is signed exactly as a body would be. It is the
   * short-lived half of the pair, which is why it is the one that may appear
   * there; the refresh token never does.
   */
  async readAccount(params: { accessToken: string }) {
    const payload = await this.options.http.call(`${ME_PATH}?accessToken=${encodeURIComponent(params.accessToken)}`, "GET");
    return readMe(payload);
  }

  /**
   * Who is calling, on every request, with one rotation behind it.
   *
   * Returns null when the session is genuinely over - closed here, signed out at
   * the SSO from another device, or access to this app revoked - and that is the
   * signal to end the local session and send the reader back to the portal.
   *
   * A provider that is unreachable is NOT a session that is over, and the
   * difference is the whole reason this does not swallow its failures: catching
   * everything signs every reader out the moment the network hiccups, and it looks
   * exactly like a mass revocation.
   */
  async resolve(params: { tokens: SsoTokens; context?: SsoClientContext }) {
    const { tokens } = params;

    try {
      return { me: await this.readAccount({ accessToken: tokens.accessToken }), tokens, rotated: false };
    } catch (error) {
      // A refusal is FIRST read as an expiry: the access token is short-lived, and
      // rotating is what tells an expired one apart from a revoked session.
      if (!(error instanceof SsoError) || error.code !== "UNAUTHORIZED") throw error;
    }

    let rotated: SsoSession;
    try {
      rotated = await this.rotateSession({ refreshToken: tokens.refreshToken, ...params.context });
    } catch (error) {
      if (error instanceof SsoError && (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN")) return null;
      throw error;
    }

    try {
      const me = await this.readAccount({ accessToken: rotated.accessToken });
      return { me, tokens: rotated, rotated: true };
    } catch (error) {
      // A pair that was just minted and is already refused is a revocation, not an
      // expiry: there is nothing left to rotate.
      if (error instanceof SsoError && (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN")) return null;
      throw error;
    }
  }

  /**
   * The signed headers that open the realtime socket.
   *
   * Two credentials guard that stream and they answer two questions. This is the
   * first: WHICH APP is dialling, proven on the upgrade itself, before a socket
   * exists. The second is the account, and it travels in the first frame below.
   *
   * A browser can do neither, which is why the socket is opened by the backend and
   * bridged: the signature is a server secret, and so is the token.
   */
  realtimeHandshake(params: { url: string }) {
    return this.options.http.signHeaders({ method: "GET", url: params.url, body: "" });
  }

  /**
   * The first frame the socket owes, within seconds of opening: WHICH USER.
   *
   * The signature proves the app and never the human. The token must be one this
   * app was issued - the provider refuses a valid token belonging to another.
   */
  realtimeAuthFrame(params: { accessToken: string }) {
    return { event: "auth", data: { accessToken: params.accessToken } };
  }

  /** The upgrade path, so a bridge does not spell it a second time. */
  get realtimePath() {
    return REALTIME_PATH;
  }

  // --- Rights ---------------------------------------------------------------
  //
  // Read off what the provider answered on THIS request, never off a copy. They
  // are meant to reach the browser, which is what hides a button the API would
  // refuse anyway - but a check made in a browser is not enforcement, so every
  // route re-asks here, against the answer it just received.

  get permissions() {
    if (this.reader) return this.reader;

    const resource = this.options.identity.resource;
    if (!resource) {
      throw new SsoError("FORBIDDEN", "This app declares no gate, so it holds no permission vocabulary of its own");
    }

    this.reader = createPermissionReader(resource);
    return this.reader;
  }

  can(permissions: SsoPermissions | null | undefined, action: string) {
    return this.permissions.can(permissions, action);
  }

  canAll(permissions: SsoPermissions | null | undefined, ...actions: string[]) {
    return this.permissions.canAll(permissions, ...actions);
  }

  canAny(permissions: SsoPermissions | null | undefined, ...actions: string[]) {
    return this.permissions.canAny(permissions, ...actions);
  }

  /** Refuses unless every action is held, naming what is missing. */
  assert(permissions: SsoPermissions | null | undefined, ...actions: string[]) {
    this.permissions.assert(permissions, ...actions);
  }
}
