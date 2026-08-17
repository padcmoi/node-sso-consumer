import { randomUUID } from "node:crypto";
import { SsoError } from "../errors.js";
import { asFields } from "../parse.js";
import { sameValue, seal, unseal } from "./seal.js";
import type { SsoAuthService } from "../auth.service.js";
import type { SsoClientContext, SsoLogger, SsoMe, SsoTokens } from "../types.js";

/**
 * Where a cookie is read and written, whatever is carrying the request.
 *
 * The one thing a framework adapter has to implement, and the reason the whole
 * session lives in this library rather than being copied into every app: reading a
 * header and setting one are the only two things that differ between Express, a
 * Nitro handler and a Nest controller.
 */
export interface CookieJar {
  read(name: string): string | null;
  write(name: string, value: string, options: CookieOptions): void;
  clear(name: string, options: CookieOptions): void;
}

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  maxAge?: number;
  domain?: string;
}

/** What the sealed cookie carries, and nothing more. */
export interface SealedSession {
  /** The stable link to the account. The only identifier this app keeps. */
  userId: string;
  tokens: SsoTokens;
}

export interface SsoSessionServiceOptions {
  auth: SsoAuthService;
  /** 32 characters or more. Changing it signs everyone out, which is its own tool. */
  password: string;
  cookie?: {
    name?: string;
    stateName?: string;
    /** False only where dev serves plain HTTP: a Secure cookie is dropped there. */
    secure?: boolean;
    sameSite?: "lax" | "strict" | "none";
    path?: string;
    domain?: string;
    /** A ceiling, never the session's lifetime: the provider decides that. */
    maxAgeDays?: number;
  };
  logger?: SsoLogger;
}

const STATE_MAX_AGE_S = 600;
const DEFAULT_MAX_AGE_DAYS = 30;

const readSealedSession = (payload: unknown) => {
  const fields = asFields(payload);
  if (!fields) return null;

  const tokens = asFields(fields.tokens);
  if (!tokens) return null;
  if (typeof fields.userId !== "string") return null;
  if (typeof tokens.accessToken !== "string" || typeof tokens.refreshToken !== "string") return null;

  const session: SealedSession = {
    userId: fields.userId,
    tokens: {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: typeof tokens.accessTokenExpiresAt === "string" ? tokens.accessTokenExpiresAt : "",
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: typeof tokens.refreshTokenExpiresAt === "string" ? tokens.refreshTokenExpiresAt : "",
    },
  };
  return session;
};

/**
 * The session, from the redirect that opens it to the call that ends it.
 *
 * There is no local session here beside the provider's: what the cookie carries IS
 * the token pair, and every request re-asks the provider whether it still stands.
 * That is what makes a sign-out at the SSO, an account disabled or an access
 * revoked land on the very next call, with nothing to invalidate and no webhook to
 * expose.
 *
 * Nothing personal is sealed. The name, the address and the rights come back with
 * every `resolve`, are used for that request and dropped.
 */
export class SsoSessionService {
  constructor(private readonly options: SsoSessionServiceOptions) {}

  private get cookieName() {
    return this.options.cookie?.name ?? "sso_session";
  }

  private get stateName() {
    return this.options.cookie?.stateName ?? "sso_state";
  }

  private cookieOptions(maxAge?: number) {
    const options: CookieOptions = {
      httpOnly: true,
      secure: this.options.cookie?.secure ?? true,
      // `lax` and not `strict`: the cookie has to survive the redirect back from
      // the login window, which is a cross-site navigation.
      sameSite: this.options.cookie?.sameSite ?? "lax",
      path: this.options.cookie?.path ?? "/",
      domain: this.options.cookie?.domain,
      maxAge,
    };
    return options;
  }

  /**
   * Mint the state that ties a sign-in to the browser that started it, and hand
   * back where to send that browser.
   */
  start(jar: CookieJar, params: { authorizeUrl: (state: string) => string }) {
    const state = randomUUID();
    jar.write(this.stateName, state, this.cookieOptions(STATE_MAX_AGE_S));
    return params.authorizeUrl(state);
  }

  /**
   * Come back from the login window: check the state, trade the code, seal the
   * pair.
   *
   * Returns null when the round trip cannot be trusted - a state that does not
   * match, a code already spent, one that expired. All of them mean the same thing
   * to a reader: start again.
   */
  async complete(jar: CookieJar, params: { code?: string | null; state?: string | null } & SsoClientContext) {
    const expected = jar.read(this.stateName);
    jar.clear(this.stateName, this.cookieOptions());

    if (!params.code || !params.state || !expected || !sameValue(params.state, expected)) {
      this.options.logger?.warn?.("[sso] callback refused: the state did not come back with the browser");
      return null;
    }

    try {
      const session = await this.options.auth.openSession({
        code: params.code,
        clientIp: params.clientIp,
        clientUserAgent: params.clientUserAgent,
      });

      this.write(jar, {
        userId: session.user.id,
        tokens: {
          accessToken: session.accessToken,
          accessTokenExpiresAt: session.accessTokenExpiresAt,
          refreshToken: session.refreshToken,
          refreshTokenExpiresAt: session.refreshTokenExpiresAt,
        },
      });

      return session;
    } catch (error) {
      // A code is single-use and lives about two minutes, so refreshing the
      // callback URL always lands here. Not an incident: an invitation to start
      // again.
      if (error instanceof SsoError && (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN")) return null;
      throw error;
    }
  }

  /**
   * Who is calling. Read the cookie, ask the provider, re-seal what moved.
   *
   * null means signed out, and it is the only null: a provider that cannot be
   * reached raises instead, because signing everyone out on a network hiccup looks
   * exactly like a mass revocation.
   */
  async resolve(jar: CookieJar, context?: SsoClientContext) {
    const sealed = this.read(jar);
    if (!sealed) return null;

    const resolved = await this.options.auth.resolve({ tokens: sealed.tokens, context });
    if (!resolved) {
      this.clear(jar);
      return null;
    }

    // Rotation spends the token that was presented, so the new pair MUST be sealed
    // back or the session dies on the very next call.
    if (resolved.rotated) this.write(jar, { userId: sealed.userId, tokens: resolved.tokens });

    return { me: resolved.me, tokens: resolved.tokens, userId: sealed.userId };
  }

  /**
   * End this app's session, and only this one: the provider's own stays open, so
   * the reader is still signed into the portal and the other apps.
   */
  async end(jar: CookieJar) {
    const sealed = this.read(jar);
    this.clear(jar);
    if (!sealed) return;

    try {
      await this.options.auth.closeSession({ refreshToken: sealed.tokens.refreshToken });
    } catch (error) {
      // The local half is already gone, which is what the reader asked for. A
      // provider that refused the closing leaves a row that dies on its own.
      this.options.logger?.warn?.(`[sso] the provider refused to close the session: ${String(error)}`);
    }
  }

  /** The pair, without asking the provider anything. For a socket ticket, mostly. */
  read(jar: CookieJar) {
    return readSealedSession(unseal(this.options.password, jar.read(this.cookieName)));
  }

  write(jar: CookieJar, session: SealedSession) {
    const days = this.options.cookie?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    jar.write(this.cookieName, seal(this.options.password, session), this.cookieOptions(days * 24 * 60 * 60));
  }

  clear(jar: CookieJar) {
    jar.clear(this.cookieName, this.cookieOptions());
  }
}

export type SsoResolvedSession = { me: SsoMe; tokens: SsoTokens; userId: string };
