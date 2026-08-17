import { describe, expect, it } from "vitest";
import { clientContextOf, jarOf, pathOf, queryOf, redirect, sendJson } from "../src/http/web.js";
import type { WebRequest, WebResponse } from "../src/http/web.js";

const request = (url: string, headers: Record<string, unknown> = {}, remoteAddress?: string) => {
  const req: WebRequest = { method: "GET", url, headers, socket: { remoteAddress } };
  return req;
};

/** The Set-Cookie header, as a list, whatever the response held it as. */
const cookiesOf = (res: { header(name: string): unknown }) => {
  const held = res.header("Set-Cookie");
  return Array.isArray(held) ? held.map(String) : [];
};

const response = () => {
  const headers = new Map<string, number | string | string[]>();
  let body: string | undefined;

  const res: WebResponse & { header(name: string): unknown; body(): string | undefined } = {
    statusCode: 200,
    getHeader: (name) => {
      const held = headers.get(name);
      return typeof held === "number" || typeof held === "string" || Array.isArray(held) ? held : undefined;
    },
    setHeader: (name, value) => headers.set(name, typeof value === "string" || typeof value === "number" ? value : [...value]),
    end: (payload) => (body = payload),
    header: (name) => headers.get(name),
    body: () => body,
  };
  return res;
};

describe("reading a request the way Node hands it over", () => {
  it("splits the path from its query", () => {
    expect(pathOf(request("/api/auth/session?a=1"))).toBe("/api/auth/session");
    expect(pathOf(request("/api/auth/session"))).toBe("/api/auth/session");
    expect(pathOf(request(""))).toBe("");
  });

  it("parses the query without any framework's help", () => {
    expect(queryOf(request("/cb?code=abc&state=xyz")).get("code")).toBe("abc");
    expect(queryOf(request("/cb")).get("code")).toBeNull();
  });

  it("prefers the forwarded address, since every session is opened server to server", () => {
    const context = clientContextOf(
      request("/", { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "Firefox" }, "10.0.0.1")
    );

    // What the provider sees on the wire is this container. What its owner then
    // reads on the sessions screen is whatever travelled here.
    expect(context).toEqual({ clientIp: "203.0.113.7", clientUserAgent: "Firefox" });
  });

  it("falls back to the socket, and to null when there is nothing", () => {
    expect(clientContextOf(request("/", {}, "10.0.0.1")).clientIp).toBe("10.0.0.1");
    expect(clientContextOf(request("/")).clientIp).toBeNull();
    expect(clientContextOf(request("/")).clientUserAgent).toBeNull();
  });
});

describe("the cookie jar, on raw headers", () => {
  it("reads a cookie out of the header, decoding it", () => {
    const jar = jarOf(request("/", { cookie: "sso_session=a%20b; other=2" }), response());

    expect(jar.read("sso_session")).toBe("a b");
    expect(jar.read("absent")).toBeNull();
  });

  it("keeps every cookie it writes, rather than replacing the header", () => {
    const res = response();
    const jar = jarOf(request("/"), res);

    jar.write("sso_state", "abc", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 });
    jar.write("sso_session", "def", { httpOnly: true, secure: true, sameSite: "lax", path: "/" });

    expect(cookiesOf(res)).toHaveLength(2);
  });

  it("spells the attributes the way a browser reads them", () => {
    const res = response();
    jarOf(request("/"), res).write("sso_session", "v", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60,
      domain: "example.com",
    });

    const [written] = cookiesOf(res);
    expect(written).toBe("sso_session=v; Path=/; Max-Age=60; Domain=example.com; HttpOnly; Secure; SameSite=Lax");
  });

  it("clears a cookie by writing it empty with no life left", () => {
    const res = response();
    jarOf(request("/"), res).clear("sso_state", { httpOnly: true, secure: true, sameSite: "lax", path: "/" });

    const [written] = cookiesOf(res);
    expect(written).toContain("Max-Age=0");
  });
});

describe("answering", () => {
  it("redirects with a 302 and a location", () => {
    const res = response();
    redirect(res, "https://portal.example.com/");

    expect(res.statusCode).toBe(302);
    expect(res.header("Location")).toBe("https://portal.example.com/");
  });

  it("sends JSON with its content type", () => {
    const res = response();
    sendJson(res, 403, { error: "nope" });

    expect(res.statusCode).toBe(403);
    expect(res.header("content-type")).toBe("application/json; charset=utf-8");
    expect(res.body()).toBe('{"error":"nope"}');
  });
});
