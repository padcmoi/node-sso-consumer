import * as H3 from 'h3'
import { isProxiedRoute, PROXY_CFG } from '../proxy.config'

// Everything under /api, relayed to the API and nothing else. This handler is the
// whole backend of this console.
//
// `proxyRequest` and not `sendProxy`: only the first forwards the request body, and
// a sign-in whose body never arrives is a 400 that says "Body cannot be empty".
//
// A path the allowlist does not know is answered 404 HERE. Returning nothing would
// let Nitro fall through to its own 204, which reads as success to a caller and
// tells them nothing.
export default H3.defineEventHandler(async (event) => {
  const url = H3.getRequestURL(event)

  if (!isProxiedRoute(event.method, url.pathname)) {
    throw H3.createError({ statusCode: 404, statusMessage: 'Not Found', message: 'Not Found' })
  }

  return H3.proxyRequest(event, `${PROXY_CFG.apiBaseInternal}${url.pathname}${url.search}`, {
    fetchOptions: {
      // A redirect is for the BROWSER, never for this relay. Left to itself, `fetch`
      // follows it here: `/api/auth/sso/start` answers a 302 towards the login
      // window, and this end would fetch that window and hand its HTML back under
      // this console's own address - a 200 where the browser was owed a 302, and a
      // page of another origin served as if it were ours.
      redirect: 'manual',
      headers: {
        // `host: false` drops the incoming Host, so the API sees its own address
        // rather than the public one and never builds a link from a header a caller
        // wrote.
        ...H3.getProxyRequestHeaders(event, { host: false }),
        // What the API needs to know about the BROWSER rather than about this
        // container. The session the library opens is filed under the reader's
        // address, and without these it would be filed under this container's -
        // one address for every reader, which is what a provider checking a session
        // against where it was opened from would then be comparing.
        'x-forwarded-for': H3.getRequestIP(event, { xForwardedFor: true }) ?? '',
        'x-forwarded-proto': H3.getRequestProtocol(event),
        'x-forwarded-host': H3.getRequestHost(event),
        // PUT BACK BY HAND, because h3 DROPS IT. `accept` sits in h3's own
        // `ignoredHeaders` beside `accept-encoding` and `host`, so
        // `getProxyRequestHeaders` never returns it and the API cannot see what the
        // caller asked for. Every refusal then took the browser branch: an XHR on
        // `/api/me` was answered with a `302` towards the portal, and a `fetch` that
        // follows redirects hands the component the portal's HTML where it expected
        // JSON. Content negotiation is simply impossible behind this relay without
        // this line.
        accept: H3.getHeader(event, 'accept') ?? '',
      },
    },
  })
})
