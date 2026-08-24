export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  runtimeConfig: {
    // The database, and NOTHING about the SSO - not even here, where there is no
    // provider. The cookie's sealing password is minted at the first boot and kept
    // in `app_settings`, so there is no secret to carry into a deployment.
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
