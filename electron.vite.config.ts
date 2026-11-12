import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: { externalizeDeps: true, rollupOptions: { external: ['node:sqlite'] } }
  },
  preload: {
    resolve: { alias: shared },
    build: { externalizeDeps: true }
  },
  renderer: {
    resolve: { alias: shared },
    plugins: [react()]
  }
})
