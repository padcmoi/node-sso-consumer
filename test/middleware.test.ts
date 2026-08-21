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
    config: new SsoConfigService({ http, frontUrl: () => "https://sso.example.com", identity }),
    session: new SsoSessionService({ auth, identity }),
    realtime: null,
    // Serving: these tests are about what the guards do with an ACCOUNT. A bridge
    // that is not serving shuts every one of them, which is one answer that does not
    // vary per route.
    serving: () => true,
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
    // The resource travels with the account: a page cannot work out which one its
    // application is, and the convention it used to guess from does not exist on an
    // application that declares no gate.
    expect(JSON.parse(res.body() ?? "{}")).toEqual({ data: anAccountRead(), resource: "infrastructure" });
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

  // A provider that cannot be reached is a reader nothing was learned about, so it
  // is refused like any other - to the portal. Answered HERE and not handed to the
  // error handler: a refusal that depends on that handler being mounted is one an
  // application can forget to install, and forgetting it let the request carry on.
  it("refuses to the portal when the provider cannot be reached, rather than carrying on", async () => {
    const next = vi.fn();
    const res = stubResponse();
    const failing = withResolve(() => Promise.reject(new SsoError("UNREACHABLE", "down")));

    await failing.requireSession()(stubRequest("GET", "/api/queues"), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(302);
    expect(res.header("Location")).toBe(PORTAL);
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

  // `403` where it stands, and never a redirect: the account IS signed in and
  // simply does not hold the right, so signing in again would change nothing and
  // loop. Answered here rather than handed on, for the reason above.
  it("refuses when one is missing, naming it, without redirecting", async () => {
    const req = stubRequest("GET", "/api/queues");
    req.me = anAccountRead(["infrastructure:view-queues"]);
    const next = vi.fn();
    const res = stubResponse();

    await middlewareFor(null).requirePermissions("view-queues", "delete-queues")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body() ?? "").toContain("delete-queues");
  });

  it("refuses a request carrying no session at all", async () => {
    const next = vi.fn();
    const res = stubResponse();

    await middlewareFor(null).requirePermissions("view-queues")(stubRequest("GET", "/api/queues"), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
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

  // Everything that is not FORBIDDEN is ONE answer, because in every one of them
  // nobody was identified: session over, provider refusing, provider unreachable,
  // credential never delivered. To the portal - and `500` only when there is no
  // portal to send anybody to, which is an application that never paired.
  it("refuses to the portal on this application's own problems, saying nothing about them", () => {
    const res = stubResponse();
    middlewareFor(null).errors()(new SsoError("NO_CREDENTIAL", "nothing propagated"), stubRequest("GET", "/"), res, vi.fn());

    expect(res.statusCode).toBe(302);
    expect(res.header("Location")).toBe(PORTAL);
  });

  it("passes anything that is not its own along", () => {
    const next = vi.fn();
    const error = new Error("a bug in the application");

    middlewareFor(null).errors()(error, stubRequest("GET", "/"), stubResponse(), next);

    expect(next).toHaveBeenCalledWith(error);
  });
});
