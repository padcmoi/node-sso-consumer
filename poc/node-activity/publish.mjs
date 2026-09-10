// Proves that `activity.publish` reaches x-core.
//
// The library runs here as an application runs it: compiled from `src/` in the
// image, imported from `dist/`, driven through `createXcoreBridge`. What this script
// does by hand is only what the BROWSER and app_sso do before an application ever
// sees a code - sign in, get a grant - because there is no browser in a container.
// From the code onwards everything is the library: the exchange, the session, the
// publication, each one a signed call.
//
// It proves the message PASSES, and says exactly what x-core answered. Whether
// x-core then writes the line is x-core's side: an x-core without
// `POST /api/v1/sso/consumer/activity` answers 404, which still proves the message
// travelled, signed, to the right address.
import { randomBytes } from "node:crypto";
import { createXcoreBridge } from "../../dist/index.js";

const ACTIVITY_PATH = "/api/v1/sso/consumer/activity";

const env = (name, fallback) => {
  const value = process.env[name]?.trim() || fallback;
  if (!value) {
    console.error(`[poc] ${name} is not set: copy .env.sample to .env and fill it`);
    process.exit(2);
  }
  return value;
};

const API = env("XCORE_API").replace(/\/+$/, "");
const FRONT = env("XCORE_FRONT").replace(/\/+$/, "");
const CONSUMER = env("CONSUMER");
const EMAIL = env("READER_EMAIL");
const PASSWORD = env("READER_PASSWORD");
// Where the reader is, as app_sso would forward it. Absent, x-core measures the
// sign-in from this container's own address.
const READER_IP = process.env.READER_IP?.trim() || null;
// The hash this application would sign with once paired. A dev x-core does not
// verify signatures, so any value passes there; a real one is needed anywhere else.
const HMAC_HASH = env("HMAC_HASH", "dev-unverified");

const context = { ip: READER_IP, userAgent: "poc-node-activity" };

// ── EVERY CALL, RECORDED ─────────────────────────────────────────────────────
//
// The library signs through the global `fetch`, so this is where what actually
// travels can be read: the address, the verb, the identity that signed, the body,
// and what x-core answered.
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const headers = {};
  if (init.headers instanceof Headers) init.headers.forEach((value, name) => (headers[name] = value));
  else Object.assign(headers, init.headers ?? {});
  const call = { url: String(url), method: init.method ?? "GET", headers, body: init.body ?? null, status: null, answer: null };
  calls.push(call);
  const response = await realFetch(url, init);
  call.status = response.status;
  call.answer = await response
    .clone()
    .text()
    .catch(() => "");
  return response;
};

// ── WHAT THE BROWSER AND app_sso DO ──────────────────────────────────────────
const idp = async (path, body, method = "POST") => {
  const response = await realFetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, data: parsed?.data ?? null, text };
};

const signedIn = await idp("/api/v1/sso/login", { email: EMAIL, password: PASSWORD, context });
if (signedIn.status !== 200 || !signedIn.data?.ssoSession) {
  const asked = signedIn.data?.mfaRequired || signedIn.data?.twoFactorRequired;
  console.error(
    asked
      ? "[poc] x-core asks this reader for a code (second factor or unusual sign-in): sign in once through the portal from here, or set READER_IP to a known address"
      : `[poc] sign-in refused: ${signedIn.status} ${signedIn.text.slice(0, 200)}`
  );
  process.exit(2);
}
const ssoSession = signedIn.data.ssoSession;

const granted = await idp("/api/v1/sso/grant", { ssoSession, consumer: CONSUMER, interactive: false, context });
if (granted.status !== 200 || !granted.data?.code) {
  console.error(`[poc] grant refused for ${CONSUMER}: ${granted.status} ${granted.text.slice(0, 200)}`);
  await idp("/api/v1/sso/session", { ssoSession }, "DELETE");
  process.exit(2);
}

// ── FROM HERE, THE LIBRARY ───────────────────────────────────────────────────
const logger = {
  debug() {},
  info() {},
  warn: (message) => console.warn(`  lib warn  ${message}`),
  error: (message) => console.error(`  lib error ${message}`),
};

// A store holding a paired application, in memory: this container keeps nothing.
const storeFor = () => {
  const held = {
    INSTALLED: true,
    SSO_CLIENT_ID: CONSUMER,
    SSO_SESSION_PASSWORD: randomBytes(32).toString("base64url"),
    SSO_SESSION_COOKIE_NAME: "sso_poc_activity",
  };
  return { load: () => ({ ...held }), save: (values) => Object.assign(held, values) };
};

const bridgeFor = (mode) =>
  createXcoreBridge({
    mode,
    provider: { baseUrl: API, frontUrl: FRONT },
    live: { enabled: false },
    retry: { attempts: 1, delayMs: 0 },
    di: {
      hmac: { getCredential: () => HMAC_HASH, setCredential() {} },
      environment: storeFor(),
    },
    logger,
  });

const xcore = bridgeFor("sso");
await xcore.load();

// The code exchange, exactly as the library's callback route does it.
const session = await xcore.auth.openSession({
  code: granted.data.code,
  clientIp: "90.116.244.74",
  clientUserAgent: "Mozilla/5.0 (poc-node-activity)",
});

// A request as an application's handler receives it, behind `requireSession()`:
// the guard has put the proven pair on it.
const request = {
  method: "POST",
  url: "/api/invoices/42/pay",
  headers: { "x-forwarded-for": "90.116.244.74", "user-agent": "Mozilla/5.0 (poc-node-activity)" },
  ssoTokens: session,
};
const response = { statusCode: 200, getHeader() {}, setHeader() {}, end() {} };

const activity = {
  action: "poc.invoice-paid",
  label: "POC node-activity : facture F-2026-042 payée",
  entity: { type: "invoice", id: 42, label: "F-2026-042" },
  details: { amount: 1200, run: new Date().toISOString() },
};

const before = calls.length;
const published = await xcore.activity.publish(request, response, activity);
const sent = calls.slice(before).find((call) => call.url.endsWith(ACTIVITY_PATH));

// The same call at `"local"`: nothing may leave.
const localBefore = calls.length;
const local = await bridgeFor("local").activity.publish(request, response, activity);
const localCalls = calls.length - localBefore;

// Leave nothing open behind: this application's session, then the IdP's.
await xcore.auth.closeSession({ refreshToken: session.refreshToken }).catch(() => undefined);
await idp("/api/v1/sso/session", { ssoSession }, "DELETE");

// ── WHAT HAPPENED ────────────────────────────────────────────────────────────
const redact = (body) => {
  const parsed = JSON.parse(body);
  parsed.accessToken = `${String(parsed.accessToken).slice(0, 12)}... (${String(parsed.accessToken).length} chars)`;
  return JSON.stringify(parsed, null, 2);
};

console.log("\n=== activity.publish, mode sso ===");
if (!sent) {
  console.log("no call to x-core left the library");
} else {
  console.log(`sent      ${sent.method} ${sent.url}`);
  console.log(`signed as ${sent.headers["x-client-id"] ?? "(no x-client-id header)"}`);
  console.log(`headers   ${Object.keys(sent.headers).sort().join(", ")}`);
  console.log(`body      ${redact(sent.body).replace(/\n/g, "\n          ")}`);
  console.log(`x-core    ${sent.status} ${sent.answer.slice(0, 300)}`);
}
console.log(`result    ${JSON.stringify(published)}`);

console.log("\n=== activity.publish, mode local ===");
console.log(`result    ${JSON.stringify(local)}, calls to x-core: ${localCalls}`);

const passed = Boolean(sent && sent.status !== null) && localCalls === 0;
console.log(
  `\n${passed ? "PASSED" : "FAILED"}: ` +
    (sent
      ? `the message reached x-core, which answered ${sent.status}` +
        (sent.status === 404 ? " (no route for it yet: the message arrived, nothing handles it)" : "")
      : "nothing reached x-core")
);
process.exit(passed ? 0 : 1);
