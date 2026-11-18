// Connecting accounts without developer apps: Bilibili's QR-code login (shown in OneDraft's own window and saved as
// biliup's cookie file), signing in on a website (cookies say when it's done), and Windows command-line quoting for
// programs that get a console window of their own.

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectorContext, WebCookie } from '../src/core/connector'
import { qrLogin, signTv } from '../src/connectors/bilibili'
import { signedIn, SITES, webConnect } from '../src/connectors/web'
import { winQuote } from '../src/main/context'

const APPSEC = '59b43e04ad6965f34319062b478f83dd'

/** A ConnectorContext with only what these tests use. */
function fakeCtx(over: Partial<ConnectorContext>): ConnectorContext {
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

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('Bilibili QR-code login', () => {
  it('signs requests the way biliup does: sorted parameters, then md5 of the query and the app secret', () => {
    const q = signTv({ ts: '1700000000', local_id: '0', appkey: '4409e2ce8ffd12b8' })
    const base = 'appkey=4409e2ce8ffd12b8&local_id=0&ts=1700000000'
    expect(q).toBe(`${base}&sign=${createHash('md5').update(base + APPSEC).digest('hex')}`)
  })

  it('shows the code, waits for the scan, makes a new code when one expires, and returns biliup’s cookie file', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const shown: { text: string; note?: string }[] = []
    const polls = [{ code: 86039 }, { code: 86038 }, { code: 86090 }]
    const ok = {
      code: 0,
      data: {
        cookie_info: { cookies: [{ name: 'SESSDATA', value: 's' }] },
        sso: ['https://passport.bilibili.com/api/v2/sso'],
        token_info: { access_token: 'at', expires_in: 15552000, mid: 42, refresh_token: 'rt', extra: 'dropped' },
        mid: 42
      }
    }
    let made = 0
    const bodies: string[] = []
    const ctx = fakeCtx({
      showQr: (text, note) => shown.push({ text, note }),
      fetch: (async (url: string, init?: RequestInit) => {
        bodies.push(String(init?.body))
        if (url.endsWith('/qrcode/auth_code')) {
          made++
          return json({ code: 0, data: { url: `https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=c${made}`, auth_code: `c${made}` } })
        }
        return json(polls.shift() ?? ok)
      }) as typeof fetch
    })
    const p = qrLogin(ctx)
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1500)
    const login = await p
    vi.useRealTimers()
    expect(made).toBe(2)
    expect(shown.map((s) => s.text)).toEqual([
      'http://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=c1',
      'http://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=c2'
    ])
    expect(shown[1].note).toMatch(/expired/)
    expect(bodies.some((b) => b.includes('auth_code=c2') && /&sign=[0-9a-f]{32}$/.test(b))).toBe(true)
    // Exactly biliup's LoginInfo: what `biliup upload` and `biliup renew` read.
    expect(login).toEqual({
      cookie_info: { cookies: [{ name: 'SESSDATA', value: 's' }] },
      sso: ['https://passport.bilibili.com/api/v2/sso'],
      token_info: { access_token: 'at', expires_in: 15552000, mid: 42, refresh_token: 'rt' },
      platform: 'BiliTV'
    })
  })

  it('sends an account Bilibili keeps out of the QR login (48007) to the website way', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const ctx = fakeCtx({
      showQr: () => undefined,
      fetch: (async (url: string) =>
        url.endsWith('/qrcode/auth_code')
          ? json({ code: 0, data: { url: 'https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=c1', auth_code: 'c1' } })
          : json({ code: 48007, message: '当前账号暂不支持在本APP登录' })) as typeof fetch
    })
    const login = qrLogin(ctx)
    login.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(1500)
    vi.useRealTimers()
    await expect(login).rejects.toThrow(/48007 当前账号暂不支持在本APP登录.*“Sign in with your browser”/)
  })

  it('says what went wrong when Bilibili refuses', async () => {
    const ctx = fakeCtx({ fetch: (async () => json({ code: -3, message: 'API校验密匙错误' })) as unknown as typeof fetch })
    await expect(qrLogin(ctx)).rejects.toThrow(/wouldn’t make a login QR code \(-3/)
  })
})

describe('signing in on a website', () => {
  const c = (name: string, value: string, domain: string): WebCookie => ({ name, value, domain })

  it('knows when each site is signed in, by its login cookie on its own domain', () => {
    expect(signedIn(SITES.x)([c('auth_token', 'abc', '.x.com')])).toBe(true)
    expect(signedIn(SITES.x)([c('auth_token', '', '.x.com')])).toBe(false)
    expect(signedIn(SITES.x)([c('auth_token', 'abc', '.example.com')])).toBe(false)
    expect(signedIn(SITES.instagram)([c('csrftoken', 'x', '.instagram.com')])).toBe(false)
    expect(signedIn(SITES.instagram)([c('sessionid', 'x', '.instagram.com')])).toBe(true)
    expect(signedIn(SITES.tiktok)([c('sid_tt', 'x', '.tiktok.com')])).toBe(true)
    expect(signedIn(SITES.youtube)([c('SID', 'x', '.google.com')])).toBe(false)
    expect(signedIn(SITES.youtube)([c('LOGIN_INFO', 'x', '.youtube.com')])).toBe(true)
  })

  it('connects through a sign-in window and keeps the profile as the account', async () => {
    let opened = ''
    const ctx = fakeCtx({
      signInWindow: async (key, url, done) => {
        opened = `${key} ${url}`
        const cookies = [c('auth_token', 't', '.x.com'), c('twid', 'u%3D1234567', '.x.com')]
        expect(done(cookies)).toBe(true)
        return cookies
      }
    })
    const r = await webConnect('x', ctx, { method: 'web', label: ' My X ' })
    expect(opened).toMatch(/^x-[\w-]+ https:\/\/x\.com\/i\/flow\/login$/)
    expect(r).toMatchObject({ name: 'My X', remoteUserId: '1234567', meta: { method: 'web' } })
    // Signing in again keeps the same profile.
    const again = await webConnect('x', ctx, { _profileKey: String(r.meta?.profileKey) })
    expect(again.meta?.profileKey).toBe(r.meta?.profileKey)
    expect(again.name).toBe('X account')
  })
})

describe('Windows command lines', () => {
  it('quotes arguments so the program gets them back unchanged', () => {
    expect(winQuote('login')).toBe('login')
    expect(winQuote('C:\\Users\\a b\\c.json')).toBe('"C:\\Users\\a b\\c.json"')
    expect(winQuote('')).toBe('""')
    expect(winQuote('say "hi"')).toBe('"say \\"hi\\""')
    expect(winQuote('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"')
  })
})
