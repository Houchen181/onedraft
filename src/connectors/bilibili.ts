// Bilibili via the biliup CLI (MIT, github.com/biliup/biliup). The official open platform is
// enterprise-only, so for personal accounts we drive biliup: it handles UPOS chunked upload, line
// probing, token refresh and the submit call. One cookie file per account.
//
// Signing in is done here, not by `biliup login`: that one is an interactive menu that needs a real terminal (it
// fails with "not a terminal" when started from an app). OneDraft runs the same QR-code login biliup uses (Bilibili's
// TV login with biliup's app key), shows the code in its Connect window, and saves the result as biliup's cookie file.
//
// Bilibili keeps some accounts out of that TV login (48007 当前账号暂不支持在本APP登录: accounts without a mainland
// China phone number, for one), and biliup also submits through the TV app, so those accounts can't post with biliup
// at all. They sign in on Bilibili's website instead (web.ts): OneDraft fills in the creator centre's upload page and
// the person presses 立即投稿.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  ContentError,
  NeedsLoginError,
  RetryableError,
  UnconfirmedError,
  type Connector,
  type ConnectorContext
} from '../core/connector'
import { getJson, sleep } from '../core/http'
import type { Account } from '../shared/types'
import { isWeb, WEB_FIELDS, WEB_SELECTOR_SETTING, webCheck, webConnect, webDisconnect, webPublish } from './web'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

interface CookieFile {
  cookie_info?: { cookies?: { name: string; value: string }[] }
  token_info?: { mid?: number; access_token?: string }
}

/** biliup's Bilibili TV app key (crates/biliup/src/uploader/credential.rs): its QR login and its token renewal use it. */
const TV = { appkey: '4409e2ce8ffd12b8', appsec: '59b43e04ad6965f34319062b478f83dd' }

/** Bilibili's app signature, as biliup computes it: parameters sorted by name, then md5(query + appsec). */
export function signTv(params: Record<string, string>): string {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')
  return `${query}&sign=${createHash('md5').update(query + TV.appsec).digest('hex')}`
}

/** biliup's cookie file (its LoginInfo struct). */
export interface BiliupLogin {
  cookie_info: unknown
  sso: string[]
  token_info: { access_token: string; expires_in: number; mid: number; refresh_token: string }
  platform: string
}

/** Bilibili's TV QR-code login, the way `biliup login` does it: the code is shown in OneDraft's Connect window. */
export async function qrLogin(ctx: ConnectorContext, stop?: AbortSignal): Promise<BiliupLogin> {
  const canceled = () => new Error('Sign-in canceled.')
  // Ends with Cancel, or when `stop` says there's no point going on (connect's biliup download failed).
  const signal = stop && ctx.signal ? AbortSignal.any([ctx.signal, stop]) : (stop ?? ctx.signal)
  const post = async <T>(url: string, params: Record<string, string>) => {
    let res: Response
    try {
      res = await ctx.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: signTv(params),
        // A request that never answers counts as a dropped one.
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
      })
    } catch (e) {
      if (signal?.aborted) throw canceled()
      throw new RetryableError(`Couldn’t reach Bilibili (${(e as Error).message}). Check the internet connection and press Connect again.`)
    }
    if (!res.ok) throw new RetryableError(`Bilibili login answered ${res.status}. Try again in a minute.`)
    const text = await res.text().catch(() => '')
    try {
      return JSON.parse(text) as { code: number; message?: string; data?: T }
    } catch {
      throw new RetryableError('Bilibili’s login sent back something else than its answer (a network sign-in page, maybe). Try again in a minute.')
    }
  }
  for (let round = 0; round < 4; round++) {
    const ts = String(Math.floor(Date.now() / 1000))
    const made = await post<{ url: string; auth_code: string }>('https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code', {
      appkey: TV.appkey,
      local_id: '0',
      ts
    })
    if (made.code !== 0 || !made.data?.url || !made.data.auth_code) throw new Error(`Bilibili wouldn’t make a login QR code (${made.code} ${made.message ?? ''}). Try again in a minute.`)
    // biliup encodes the link with http (it is what the Bilibili app expects from a TV login code).
    ctx.showQr?.(
      made.data.url.replaceAll('https', 'http'),
      round ? 'That code expired. Scan this new one.' : 'Open the Bilibili app, tap 扫一扫 (scan), scan this code and confirm on your phone.'
    )
    const poll = { appkey: TV.appkey, auth_code: made.data.auth_code, local_id: '0', ts }
    let misses = 0
    // Bilibili keeps answering "not scanned yet" long after a code should have expired: a fresh one after 3 minutes.
    const until = Date.now() + 180_000
    for (;;) {
      await sleep(1500, signal).catch(() => {
        throw canceled()
      })
      if (Date.now() > until) break
      let r: { code: number; message?: string; data?: Partial<BiliupLogin> }
      try {
        r = await post<Partial<BiliupLogin>>('https://passport.bilibili.com/x/passport-tv-login/qrcode/poll', poll)
        misses = 0
      } catch (e) {
        // A connection that drops while the person scans: the code stays up and OneDraft asks again (for ~30 s).
        if (e instanceof RetryableError && ++misses < 20) continue
        throw e
      }
      if (r.code === 0) {
        const t = r.data?.token_info
        if (!t?.access_token || !r.data?.cookie_info) throw new Error('Bilibili confirmed the sign-in but sent back an incomplete login. Press Connect to try again.')
        return {
          cookie_info: r.data.cookie_info,
          sso: r.data.sso ?? [],
          token_info: { access_token: t.access_token, expires_in: t.expires_in, mid: t.mid, refresh_token: t.refresh_token },
          platform: 'BiliTV'
        }
      }
      if (r.code === 86039 || r.code === 86090) continue // not scanned, or scanned but not confirmed yet
      if (r.code === 86038) break // expired: make a new one
      // Bilibili keeps this account out of the TV-app login, here and in Bilibili's own TV app.
      if (r.code === 48007)
        throw new Error(
          `Bilibili doesn’t let this account sign in with this QR code (48007 ${r.message ?? ''}). It does that to some accounts, such as ones without a mainland China phone number. Choose “Sign in with your browser” above instead: it signs in on Bilibili’s website, which these accounts can use.`
        )
      throw new Error(`Bilibili didn’t accept the login (${r.code} ${r.message ?? ''}). Press Connect to try again.`)
    }
  }
  throw new Error('The QR code expired a few times. Press Connect again when you’re ready to scan it.')
}

function findExe(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      const inner = findExe(p)
      if (inner) return inner
    } else if (/^biliup(\.exe)?$/i.test(name)) return p
  }
  return undefined
}

function biliupPath(ctx: ConnectorContext): string | undefined {
  const configured = ctx.setting('biliupPath')?.trim()
  if (configured) return existsSync(configured) ? configured : undefined
  const dir = join(ctx.paths.tools, 'biliup')
  return existsSync(join(dir, 'version.txt')) ? findExe(dir) : undefined
}

/** A biliup path set under Options that isn't there (any more). */
function missingConfigured(ctx: ConnectorContext): string | undefined {
  const configured = ctx.setting('biliupPath')?.trim()
  return configured && !existsSync(configured) ? configured : undefined
}

const notInstalled = (ctx: ConnectorContext) => {
  const missing = missingConfigured(ctx)
  return missing
    ? `The biliup path set under Options doesn’t exist: ${missing}. Fix it, or clear it so OneDraft downloads biliup.`
    : 'biliup is not installed; reconnect the account to install it.'
}

/** One download at a time: a second Connect waits for the first one's instead of unpacking over it. */
let installQueue: Promise<unknown> = Promise.resolve()
function installBiliup(ctx: ConnectorContext, signal?: AbortSignal): Promise<string> {
  const run = installQueue.catch(() => undefined).then(() => biliupPath(ctx) ?? downloadBiliup(ctx, signal))
  installQueue = run
  return run
}

/** Download the latest biliup release for Windows from GitHub into the tools folder. */
async function downloadBiliup(ctx: ConnectorContext, signal?: AbortSignal): Promise<string> {
  ctx.log('Downloading biliup from github.com/biliup/biliup …')
  const rel = await getJson<{ tag_name: string; assets: { name: string; browser_download_url: string }[] }>(
    ctx.fetch,
    'https://api.github.com/repos/biliup/biliup/releases/latest',
    { headers: { accept: 'application/vnd.github+json', 'user-agent': 'onedraft' }, signal },
    'Find biliup release'
  )
  const asset = rel.assets.find((a) => /biliupR-.*x86_64-windows\.zip$/i.test(a.name))
  if (!asset) throw new Error(`No Windows build in biliup ${rel.tag_name}. Download it by hand and set its path in Settings.`)
  const dir = join(ctx.paths.tools, 'biliup')
  // Unpacked beside it and moved into place only once complete: an interrupted unpack never looks installed.
  const part = join(ctx.paths.tools, `biliup-part-${randomUUID()}`)
  mkdirSync(part, { recursive: true })
  try {
    const zip = join(part, asset.name)
    const res = await ctx.fetch(asset.browser_download_url, { headers: { 'user-agent': 'onedraft' }, signal })
    if (!res.ok) throw new Error(`Download failed (${res.status})`)
    writeFileSync(zip, new Uint8Array(await res.arrayBuffer()))
    const x = await ctx.exec('tar', ['-xf', zip, '-C', part])
    if (x.code !== 0) throw new Error(`Could not unpack biliup: ${x.stderr}`)
    rmSync(zip, { force: true })
    if (!findExe(part)) throw new Error('biliup.exe not found after unpacking.')
    writeFileSync(join(part, 'version.txt'), rel.tag_name)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      throw new Error('The old biliup couldn’t be replaced (an upload may be running). Try again when it’s done.')
    }
    renameSync(part, dir)
  } finally {
    rmSync(part, { recursive: true, force: true })
  }
  const exe = findExe(dir)
  if (!exe) throw new Error('biliup.exe not found after unpacking.')
  ctx.log(`Installed biliup ${rel.tag_name}`)
  return exe
}

const readLogin = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as CookieFile

function cookieHeaderOf(j: CookieFile): { header: string; mid?: number } {
  const cookies = j.cookie_info?.cookies ?? []
  return { header: cookies.map((c) => `${c.name}=${c.value}`).join('; '), mid: j.token_info?.mid }
}

async function whoAmI(ctx: ConnectorContext, login: CookieFile) {
  const { header, mid } = cookieHeaderOf(login)
  const r = await getJson<{ code: number; data?: { isLogin: boolean; uname?: string; face?: string; mid?: number } }>(
    ctx.fetch,
    'https://api.bilibili.com/x/web-interface/nav',
    { headers: { cookie: header, 'user-agent': UA, referer: 'https://www.bilibili.com/' } },
    'Bilibili account info'
  )
  if (!r.data?.isLogin) throw new NeedsLoginError('Bilibili says this login is not valid.')
  return { name: r.data.uname ?? `UID ${mid}`, face: r.data.face, mid: String(r.data.mid ?? mid) }
}

const cookiePath = (account: Account) => account.meta.cookieFile as string

/** Is `file` inside `folder` (not merely a path that starts with the same letters)? */
function insideFolder(folder: string | undefined, file: string): boolean {
  if (!folder) return false
  const rel = relative(resolve(folder), resolve(file))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

export const bilibili: Connector = {
  manifest: {
    id: 'bilibili',
    name: 'Bilibili',
    kind: 'cli',
    color: '#00a1d6',
    source: 'builtin',
    docsUrl: 'https://github.com/biliup/biliup',
    capabilities: {
      video: true,
      image: false,
      text: false,
      nativeSchedule: true,
      scheduleWindow: { minSec: 4 * 3600, maxSec: 15 * 86400 },
      comments: false,
      reply: false,
      stats: true
    },
    constraints: {
      title: { required: true, max: 80 },
      caption: { max: 2000 },
      tags: { style: 'field', required: true, max: 12, maxEach: 20 },
      video: { maxBytes: 4e9, preferredAspect: '16:9' },
      media: { required: true, maxVideos: 1 }
    },
    settings: [
      { key: 'biliupPath', label: 'biliup.exe path', type: 'path', help: 'Leave empty to use the copy OneDraft downloads when you connect.' },
      WEB_SELECTOR_SETTING
    ],
    connectFields: [
      {
        key: 'install',
        label: 'Download biliup (MIT, github.com/biliup/biliup) if it is missing',
        type: 'boolean',
        default: true
      }
    ],
    options: [
      { key: 'tid', label: 'Category id (tid)', type: 'text', default: '21', required: true, help: 'e.g. 21 Daily life, 201 Science, 231 Computer tech, 95 Digital, 138 Comedy.' },
      {
        key: 'copyright',
        label: 'Type',
        type: 'select',
        default: '1',
        options: [
          { value: '1', label: 'Original' },
          { value: '2', label: 'Repost' }
        ]
      },
      { key: 'source', label: 'Source (for reposts)', type: 'text' },
      { key: 'dynamic', label: 'Feed update text (shown in followers’ feeds)', type: 'text' },
      {
        key: 'line',
        label: 'Upload line',
        type: 'select',
        default: 'auto',
        options: ['auto', 'bda2', 'qn', 'tx', 'txa', 'alia', 'bldsa'].map((v) => ({ value: v, label: v }))
      }
    ],
    signIn:
      'A QR code appears right here. Open the Bilibili app, tap 扫一扫 (scan), scan the code and confirm on your phone. The first time, OneDraft also downloads biliup, the free uploader it uses for Bilibili (about 10 MB).',
    notes: [
      'Bilibili’s AI-content declaration can’t be set by uploaders: turn it on in the creator centre after posting AI content.',
      'Scheduled posts must be 4 hours to 15 days ahead to be held by Bilibili; otherwise OneDraft posts at the time.'
    ],
    web: {
      signIn:
        'A browser window opens on Bilibili’s sign-in page. Scan its QR code with the Bilibili app, or sign in another way; the window closes by itself once you’re in, and OneDraft keeps that sign-in for this account.',
      fields: WEB_FIELDS,
      notes: [
        'For accounts Bilibili won’t let sign in with the QR code (error 48007).',
        'When you post, OneDraft opens Bilibili’s upload page in that window, adds your video, title, description and tags, and you press 立即投稿 (Submit). You choose the category there.',
        'View counts in OneDraft need the QR-code way.'
      ],
      // Reminded of in the note: the person sets them on the page.
      options: ['copyright', 'source', 'dynamic'],
      constraints: { tags: { style: 'field', required: true, max: 10, maxEach: 20 } },
      press: '立即投稿 (Submit)',
      other: {
        label: 'Scan a QR code',
        pill: 'posts by itself',
        text: 'Scan a code with the Bilibili app right here. OneDraft then uploads and posts by itself, with biliup. Some accounts can’t sign in this way (error 48007).',
        first: true
      }
    }
  },

  validate(content, account) {
    const issues = []
    if (content.aiGenerated)
      issues.push({
        level: 'warning' as const,
        field: 'aiGenerated',
        message:
          account && isWeb(account)
            ? 'Turn on the AI-content declaration on Bilibili’s upload page before you press 立即投稿 (required for AI content).'
            : 'After it uploads, turn on the AI-content declaration in Bilibili’s creator centre (required for AI content; biliup cannot set it).'
      })
    if (content.options.copyright === '2' && !String(content.options.source ?? '').trim())
      issues.push({ level: 'error' as const, field: 'options.source', message: 'Reposts need a source.' })
    return issues
  },

  async connect(ctx, input) {
    // Signed in on the website, the account posts through Bilibili's own page: no biliup.
    if (input.method === 'web' || (!input.method && input._profileKey)) return webConnect('bilibili', ctx, input)
    // biliup does the uploads: fetch it while the person scans the code.
    if (missingConfigured(ctx)) throw new Error(notInstalled(ctx))
    if (!biliupPath(ctx) && input.install === 'false') throw new Error('biliup isn’t installed. Set its path under Options, or allow the download.')
    // The download ends with the sign-in when that is canceled or fails.
    const stop = new AbortController()
    const onAbort = () => stop.abort()
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    const installing = biliupPath(ctx) ? Promise.resolve() : installBiliup(ctx, stop.signal).then(() => undefined)
    // A download that fails ends the sign-in right away: scanning would be for nothing.
    const downloadFailed = new AbortController()
    installing.catch(() => downloadFailed.abort())
    const failedDownload = (e: Error) =>
      new Error(`Couldn’t download biliup, which uploads your videos to Bilibili: ${e.message}. Check the internet connection and press Connect again.`)
    try {
      let login: BiliupLogin
      try {
        login = await qrLogin(ctx, downloadFailed.signal)
      } catch (e) {
        if (downloadFailed.signal.aborted && !ctx.signal?.aborted) await installing.catch((d: Error) => Promise.reject(failedDownload(d)))
        throw e
      }
      ctx.connectStatus?.('Signed in on your phone. Finishing setup…')
      const me = await whoAmI(ctx, login as CookieFile)
      if (!biliupPath(ctx)) ctx.connectStatus?.('Signed in. Downloading biliup, which uploads your videos to Bilibili…')
      await installing.catch((e: Error) => Promise.reject(failedDownload(e)))
      // The login (its tokens) is saved only once the account is really added.
      const dir = join(ctx.paths.data, 'bilibili')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${randomUUID()}.json`)
      writeFileSync(file, `${JSON.stringify(login, null, 2)}\n`)
      return { name: me.name, avatarUrl: me.face, remoteUserId: me.mid, meta: { cookieFile: file, mid: me.mid } }
    } catch (e) {
      stop.abort()
      throw e
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort)
    }
  },

  async disconnect(ctx, account) {
    if (isWeb(account)) return webDisconnect(ctx, account)
    // The saved login holds the account's tokens (only ever a file inside OneDraft's own folder).
    const file = cookiePath(account)
    if (file && insideFolder(ctx.paths.data, file)) rmSync(file, { force: true })
  },

  async check(ctx, account) {
    if (isWeb(account)) return webCheck('bilibili', ctx, account)
    const exe = biliupPath(ctx)
    if (!exe) return { ok: false, note: notInstalled(ctx) }
    if (!cookiePath(account) || !existsSync(cookiePath(account))) throw new NeedsLoginError('The saved Bilibili login is missing. Press Connect to sign in again.')
    const r = await ctx.exec(exe, ['-u', cookiePath(account), 'renew'], { timeoutMs: 60_000 })
    if (r.code !== 0) throw new NeedsLoginError(`biliup could not refresh the login: ${(r.stderr || r.stdout).trim().slice(-300)}`)
    const me = await whoAmI(ctx, readLogin(cookiePath(account)))
    return { ok: true, name: me.name }
  },

  async publish(ctx, account, req) {
    if (isWeb(account)) return webPublish('bilibili', ctx, account, req)
    const { content, publishAt } = req
    const exe = biliupPath(ctx)
    if (!exe) throw new Error(notInstalled(ctx))
    const o = content.options
    // --opt=value so text starting with "-" (a bulleted description) is not read as another option.
    const args = ['-u', cookiePath(account), 'upload', content.media[0], `--title=${content.title}`, `--desc=${content.caption}`, `--tag=${content.tags.map((t) => t.replace(/,/g, ' ')).join(',')}`, '--tid', String(o.tid ?? '21'), '--copyright', String(o.copyright ?? '1')]
    if (o.copyright === '2' && o.source) args.push(`--source=${String(o.source)}`)
    if (o.dynamic) args.push(`--dynamic=${String(o.dynamic)}`)
    if (content.cover) args.push('--cover', content.cover)
    if (o.line && o.line !== 'auto') args.push('-l', String(o.line))
    if (publishAt) args.push('--dtime', String(Math.floor(new Date(publishAt).getTime() / 1000)))

    let submitStarted = false
    let lastLines: string[] = []
    const r = await ctx.exec(exe, args, {
      timeoutMs: 6 * 3600_000,
      onLine: (line) => {
        lastLines = [...lastLines.slice(-30), line]
        const pct = /(\d{1,3}(?:\.\d+)?)%/.exec(line)
        if (pct) ctx.progress(Number(pct[1]) / 100, 'Uploading to Bilibili')
        if (/ResponseData|投稿|submit/i.test(line)) submitStarted = true
      }
    })
    const out = `${r.stdout}\n${r.stderr}`
    const bvid = /BV[0-9A-Za-z]{10}/.exec(out)?.[0]
    if (r.code === 0 || /投稿成功/.test(out)) {
      return {
        remoteId: bvid,
        url: bvid ? `https://www.bilibili.com/video/${bvid}` : undefined,
        state: publishAt ? 'scheduled' : 'published',
        note: [bvid ? undefined : 'Submitted; Bilibili is reviewing it (no BV id in the log yet).', content.aiGenerated ? 'Remember to turn on the AI-content declaration in the creator centre.' : undefined]
          .filter(Boolean)
          .join(' ') || undefined
      }
    }
    const tail = lastLines.join('\n').slice(-600)
    const code = /code:\s*(-?\d+)/.exec(out)?.[1]
    // Match Bilibili's codes, not any "601" in byte counts or timestamps: a wrong "retry" could post twice.
    if (code === '601' || /上传过快/.test(out)) throw new RetryableError('Bilibili says uploads are too frequent (601).', 1800)
    if (code === '-101' || /账号未登录|未登录/.test(out)) throw new NeedsLoginError('Bilibili login expired.')
    if (code && code !== '0') throw new ContentError(`Bilibili rejected the submission (code ${code}): ${tail}`)
    if (submitStarted) throw new UnconfirmedError(`biliup stopped while submitting; check your Bilibili uploads. ${tail}`, bvid)
    throw new Error(`biliup failed (exit ${r.code}): ${tail}`)
  },

  async stats(ctx, _account, remoteId) {
    const r = await getJson<{ data?: { stat?: Record<string, number> } }>(
      ctx.fetch,
      `https://api.bilibili.com/x/web-interface/view?bvid=${remoteId}`,
      { headers: { 'user-agent': UA } },
      'Bilibili stats'
    )
    return r.data?.stat ?? {}
  }
}
