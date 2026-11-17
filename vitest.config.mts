import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: { alias: { '@shared': resolve(here, 'src/shared') } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A fresh GitHub machine runs ffmpeg several times slower than a desktop, and video tests that take a second here
    // have timed out at Vitest's default 5 s there. On CI each test gets a minute; locally a hang still shows in 5 s.
    testTimeout: process.env['CI'] ? 60_000 : 5_000
  }
})
