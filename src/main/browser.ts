// Persistent Playwright browser profiles, one per account, using the installed Edge or Chrome
// (no bundled browser download). Contexts are leased: a connector that leaves a window open for the
// person (handoff) simply doesn't close it; others close their lease when done.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext } from 'playwright-core'

interface Entry {
  ctx: BrowserContext
  leases: number
  headless: boolean
}

export class BrowserManager {
  private open = new Map<string, Entry>()
  private opening = new Map<string, Promise<Entry>>()

  constructor(
    private profilesDir: string,
    private channel: () => string
  ) {}

  async lease(key: string, opts: { headless?: boolean } = {}): Promise<BrowserContext> {
    if (!/^[\w-]+$/.test(key)) throw new Error(`Bad browser profile key "${key}"`)
    const headless = opts.headless ?? false
    let entry = this.open.get(key)
    // A headless context can't show a window; reopen visibly if a visible one is needed.
    if (entry && entry.headless && !headless && entry.leases === 0) {
      await entry.ctx.close().catch(() => undefined)
      this.open.delete(key)
      entry = undefined
    }
    if (!entry) {
      let p = this.opening.get(key)
      if (!p) {
        p = this.launch(key, headless)
        this.opening.set(key, p)
      }
      try {
        entry = await p
      } finally {
        this.opening.delete(key)
      }
    }
    entry.leases++
    return this.wrap(key, entry)
  }

  private async launch(key: string, headless: boolean): Promise<Entry> {
    const dir = join(this.profilesDir, key)
    mkdirSync(dir, { recursive: true })
    const ctx = await chromium.launchPersistentContext(dir, {
      channel: this.channel() || 'msedge',
      headless,
      viewport: null,
      locale: 'zh-CN',
      args: ['--start-maximized']
    })
    const entry: Entry = { ctx, leases: 0, headless }
    this.open.set(key, entry)
    ctx.on('close', () => {
      if (this.open.get(key) === entry) this.open.delete(key)
    })
    return entry
  }

  /** The caller's close() releases its lease; the real context closes when nobody holds it. */
  private wrap(key: string, entry: Entry): BrowserContext {
    let released = false
    return new Proxy(entry.ctx, {
      get: (target, prop, receiver) => {
        if (prop === 'close') {
          return async () => {
            if (released) return
            released = true
            entry.leases--
            if (entry.leases <= 0 && this.open.get(key) === entry) {
              this.open.delete(key)
              await target.close().catch(() => undefined)
            }
          }
        }
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? v.bind(target) : v
      }
    })
  }

  async closeAll() {
    for (const e of this.open.values()) await e.ctx.close().catch(() => undefined)
    this.open.clear()
  }
}
