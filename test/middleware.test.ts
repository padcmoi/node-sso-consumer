import { describe, expect, it, vi } from "vitest";
import { SsoAuthService } from "../src/auth.service.js";
import { SsoConfigService } from "../src/config.service.js";
import { SsoError } from "../src/errors.js";
import { SsoHttpClient } from "../src/http.js";
import { SsoMiddleware } from "../src/http/middleware.js";
import { SsoSessionService } from "../src/session/session.service.js";
import type { WebRequest, WebResponse } from "../src/http/web.js";
import type { SsoTokens } from "../src/types.js";
import { API_BASE, anAccountRead, anIdentity, stubHmac, stubProvider } from "./support.js";

const PORTAL = "https://portal.example.com/";

/** A response, on the raw shape the library writes to. */
const stubResponse = () => {
  const headers = new Map<string, number | string | string[]>();
  let body: string | undefined;

  const res: WebResponse & { body(): string | undefined; header(name: string): unknown } = {
    statusCode: 200,
    getHeader: (name) => {
      const held = headers.get(name);
      return typeof held === "number" || typeof held === "string" || Array.isArray(held) ? held : undefined;
    },
    setHeader: (name, value) => headers.set(name, typeof value === "string" || typeof value === "number" ? value : [...value]),
    end: (payload) => (body = payload),
    body: () => body,
    header: (name) => headers.get(name),
  };
  return res;
};

const stubRequest = (method: string, url: string, headers: Record<string, unknown> = {}) => {
  const req: WebRequest = { method, url, headers };
  return req;
};

type Resolution = { me: ReturnType<typeof anAccountRead>; tokens: SsoTokens; userId: string } | null;

const withResolve = (resolve: () => Promise<Resolution>) => {
  const provider = stubProvider();
  const identity = anIdentity();
  const http = new SsoHttpClient({ apiBase: API_BASE, identity, hmac: stubHmac(provider) });
  const auth = new SsoAuthService({ http, identity });

  return new SsoMiddleware({
    auth,
    config: new SsoConfigService({ http, frontUrl: "https://sso.example.com", identity }),
    session: new SsoSessionService({ auth, identity }),
    realtime: null,
    resolve,
    portalUrl: () => PORTAL,
    basePath: "/api/auth",
  });
};

const middlewareFor = (resolved: { me: ReturnType<typeof anAccountRead> } | null) =>
  withResolve(() =>
    Promise.resolve(
      resolved
        ? {
            me: resolved.me,
            tokens: { accessToken: "a", accessTokenExpiresAt: "", refreshToken: "r", refreshTokenExpiresAt: "" },
            userId: "user-1",
          }
        : null
    )
  );

describe("the routes", () => {
  it("passes anything that is not one of them straight through", async () => {
    const next = vi.fn();
    await middlewareFor(null).routes()(stubRequest("GET", "/api/queues"), stubResponse(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it("redirects a sign-in to the login window, carrying a state", async () => {
    const res = stubResponse();
    await middlewareFor(null).routes()(stubRequest("GET", "/api/auth/sso/start"), res, vi.fn());

    const location = new URL(String(res.header("Location")));
    expect(res.statusCode).toBe(302);
    expect(location.pathname).toBe("/authorize");
    expect(location.searchParams.get("consumer")).toBe("oauth-test");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("answers the account on the session route", async () => {
    const res = stubResponse();
    await middlewareFor({ me: anAccountRead() }).routes()(stubRequest("GET", "/api/auth/session"), res, vi.fn());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body() ?? "{}")).toEqual({ data: anAccountRead() });
  });

  it("answers 401 on the session route with no session, rather than redirecting an XHR", async () => {
    const res = stubResponse();
    await middlewareFor(null).routes()(stubRequest("GET", "/api/auth/session"), res, vi.fn());

    expect(res.statusCode).toBe(401);
  });

  it("answers 404 for a realtime ticket when no bridge is attached", async () => {
    const res = stubResponse();
    await middlewareFor({ me: anAccountRead() }).routes()(stubRequest("POST", "/api/auth/realtime-ticket"), res, vi.fn());

    expect(res.statusCode).toBe(404);
  });

  it("matches on the verb too, so a GET on the logout route is not one", async () => {
    const next = vi.fn();
    await middlewareFor(null).routes()(stubRequest("GET", "/api/auth/logout"), stubResponse(), next);

    expect(next).toHaveBeenCalledWith();
  });
});

describe("the session guard", () => {
  it("puts the account on the request and lets it through", async () => {
    const req = stubRequest("GET", "/api/queues");
    const next = vi.fn();

    await middlewareFor({ me: anAccountRead() }).requireSession()(req, stubResponse(), next);

    expect(req.me?.user.email).toBe("reader@example.com");
    expect(req.ssoUserId).toBe("user-1");
    expect(next).toHaveBeenCalledWith();
  });

  it("sends a browser with no session to the portal, never to a login page of its own", async () => {
    const res = stubResponse();
    await middlewareFor(null).requireSession()(stubRequest("GET", "/api/queues"), res, vi.fn());

    expect(res.statusCode).toBe(302);
    expect(res.header("Location")).toBe(PORTAL);
  });

  it("hands a provider that is unreachable to the error handler, rather than signing anyone out", async () => {
    const next = vi.fn();
    const failing = withResolve(() => Promise.reject(new SsoError("UNREACHABLE", "down")));

    await failing.requireSession()(stubRequest("GET", "/api/queues"), stubResponse(), next);

    expect(next).toHaveBeenCalledWith(expect.any(SsoError));
  });
});

describe("the permission guard", () => {
  it("lets a request through when every action is held", async () => {
    const req = stubRequest("GET", "/api/queues");
    req.me = anAccountRead(["infrastructure:view-queues", "infrastructure:manage-queues"]);
    const next = vi.fn();

    await middlewareFor(null).requirePermissions("view-queues", "manage-queues")(req, stubResponse(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it("refuses when one is missing, naming it", async () => {
    const req = stubRequest("GET", "/api/queues");
    req.me = anAccountRead(["infrastructure:view-queues"]);
    const next = vi.fn();

    await middlewareFor(null).requirePermissions("view-queues", "delete-queues")(req, stubResponse(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("refuses a request carrying no session at all", async () => {
    const next = vi.fn();
    await middlewareFor(null).requirePermissions("view-queues")(stubRequest("GET", "/api/queues"), stubResponse(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});

describe("the error handler", () => {
  it("answers 403 on a right that is missing, and never a redirect", () => {
    const res = stubResponse();
    middlewareFor(null).errors()(
      new SsoError("FORBIDDEN", "Missing infrastructure:delete-queues"),
      stubRequest("GET", "/"),
      res,
      vi.fn()
    );

    // Signing in again changes nothing about what an account holds: redirecting
    // here would loop.
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body() ?? "{}")).toEqual({ error: "Missing infrastructure:delete-queues" });
  });

  it("redirects to the portal on a session that is over", () => {
    const res = stubResponse();
    middlewareFor(null).errors()(new SsoError("UNAUTHORIZED", "gone"), stubRequest("GET", "/"), res, vi.fn());

    expect(res.statusCode).toBe(302);
    expect(res.header("Location")).toBe(PORTAL);
  });

  it("answers 503 on this application's own problems, saying nothing about them", () => {
    const res = stubResponse();
    middlewareFor(null).errors()(new SsoError("NO_CREDENTIAL", "nothing propagated"), stubRequest("GET", "/"), res, vi.fn());

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body() ?? "{}")).toEqual({ error: "The identity provider is unavailable" });
  });

  it("passes anything that is not its own along", () => {
    const next = vi.fn();
    const error = new Error("a bug in the application");

    middlewareFor(null).errors()(error, stubRequest("GET", "/"), stubResponse(), next);

    expect(next).toHaveBeenCalledWith(error);
  });
});
