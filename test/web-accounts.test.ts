// Accounts connected by signing in on the website, under what the 2026-11-17 pressure test found broken: sign-in
// windows closed or canceled part way, look-alike cookies, expired sessions on the posting page, switched accounts,
// and the checks and background jobs that don't apply to these accounts. The browser tests use the installed Edge,
// headless, and serve small local pages in place of the sites (nothing reaches them); without Edge they're skipped.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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
import { rednote, rednoteSession } from '../src/connectors/rednote'
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
    expect(signedIn(SITES.bilibili)([c('SESSDATA', 's', '.notbilibili.com')])).toBe(false)
    expect(signedIn(SITES.bilibili)([c('SESSDATA', 's', '.bilibili.com')])).toBe(true)
    expect(SITES.bilibili.remoteId?.([c('SESSDATA', 's', '.bilibili.com'), c('DedeUserID', '3546', '.bilibili.com')])).toBe('3546')
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

  it('lets the site finish after the sign-in before closing, and keeps what it adds', async () => {
    // Like Bilibili's: the sign-in page sets its cookie, then a moment later goes on to the site, which adds more.
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        req.url?.startsWith('/home')
          ? "<script>document.cookie = 'landed=1; path=/'</script>"
          : "<script>setTimeout(() => (document.cookie = 'sid=1; path=/'), 300); setTimeout(() => (location.href = '/home'), 3500)</script>"
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const m = new BrowserManager(tempDir(), () => 'msedge')
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login`
      const cookies = await m.signIn('settle', url, (c) => c.some((x) => x.name === 'sid'), undefined, ['--headless=new'])
      expect(cookies.map((c) => c.name).sort()).toEqual(['landed', 'sid'])
    } finally {
      server.close()
    }
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

// Google refuses to sign in a browser that says it's automated ("This browser or app may not be secure"), and
// Chromium says so (navigator.webdriver) whenever DevTools runs over a pipe, as it does for both of OneDraft's windows.
describe.skipIf(!EDGE)('what the sites see, in Edge', () => {
  it('the sign-in window looks like plain Edge: navigator.webdriver is false', async () => {
    const seen: string[] = []
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/report')) {
        seen.push(new URL(req.url, 'http://local').searchParams.get('webdriver') ?? '')
        res.end()
        return
      }
      res.setHeader('content-type', 'text/html')
      res.end("<script>fetch('/report?webdriver=' + navigator.webdriver)</script>")
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const m = new BrowserManager(tempDir(), () => 'msedge')
      const ac = new AbortController()
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
      const signing = m.signIn('webdriver', url, () => false, ac.signal, ['--headless=new'])
      signing.catch(() => undefined)
      for (let i = 0; i < 150 && !seen.length; i++) await new Promise((r) => setTimeout(r, 100))
      ac.abort()
      await expect(signing).rejects.toThrow('Sign-in canceled.')
      expect(seen[0]).toBe('false')
    } finally {
      server.close()
    }
  }, 60_000)

  it('so do the posting windows', async () => {
    process.env['ONEDRAFT_BROWSER_ARGS'] = '--headless=new'
    const m = new BrowserManager(tempDir(), () => 'msedge')
    try {
      const window = await m.lease('webdriver-post', { headless: true })
      const page = await window.newPage()
      expect(await page.evaluate('navigator.webdriver')).toBe(false)
      await window.close()
    } finally {
      delete process.env['ONEDRAFT_BROWSER_ARGS']
      await m.closeAll()
    }
  }, 60_000)
})

describe.skipIf(!EDGE)('posting on a website page, in Edge', () => {
  const account = { id: 'a', platform: 'x', name: 'My X', status: 'connected', meta: { method: 'web', profileKey: 'k' } } as unknown as Account
  const content: ResolvedContent = { title: '', caption: 'hello', tags: ['tag'], media: [], options: {}, aiGenerated: false }

  /** A headless browser where the site's pages are the given HTML and every other request goes nowhere. */
  async function site(pages: Record<string, string>, signIn = { name: 'auth_token', domain: '.x.com' }): Promise<BrowserContext> {
    const ctx = await chromium.launchPersistentContext(join(tempDir(), 'profile'), { channel: 'msedge', headless: true })
    await ctx.route('**/*', (route: Route) => {
      const url = route.request().url()
      const hit = Object.keys(pages).find((p) => url.startsWith(p))
      return hit ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: pages[hit] }) : route.abort()
    })
    await ctx.addCookies([{ ...signIn, value: 't', path: '/' }])
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

  it('fills in Bilibili’s upload page: its own title and suggested tags give way to the post’s', async () => {
    // Like the creator centre's uploader (seen 2026-11-17 on the user's account, in English): a click on the upload
    // area opens the upload component's hidden file box; a file chosen while the page is still starting up is dropped
    // by the page's own script error, and chosen again it starts the upload. The form then shows, with the file name
    // as the title and tags Bilibili suggests; the tag box adds a tag on Enter. BUploader's own box starts nothing.
    const page = `
      <div class="bcc-upload-wrapper">
        <div class="upload-area" style="width:300px;height:120px">Click to upload or drag and drop the video into this area</div>
        <input accept=".mp4,.flv,.mov" multiple type="file" style="display:none" id="pick">
      </div>
      <div id="form" hidden>
        <input type="text" class="input-val" maxlength="80" id="title">
        <div class="tag-input-wrp">
          <div class="tag-pre-wrp">
            <div class="label-item-v2-container">生活<span class="label-item-v2-close">×</span></div>
            <div class="label-item-v2-container">日常<span class="label-item-v2-close">×</span></div>
          </div>
          <input placeholder="Press Enter to create tags" id="tag">
        </div>
        <div class="ql-editor" contenteditable="true" id="desc"><p><br></p></div>
      </div>
      <div style="position:absolute;top:0;left:0;height:1px;width:1px;overflow:hidden;opacity:0">
        <input type="file" name="buploader" multiple accept=".mp4,.flv,.mov">
      </div>
      <script>
        const file = document.getElementById('pick')
        window.chosen = 0
        window.uploads = 0
        document.querySelector('.bcc-upload-wrapper').addEventListener('click', () => {
          file.value = null
          file.click()
        })
        file.addEventListener('change', () => {
          if (++window.chosen === 1) throw new TypeError("Cannot read properties of undefined (reading 'catch')")
          window.uploads++
          document.querySelector('.bcc-upload-wrapper').remove()
          document.getElementById('form').hidden = false
          document.getElementById('title').value = file.files[0].name
        })
        for (const x of document.querySelectorAll('.label-item-v2-close')) x.addEventListener('click', () => x.parentElement.remove())
        const tag = document.getElementById('tag')
        tag.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || !tag.value.trim()) return
          const chip = document.createElement('div')
          chip.className = 'label-item-v2-container'
          chip.textContent = tag.value.trim()
          document.querySelector('.tag-pre-wrp').append(chip)
          tag.value = ''
        })
      </script>`
    const browser = await site({ 'https://member.bilibili.com/platform/upload/video/frame': page }, { name: 'SESSDATA', domain: '.bilibili.com' })
    const clip = join(tempDir(), 'clip.mp4')
    writeFileSync(clip, 'not really a video')
    const bili = { ...account, platform: 'bilibili', name: 'My Bilibili' } as Account
    const post: ResolvedContent = {
      title: 'My video',
      caption: 'About it',
      tags: ['first', '#second', 'first'],
      media: [clip],
      options: { copyright: '2', source: 'https://example.com/v' },
      aiGenerated: true
    }
    try {
      const r = await webPublish('bilibili', ctxFor(browser), bili, { targetId: 't', content: post })
      expect(r.state).toBe('handoff')
      expect(r.note).toMatch(
        /^Choose a creation statement \(创作声明 \/ Creation Statement\), check the details and the category \(分区 \/ Category\), and press 立即投稿 \(Submit\) once the upload says 上传完成 \(Upload complete\)\./
      )
      expect(r.note).toContain('Choose 转载 (Repost) and give the source: https://example.com/v.')
      expect(r.note).toContain('the one for AI-generated content')
      const tab = browser.pages().find((p) => p.url().startsWith('https://member.bilibili.com/'))!
      // Dropped once, chosen again, and uploaded once.
      expect(await tab.evaluate('[window.chosen, window.uploads]')).toEqual([2, 1])
      expect(await tab.locator('#title').inputValue()).toBe('My video')
      expect(await tab.locator('.tag-pre-wrp .label-item-v2-container').allInnerTexts()).toEqual(['first', 'second'])
      expect((await tab.locator('#desc').innerText()).trim()).toBe('About it')
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

describe('Rednote’s sign-in cookies', () => {
  it('count only once someone signs in, and only on Rednote', () => {
    // What a visitor gets on the creator site before signing in (seen 2026-11-17).
    const visitor = ['a1', 'webId', 'gid', 'xsecappid', 'webBuild', 'loadts', 'websectiga', 'sec_poison_id', 'ets'].map((n) => c(n, 'v', '.xiaohongshu.com'))
    expect(rednoteSession([...visitor, c('acw_tc', 'v', 'creator.xiaohongshu.com')])).toBe(false)
    expect(rednoteSession([c('galaxy_creator_session_id', 's', '.xiaohongshu.com')])).toBe(true)
    expect(rednoteSession([c('access-token-creator.xiaohongshu.com', 't', 'creator.xiaohongshu.com')])).toBe(true)
    expect(rednoteSession([c('galaxy_creator_session_id', 's', '.notxiaohongshu.com')])).toBe(false)
    expect(rednoteSession([c('galaxy_creator_session_id', '', '.xiaohongshu.com')])).toBe(false)
    // The shared login a scan sets first (what a 0.1.5 profile closed too early had): the creator site hasn't taken over.
    const shared = ['customer-sso-sid', 'x-user-id-open.xiaohongshu.com', 'customerClientId'].map((n) => c(n, 'v', '.xiaohongshu.com'))
    expect(rednoteSession([...visitor, ...shared])).toBe(false)
  })
})

// The 0.1.4 report: signed in, but the window didn't close, and closing it left Rednote unconnected.
describe.skipIf(!EDGE)('Rednote sign-in, in Edge', () => {
  const LOGIN = '<div class="login-container"><div class="login-box-container">短信登录 扫码登录</div></div>'
  const HOME = '<div class="home">创作服务平台</div>'

  /** OneDraft's browser for these tests: each launch is a headless Edge on the account's profile, Rednote served here. */
  function rednoteCtx(more: Record<string, string> = {}) {
    const root = tempDir()
    const opened: BrowserContext[] = []
    const forgotten: string[] = []
    const pages: Record<string, string> = { '/login': LOGIN, '/new/home': HOME, ...more }
    const ctx = fakeCtx({
      browser: async (key: string) => {
        const b = await chromium.launchPersistentContext(join(root, key), { channel: 'msedge', headless: true })
        await b.route('**/*', (route: Route) => {
          const url = route.request().url()
          const path = Object.keys(pages).find((p) => url.startsWith(`https://creator.xiaohongshu.com${p}`))
          return path ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: pages[path] }) : route.abort()
        })
        opened.push(b)
        return b
      },
      forgetBrowser: async (key: string) => void forgotten.push(key)
    })
    return { ctx, opened, forgotten }
  }
  const session = (expires?: number) =>
    [
      { name: 'galaxy_creator_session_id', value: 's' },
      { name: 'x-user-id-creator.xiaohongshu.com', value: '5f00aa' }
    ].map((k) => ({ ...k, domain: '.xiaohongshu.com', path: '/', ...(expires ? { expires } : {}) }))
  /** Until OneDraft's window shows Rednote's sign-in page. */
  const signInShown = async (opened: BrowserContext[]) => {
    for (let i = 0; i < 150 && !opened[0]?.pages().some((p) => p.url().includes('/login')); i++) await new Promise((r) => setTimeout(r, 100))
    return opened[0]
  }

  it('waits for the creator site’s own sign-in, not just the shared login, in whichever tab it ends', async () => {
    const { ctx, opened } = rednoteCtx()
    let done = false
    const connecting = rednote.connect(ctx, { label: 'Mine' }).finally(() => (done = true))
    const win = await signInShown(opened)
    // The scan's shared login alone: the creator site still says signed out, so the window stays.
    await win.addCookies([{ name: 'customer-sso-sid', value: 's', domain: '.xiaohongshu.com', path: '/' }])
    await new Promise((r) => setTimeout(r, 5000))
    expect(done).toBe(false)
    await win.addCookies(session())
    const t0 = Date.now()
    expect(await connecting).toMatchObject({ name: 'Mine', remoteUserId: '5f00aa' })
    // The first tab never leaves the sign-in page here: OneDraft gives it a few seconds to, then connects anyway.
    expect(Date.now() - t0).toBeLessThan(14_000)
  }, 60_000)

  it('says “signed out” when the creator site turns its page into the sign-in page, not that a box is missing', async () => {
    const { ctx, opened } = rednoteCtx({ '/publish/publish': "<p>加载中</p><script>setTimeout(() => (location.href = '/login?source=&redirectReason=401'), 3500)</script>" })
    const clip = join(tempDir(), 'clip.mp4')
    writeFileSync(clip, 'not really a video')
    const account = { id: 'r', platform: 'rednote', name: 'Rednote', status: 'connected', meta: { profileKey: 'k' } } as unknown as Account
    const post: ResolvedContent = { title: 'Hi', caption: 'Hello', tags: [], media: [clip], options: {}, aiGenerated: false }
    try {
      await expect(rednote.publish(ctx, account, { targetId: 't', content: post })).rejects.toBeInstanceOf(NeedsLoginError)
    } finally {
      for (const b of opened) await b.close().catch(() => undefined)
    }
  }, 60_000)

  it('also connects on a creator page past the sign-in in another tab, should Rednote rename its cookies', async () => {
    const { ctx, opened } = rednoteCtx()
    const connecting = rednote.connect(ctx, {})
    const win = await signInShown(opened)
    await (await win.newPage()).goto('https://creator.xiaohongshu.com/new/home')
    expect((await connecting).remoteUserId).toMatch(/^rednote-/)
  }, 60_000)

  it('connects when the window is closed right after signing in: the profile kept the sign-in', async () => {
    const { ctx, opened, forgotten } = rednoteCtx()
    const connecting = rednote.connect(ctx, {})
    const win = await signInShown(opened)
    // Signed in, and the window closed before OneDraft's next look.
    await win.addCookies(session(Math.floor(Date.now() / 1000) + 86_400))
    await win.close()
    expect(await connecting).toMatchObject({ remoteUserId: '5f00aa' })
    expect(opened).toHaveLength(2)
    expect(forgotten).toEqual([])
  }, 60_000)

  it('says so when the window is closed without signing in, and deletes the new profile', async () => {
    const { ctx, opened, forgotten } = rednoteCtx()
    const connecting = rednote.connect(ctx, {})
    connecting.catch(() => undefined)
    const win = await signInShown(opened)
    await win.close()
    await expect(connecting).rejects.toThrow('The sign-in window was closed before you finished signing in.')
    expect(forgotten).toHaveLength(1)
  }, 60_000)
})
