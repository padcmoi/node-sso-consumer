import { describe, expect, it } from "vitest";
import { sameValue, seal, unseal } from "../src/session/seal.js";
import { SESSION_PASSWORD } from "./support.js";

describe("the sealed cookie", () => {
  it("gives back exactly what was sealed", () => {
    const payload = { userId: "user-1", tokens: { accessToken: "a", refreshToken: "b" } };
    expect(unseal(SESSION_PASSWORD, seal(SESSION_PASSWORD, payload))).toEqual(payload);
  });

  it("is different every time, so two identical sessions do not look alike on the wire", () => {
    expect(seal(SESSION_PASSWORD, { a: 1 })).not.toEqual(seal(SESSION_PASSWORD, { a: 1 }));
  });

  it("refuses a cookie whose body was edited", () => {
    const sealed = seal(SESSION_PASSWORD, { userId: "user-1" });
    const [version, iv, tag, body] = sealed.split(".");
    const tampered = [version, iv, tag, `${body.slice(0, -2)}AA`].join(".");

    // The GCM tag is what makes this a failure rather than a different session.
    expect(unseal(SESSION_PASSWORD, tampered)).toBeNull();
  });

  it("refuses a cookie sealed with another password, which is what rotating one does", () => {
    const sealed = seal(SESSION_PASSWORD, { userId: "user-1" });
    expect(unseal("another-password-of-32-characters", sealed)).toBeNull();
  });

  it("refuses anything that is not a sealed cookie", () => {
    expect(unseal(SESSION_PASSWORD, "")).toBeNull();
    expect(unseal(SESSION_PASSWORD, "not-a-cookie")).toBeNull();
    expect(unseal(SESSION_PASSWORD, "v2.a.b.c")).toBeNull();
  });

  it("refuses to seal with a password short enough to be guessed", () => {
    expect(() => seal("too-short", { a: 1 })).toThrow(/at least 32/);
  });

  it("compares two values without leaking how far they matched", () => {
    expect(sameValue("abc", "abc")).toBe(true);
    expect(sameValue("abc", "abd")).toBe(false);
    expect(sameValue("abc", "abcd")).toBe(false);
  });
});
