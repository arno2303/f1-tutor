import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  server: {
    // Lets `npm run dev` talk to a running server.py.
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
      '/voice': { target: 'http://127.0.0.1:8000' },
      '/api': { target: 'http://127.0.0.1:8000' },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
})
