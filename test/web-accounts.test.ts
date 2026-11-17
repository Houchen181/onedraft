// Accounts connected by signing in on the website, under what the 2026-11-17 pressure test found broken: sign-in
// windows closed or canceled part way, look-alike cookies, expired sessions on the posting page, switched accounts,
// and the checks and background jobs that don't apply to these accounts. The browser tests use the installed Edge,
// headless, and serve small local pages in place of the sites (nothing reaches them); without Edge they're skipped.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Route } from 'playwright-core'
import { afterAll, describe, expect, it } from 'vitest'
import { NeedsLoginError, type Connector, type ConnectorContext, type WebCookie } from '../src/core/connector'
import { Engine, type ContextFactory } from '../src/core/engine'
import { Inbox } from '../src/core/inbox'
import { Registry } from '../src/core/registry'
import { Store } from '../src/core/store'
import { instagram } from '../src/connectors/instagram'
import { tiktok } from '../src/connectors/tiktok'
import { SITES, signedIn, webConnect, webPublish } from '../src/connectors/web'
import { x } from '../src/connectors/x'
import { BrowserManager } from '../src/main/browser'
import type { Account, ResolvedContent } from '../src/shared/types'

const temp: string[] = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'od-web-'))
  temp.push(d)
  return d
}
afterAll(() => {
  for (const d of temp) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
})

const EDGE = [process.env['ProgramFiles(x86)'], process.env['ProgramFiles'], process.env['LOCALAPPDATA']].some(
  (root) => !!root && existsSync(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
)

const c = (name: string, value: string, domain: string): WebCookie => ({ name, value, domain })

/** A ConnectorContext with only what these tests use. */
function fakeCtx(over: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    setting: () => undefined,
    globalSetting: () => undefined,
    secrets: { get: () => undefined, set: () => undefined },
    log: () => undefined,
    progress: () => undefined,
    fetch: (() => Promise.reject(new Error('no network in tests'))) as typeof fetch,
    oauthLoopback: () => Promise.reject(new Error('unused')),
    openExternal: () => Promise.resolve(),
    browser: () => Promise.reject(new Error('unused')),
    exec: () => Promise.reject(new Error('unused')),
    paths: { data: '', profiles: '', tools: '', temp: '' },
    signal: new AbortController().signal,
    ...over
  }
}

describe('website sign-in cookies', () => {
  it('count only on the site’s own domain', () => {
    for (const d of ['.notx.com', '.netflix.com', '.dropbox.com', 'x.com.evil.test']) expect(signedIn(SITES.x)([c('auth_token', 't', d)])).toBe(false)
    expect(signedIn(SITES.x)([c('auth_token', 't', 'api.x.com')])).toBe(true)
    expect(signedIn(SITES.instagram)([c('sessionid', 's', '.notinstagram.com')])).toBe(false)
    expect(signedIn(SITES.tiktok)([c('sessionid', 's', '.faketiktok.com')])).toBe(false)
    expect(signedIn(SITES.youtube)([c('SAPISID', 's', '.notyoutube.com')])).toBe(false)
  })

  it('give the account id only when the cookie holds a proper one', async () => {
    const connect = (cookies: WebCookie[]) => webConnect('x', fakeCtx({ signInWindow: async () => cookies }), { method: 'web' })
    expect((await connect([c('auth_token', 't', '.x.com'), c('twid', '"u%3D1234"', '.x.com')])).remoteUserId).toBe('1234')
    // A broken %-escape (and a look-alike domain's twid) must not break the connect after a good sign-in.
    const odd = await connect([c('twid', 'u%3D666', '.notx.com'), c('auth_token', 't', '.x.com'), c('twid', 'u%3D12%E0%A4%A', '.x.com')])
    expect(odd.remoteUserId).toMatch(/^x-/)
  })

  it('delete a new profile whose sign-in didn’t finish, and keep one being signed in again', async () => {
    const forgotten: string[] = []
    const ctx = fakeCtx({
      signInWindow: async () => {
        throw new Error('closed early')
      },
      forgetBrowser: async (key) => {
        forgotten.push(key)
      }
    })
    await expect(webConnect('tiktok', ctx, { method: 'web' })).rejects.toThrow('closed early')
    expect(forgotten).toEqual([expect.stringMatching(/^tiktok-/)])
    await expect(webConnect('tiktok', ctx, { _profileKey: 'tiktok-kept' })).rejects.toThrow('closed early')
    expect(forgotten).toHaveLength(1)
  })
})

/** An engine with real connectors whose sign-in window "signs in" to every site at once. */
function rig(connectors: Connector[]) {
  const store = new Store(':memory:')
  const registry = new Registry()
  for (const k of connectors) registry.register(k)
  const forgotten: string[] = []
  const cookies = [c('auth_token', 't', '.x.com'), c('twid', 'u%3D99', '.x.com'), c('sessionid', 's', '.instagram.com'), c('ds_user_id', '42', '.instagram.com'), c('sessionid', 's', '.tiktok.com')]
  const makeContext: ContextFactory = (_p, _a, _s, signal) => ({
    ...fakeCtx({
      signal: signal ?? new AbortController().signal,
      signInWindow: async () => cookies,
      forgetBrowser: async (key) => {
        forgotten.push(key)
      }
    }),
    pendingSecrets: () => undefined
  })
  const engine = new Engine(store, registry, makeContext, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  return { store, engine, forgotten }
}

describe('website accounts in the engine', () => {
  it('connect Instagram by signing in, without the access token the API way needs', async () => {
    const { engine } = rig([instagram])
    expect(await engine.connect('instagram', { method: 'web' })).toMatchObject({ name: 'Instagram account', status: 'connected', meta: { method: 'web' } })
    await expect(engine.connect('instagram', { method: 'api' })).rejects.toThrow(/required/)
  })

  it('delete the replaced account’s browser profile when another account signs in', async () => {
    const { engine, forgotten } = rig([x])
    const first = await engine.connect('x', { method: 'web' })
    const second = await engine.connect('x', { method: 'web' })
    expect(second.id).toBe(first.id)
    expect(forgotten).toEqual([first.meta.profileKey])
  })

  it('check posts by what the website way can do', async () => {
    const { engine } = rig([x, instagram, tiktok])
    const ids = Object.fromEntries(await Promise.all(['x', 'instagram', 'tiktok'].map(async (p) => [p, (await engine.connect(p, { method: 'web' })).id])))
    const post = engine.savePost({
      title: '',
      body: 'word '.repeat(80),
      tags: [],
      media: [],
      aiGenerated: false,
      targets: [
        { accountId: ids.x, variant: {} },
        { accountId: ids.instagram, variant: { options: { format: 'story' } } },
        { accountId: ids.tiktok, variant: {} }
      ]
    })
    const issues = await engine.validatePost(post.id)
    const of = (platform: string) => issues[post.targets.find((t) => t.platform === platform)!.id].map((i) => i.message).join(' | ')
    expect(of('x')).toMatch(/On the website it goes into one post/)
    expect(of('x')).not.toMatch(/thread of|\$0\.20/)
    expect(of('instagram')).toMatch(/can’t post Stories/)
    // TikTok's "Who can view" is chosen on TikTok's own page.
    expect(of('tiktok')).not.toMatch(/Who can view/)
  })

  it('never ask the API for numbers, and say so after a restart when a handed-over window is gone', async () => {
    const { store, engine } = rig([x])
    const a = store.upsertAccount({ platform: 'x', remoteUserId: '99', name: 'X', meta: {} })
    const post = engine.savePost({ title: '', body: 'hi', tags: [], media: [], aiGenerated: false, targets: [{ accountId: a.id, variant: {} }] })
    const t = post.targets[0]
    store.setTarget(t.id, { status: 'published', remoteId: '1' })
    const inbox = new Inbox(engine)
    expect(inbox.hasStats(store.getTarget(t.id)!)).toBe(true)
    await engine.connect('x', { method: 'web' }) // the same account, now signed in on the website
    expect(inbox.hasStats(store.getTarget(t.id)!)).toBe(false)
    store.setTarget(t.id, { status: 'handoff', error: 'Check the post and press Post. (It’s open in the X window.)' })
    engine.recover()
    expect(store.getTarget(t.id)!.error).toMatch(/closed with it.*Post again/)
  })
})

describe.skipIf(!EDGE)('the sign-in window, in Edge', () => {
  const portOf = async (file: string) => {
    for (let i = 0; i < 100; i++) {
      const [port, path] = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
      if (port && path) return `ws://127.0.0.1:${port}${path}`
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('no DevTools port')
  }

  it('fails at once when the window is closed early, instead of waiting forever', async () => {
    const profiles = tempDir()
    const m = new BrowserManager(profiles, () => 'msedge')
    const signing = m.signIn('closing', 'about:blank', () => false, undefined, ['--headless=new', '--remote-debugging-port=0'])
    signing.catch(() => undefined)
    // What closing Edge's last window does: the browser shuts down.
    const ws = new WebSocket(await portOf(join(profiles, 'closing', 'DevToolsActivePort')))
    await new Promise((r) => ws.addEventListener('open', r, { once: true }))
    await new Promise((r) => setTimeout(r, 2000))
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    const t0 = Date.now()
    await expect(signing).rejects.toThrow(/closed before you finished signing in/)
    expect(Date.now() - t0).toBeLessThan(8000)
  }, 60_000)

  it('stops on Cancel, and keeps OneDraft’s own browser off a profile while its sign-in window is open', async () => {
    const m = new BrowserManager(tempDir(), () => 'msedge')
    const ac = new AbortController()
    const signing = m.signIn('cancel', 'about:blank', () => false, ac.signal, ['--headless=new'])
    signing.catch(() => undefined)
    await expect(m.lease('cancel', { headless: true })).rejects.toThrow(/sign-in window is open/)
    await new Promise((r) => setTimeout(r, 2500))
    const t0 = Date.now()
    ac.abort()
    await expect(signing).rejects.toThrow('Sign-in canceled.')
    expect(Date.now() - t0).toBeLessThan(8000)
  }, 60_000)
})

describe.skipIf(!EDGE)('posting on a website page, in Edge', () => {
  const account = { id: 'a', platform: 'x', name: 'My X', status: 'connected', meta: { method: 'web', profileKey: 'k' } } as unknown as Account
  const content: ResolvedContent = { title: '', caption: 'hello', tags: ['tag'], media: [], options: {}, aiGenerated: false }

  /** A headless browser where X's pages are the given HTML and every other request goes nowhere. */
  async function site(pages: Record<string, string>): Promise<BrowserContext> {
    const ctx = await chromium.launchPersistentContext(join(tempDir(), 'profile'), { channel: 'msedge', headless: true })
    await ctx.route('**/*', (route: Route) => {
      const url = route.request().url()
      const hit = Object.keys(pages).find((p) => url.startsWith(p))
      return hit ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: pages[hit] }) : route.abort()
    })
    await ctx.addCookies([{ name: 'auth_token', value: 't', domain: '.x.com', path: '/' }])
    return ctx
  }
  const ctxFor = (browser: BrowserContext, signal?: AbortSignal) => {
    const dir = tempDir()
    return fakeCtx({ browser: async () => browser, paths: { data: dir, profiles: dir, tools: dir, temp: dir }, ...(signal ? { signal } : {}) })
  }

  it('fills in X’s compose dialog, not the timeline composer under it, and hands over', async () => {
    const browser = await site({
      'https://x.com/compose/post':
        '<div data-testid="tweetTextarea_0" contenteditable="true" id="timeline"></div>' +
        '<div role="dialog"><div data-testid="tweetTextarea_0" contenteditable="true" id="box"></div></div>'
    })
    try {
      const r = await webPublish('x', ctxFor(browser), account, { targetId: 't', content })
      expect(r.state).toBe('handoff')
      expect(r.note).toMatch(/^Check the post and press Post\./)
      const page = browser.pages().find((p) => p.url().startsWith('https://x.com/compose'))!
      expect((await page.locator('#box').innerText()).replace(/\s+/g, ' ').trim()).toBe('hello #tag')
      expect(await page.locator('#timeline').innerText()).toBe('')
    } finally {
      await browser.close()
    }
  }, 60_000)

  it('asks to sign in again when the site shows its sign-in page instead', async () => {
    const browser = await site({
      'https://x.com/compose/post': "<script>location.href = 'https://x.com/i/flow/login?redirect_after_login=%2Fcompose%2Fpost'</script>",
      'https://x.com/i/flow/login': '<input type="text"><input type="password">'
    })
    const t0 = Date.now()
    await expect(webPublish('x', ctxFor(browser), account, { targetId: 't', content })).rejects.toBeInstanceOf(NeedsLoginError)
    expect(Date.now() - t0).toBeLessThan(15_000)
    await browser.close().catch(() => undefined)
  }, 60_000)

  it('stops on Cancel and when the window is closed, instead of handing over a page that isn’t there', async () => {
    const empty = { 'https://x.com/compose/post': '<p>loading…</p>' }
    const ac = new AbortController()
    const b1 = await site(empty)
    const canceled = webPublish('x', ctxFor(b1, ac.signal), account, { targetId: 't', content })
    setTimeout(() => ac.abort(), 1500)
    await expect(canceled).rejects.toThrow('Canceled.')
    await b1.close().catch(() => undefined)

    const b2 = await site(empty)
    const closing = webPublish('x', ctxFor(b2), account, { targetId: 't', content })
    setTimeout(() => void Promise.all(b2.pages().map((p) => p.close())), 1500)
    await expect(closing).rejects.toThrow(/window was closed before the post was ready/)
    await b2.close().catch(() => undefined)
  }, 60_000)
})
