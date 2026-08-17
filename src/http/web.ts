import type { CookieJar, CookieOptions } from "../session/session.service.js";
import type { SsoMe, SsoTokens } from "../types.js";

// The request and the response, described as Node hands them over.
//
// NOT Express, and that is the whole point: `IncomingMessage` and `ServerResponse`
// are what every Node framework carries underneath - Express passes them through,
// Nest sits on Express or Fastify, Nitro exposes them at `event.node`. Describing
// them structurally is what lets one implementation serve all of them, instead of
// one adapter per framework drifting from the others.
//
// Nothing here reads `req.query`, `res.json` or `res.redirect`: those are Express
// conveniences, and using them is what would pin this to it.

export interface WebRequest {
  method?: string;
  url?: string;
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string };
  /** Put there by the session middleware, for the handlers behind it. */
  me?: SsoMe;
  ssoTokens?: SsoTokens;
  ssoUserId?: string;
}

export interface WebResponse {
  statusCode: number;
  getHeader(name: string): number | string | string[] | undefined;
  setHeader(name: string, value: number | string | readonly string[]): unknown;
  end(body?: string): unknown;
  /** Set once the response has been answered, so nothing writes to it twice. */
  writableEnded?: boolean;
}

export type WebNext = (error?: unknown) => void;
export type WebHandler = (req: WebRequest, res: WebResponse, next: WebNext) => void | Promise<void>;
export type WebErrorHandler = (error: unknown, req: WebRequest, res: WebResponse, next: WebNext) => void;

/** The path of a request, without its query. */
export const pathOf = (req: WebRequest) => {
  const raw = req.url ?? "/";
  const at = raw.indexOf("?");
  return at < 0 ? raw : raw.slice(0, at);
};

/** Its query, parsed once. */
export const queryOf = (req: WebRequest) => new URL(req.url ?? "/", "http://internal").searchParams;

/**
 * Who is at the browser end.
 *
 * The forwarded address first: every session is opened by a server-to-server call,
 * so what the provider sees on the wire is this container - and what its owner
 * then reads on the sessions screen is whatever travelled here.
 */
export const clientContextOf = (req: WebRequest) => {
  const forwarded = req.headers["x-forwarded-for"];
  const first = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined;
  const agent = req.headers["user-agent"];

  return {
    clientIp: first || req.socket?.remoteAddress || null,
    clientUserAgent: typeof agent === "string" ? agent : null,
  };
};

const readCookies = (header: unknown) => {
  const jar = new Map<string, string>();
  if (typeof header !== "string") return jar;

  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    jar.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
  }
  return jar;
};

const serialize = (name: string, value: string, options: CookieOptions) => {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`];
  if (options.maxAge !== undefined) bits.push(`Max-Age=${options.maxAge}`);
  if (options.domain) bits.push(`Domain=${options.domain}`);
  if (options.httpOnly) bits.push("HttpOnly");
  if (options.secure) bits.push("Secure");
  bits.push(`SameSite=${options.sameSite.charAt(0).toUpperCase()}${options.sameSite.slice(1)}`);
  return bits.join("; ");
};

/** Reading and writing cookies on one exchange, on raw headers. */
export const jarOf = (req: WebRequest, res: WebResponse) => {
  const cookies = readCookies(req.headers.cookie);
  const append = (value: string) => {
    const held = res.getHeader("Set-Cookie");
    const list = Array.isArray(held) ? held : typeof held === "string" ? [held] : [];
    res.setHeader("Set-Cookie", [...list, value]);
  };

  const jar: CookieJar = {
    read: (name) => cookies.get(name) ?? null,
    write: (name, value, options) => append(serialize(name, value, options)),
    clear: (name, options) => append(serialize(name, "", { ...options, maxAge: 0 })),
  };
  return jar;
};

export const redirect = (res: WebResponse, url: string) => {
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.end();
};

export const sendJson = (res: WebResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
};
