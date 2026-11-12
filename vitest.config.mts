import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: { alias: { '@shared': resolve(here, 'src/shared') } },
  test: { include: ['test/**/*.test.ts'], environment: 'node' }
})
