export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  devtools: { enabled: false },
  colorMode: { preference: 'dark', fallback: 'dark' },

  // NO `runtimeConfig`, and nothing to put in one. This half holds no database, no
  // credential and no address: the API is a sibling container reached by its network
  // alias, and that name is written in `server/proxy.config.ts` where it can be read
  // beside the allowlist it belongs to.
  nitro: {
    // `websocket` is what mounts `server/routes/_ws/`, which is where the realtime
    // socket is relayed to the API. Without it that route does not exist and the
    // browser's upgrade is answered by the page router.
    experimental: { asyncContext: true, websocket: true },
  },
})
