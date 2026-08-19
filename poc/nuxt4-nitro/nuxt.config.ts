export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  devtools: { enabled: false },
  colorMode: { preference: 'dark', fallback: 'dark' },
  runtimeConfig: {
    db: {
      host: 'db',
      port: '3306',
      user: 'app',
      password: '',
      name: 'app',
    },
    admin: {
      email: '',
      password: '',
    },
    sessionTtlHours: '168',
  },
  nitro: {
    experimental: { asyncContext: true },
  },
})
