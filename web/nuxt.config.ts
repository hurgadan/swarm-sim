import { fileURLToPath } from 'node:url'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-11-01',
  devtools: { enabled: true },
  alias: {
    '@contracts': fileURLToPath(new URL('../api/src/_contracts', import.meta.url)),
  },
  runtimeConfig: {
    public: {
      apiBase: 'http://localhost:3001',
    },
  },
})
