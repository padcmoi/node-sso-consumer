// This console holds no backend. Everything under /api is answered by the NestJS
// API, and this file plus the two relays beside it are the whole of `server/`.
//
// The address is written here and not read from the environment. There is one API,
// it is a sibling container on the same compose network, and `api` is a network
// alias the compose declares - it cannot resolve to anything else. A variable would
// only ever be a way to point this console at something that does not answer.
export const PROXY_CFG = {
  apiBaseInternal: 'http://api:3333',
  wsBaseInternal: 'ws://api:3333',
} as const

// The ONLY routes this console relays. Anything absent from it is a 404 from here
// and never reaches the API - the same idea as x-core's `SIGNED_ROUTES`: an
// allowlist is what keeps a route added over there from becoming browser-reachable
// over here without anyone deciding it should be.
//
// A `:param` is matched as one path segment and never across a slash.
const PROXIED_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  // ── THE LIBRARY'S SIX ROUTES ──────────────────────────────────────────────
  //
  // They are mounted on the API, and they are reached HERE: the browser only ever
  // knows this origin. Two of them are navigations rather than calls - the browser
  // leaves for the login window on the first and comes back with a code on the
  // second - which is why the relay must not follow redirects itself.
  //
  // They are under /api because that is the only prefix this relay forwards. A
  // callback declared anywhere else would be answered by this console's own 404,
  // and the pairing is what declares it: the address is entered on x-core's form
  // and comes back written into `SSO_REDIRECT_URI`.
  { method: 'GET', path: '/api/auth/sso/start' },
  { method: 'GET', path: '/api/auth/sso/callback' },
  // Only ever reached while the library stands in for x-core. In `"sso"`
  // nobody signs in here: the portal does.
  { method: 'POST', path: '/api/auth/sso/sign-in' },
  { method: 'POST', path: '/api/auth/logout' },
  { method: 'GET', path: '/api/auth/session' },
  // The ticket the page dials the socket with: thirty seconds, single use, and the
  // access token it stands for never reaches the browser.
  { method: 'POST', path: '/api/auth/realtime-ticket' },

  // ── THIS APPLICATION'S OWN ────────────────────────────────────────────────
  //
  // Where a browser with no session goes, and where a sign-out lands. Public: it
  // is the one thing somebody without a session legitimately needs.
  { method: 'GET', path: '/api/portal' },
  // The account behind the request, read through the API's guard. One route, and
  // it is the whole business surface of this POC: what it proves is that a Nest
  // controller gets `req.me` without writing a line of session code.
  { method: 'GET', path: '/api/me' },
]

const MATCHERS = PROXIED_ROUTES.map((route) => ({
  method: route.method,
  pattern: new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`),
}))

export function isProxiedRoute(method: string, path: string) {
  return MATCHERS.some((matcher) => matcher.method === method && matcher.pattern.test(path))
}
