export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  devtools: { enabled: false },
  colorMode: { preference: 'dark', fallback: 'dark' },
  runtimeConfig: {
    // The database, and nothing about the SSO. Everything the library needs - the
    // identity, the callback, the gate, the broker, the sealing password - comes
    // back from the pairing and lives in `app_settings`. There is no SSO variable
    // to carry into a deployment and none to forget.
    db: {
      host: 'db',
      port: '3306',
      user: 'app',
      password: '',
      name: 'app',
    },
  },
  nitro: {
    experimental: { asyncContext: true },
  },
})
