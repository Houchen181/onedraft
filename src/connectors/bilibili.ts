// Bilibili via the biliup CLI (MIT, github.com/biliup/biliup). The official open platform is
// enterprise-only, so for personal accounts we drive biliup: it handles UPOS chunked upload, line
// probing, token refresh and the submit call. One cookie file per account.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ContentError,
  NeedsLoginError,
  RetryableError,
  UnconfirmedError,
  type Connector,
  type ConnectorContext
} from '../core/connector'
import { getJson } from '../core/http'
import type { Account } from '../shared/types'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

interface CookieFile {
  cookie_info?: { cookies?: { name: string; value: string }[] }
  token_info?: { mid?: number; access_token?: string }
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
  return findExe(join(ctx.paths.tools, 'biliup'))
}

/** Download the latest biliup release for Windows from GitHub into the tools folder. */
async function installBiliup(ctx: ConnectorContext): Promise<string> {
  ctx.log('Downloading biliup from github.com/biliup/biliup …')
  const rel = await getJson<{ tag_name: string; assets: { name: string; browser_download_url: string }[] }>(
    ctx.fetch,
    'https://api.github.com/repos/biliup/biliup/releases/latest',
    { headers: { accept: 'application/vnd.github+json', 'user-agent': 'polycast' } },
    'Find biliup release'
  )
  const asset = rel.assets.find((a) => /biliupR-.*x86_64-windows\.zip$/i.test(a.name))
  if (!asset) throw new Error(`No Windows build in biliup ${rel.tag_name}. Download it by hand and set its path in Settings.`)
  const dir = join(ctx.paths.tools, 'biliup')
  mkdirSync(dir, { recursive: true })
  const zip = join(dir, asset.name)
  const res = await ctx.fetch(asset.browser_download_url, { headers: { 'user-agent': 'polycast' } })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  writeFileSync(zip, new Uint8Array(await res.arrayBuffer()))
  const x = await ctx.exec('tar', ['-xf', zip, '-C', dir])
  if (x.code !== 0) throw new Error(`Could not unpack biliup: ${x.stderr}`)
  writeFileSync(join(dir, 'version.txt'), rel.tag_name)
  const exe = findExe(dir)
  if (!exe) throw new Error('biliup.exe not found after unpacking.')
  ctx.log(`Installed biliup ${rel.tag_name}`)
  return exe
}

function cookieHeader(file: string): { header: string; mid?: number } {
  const j = JSON.parse(readFileSync(file, 'utf8')) as CookieFile
  const cookies = j.cookie_info?.cookies ?? []
  return { header: cookies.map((c) => `${c.name}=${c.value}`).join('; '), mid: j.token_info?.mid }
}

async function whoAmI(ctx: ConnectorContext, file: string) {
  const { header, mid } = cookieHeader(file)
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
      { key: 'biliupPath', label: 'biliup.exe path', type: 'path', help: 'Leave empty to use the copy Polycast downloads when you connect.' }
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
      { key: 'tid', label: 'Category id (tid)', type: 'text', default: '21', required: true, help: 'e.g. 21 日常, 201 科学科普, 231 计算机技术, 95 数码, 138 搞笑.' },
      {
        key: 'copyright',
        label: 'Type',
        type: 'select',
        default: '1',
        options: [
          { value: '1', label: '自制 Original' },
          { value: '2', label: '转载 Repost' }
        ]
      },
      { key: 'source', label: 'Source (for reposts)', type: 'text' },
      { key: 'dynamic', label: '动态 text (shown in followers’ feed)', type: 'text' },
      {
        key: 'line',
        label: 'Upload line',
        type: 'select',
        default: 'auto',
        options: ['auto', 'bda2', 'qn', 'tx', 'txa', 'alia', 'bldsa'].map((v) => ({ value: v, label: v }))
      }
    ],
    notes: [
      'Login opens a console window from biliup: choose 扫码登录 (QR) and scan with the Bilibili app.',
      'Bilibili’s AI declaration (创作声明) is not available to uploaders: tick it in the creator centre after posting AI content.',
      'Scheduled posts must be 4 hours to 15 days ahead to be held by Bilibili; otherwise Polycast posts at the time.'
    ]
  },

  validate(content) {
    const issues = []
    if (content.aiGenerated)
      issues.push({
        level: 'warning' as const,
        field: 'aiGenerated',
        message: 'After it uploads, tick 创作声明 → AI生成 in Bilibili’s creator centre (required by Chinese rules; biliup cannot set it).'
      })
    if (content.options.copyright === '2' && !String(content.options.source ?? '').trim())
      issues.push({ level: 'error' as const, field: 'options.source', message: 'Reposts need a source.' })
    return issues
  },

  async connect(ctx, input) {
    let exe = biliupPath(ctx)
    if (!exe) {
      if (input.install === 'false') throw new Error('biliup is not installed. Set its path in Settings or allow the download.')
      exe = await installBiliup(ctx)
    }
    const dir = join(ctx.paths.data, 'bilibili')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${randomUUID()}.json`)
    ctx.log('Opening the biliup login window. Choose 扫码登录 and scan the QR code with the Bilibili app.')
    await ctx.exec(exe, ['-u', file, 'login'], { cwd: dir, newConsole: true, timeoutMs: 10 * 60_000 })
    if (!existsSync(file)) throw new Error('Login window closed before signing in.')
    const me = await whoAmI(ctx, file)
    return { name: me.name, avatarUrl: me.face, remoteUserId: me.mid, meta: { cookieFile: file, mid: me.mid } }
  },

  async check(ctx, account) {
    const exe = biliupPath(ctx)
    if (!exe) return { ok: false, note: 'biliup is not installed.' }
    if (!existsSync(cookiePath(account))) throw new NeedsLoginError('Cookie file is missing.')
    const r = await ctx.exec(exe, ['-u', cookiePath(account), 'renew'], { timeoutMs: 60_000 })
    if (r.code !== 0) throw new NeedsLoginError(`biliup could not refresh the login: ${(r.stderr || r.stdout).trim().slice(-300)}`)
    const me = await whoAmI(ctx, cookiePath(account))
    return { ok: true, name: me.name }
  },

  async publish(ctx, account, { content, publishAt }) {
    const exe = biliupPath(ctx)
    if (!exe) throw new Error('biliup is not installed; reconnect the account to install it.')
    const o = content.options
    const args = ['-u', cookiePath(account), 'upload', content.media[0], '--title', content.title, '--desc', content.caption, '--tag', content.tags.map((t) => t.replace(/,/g, ' ')).join(','), '--tid', String(o.tid ?? '21'), '--copyright', String(o.copyright ?? '1')]
    if (o.copyright === '2' && o.source) args.push('--source', String(o.source))
    if (o.dynamic) args.push('--dynamic', String(o.dynamic))
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
        note: [bvid ? undefined : 'Submitted; Bilibili is reviewing it (no BV id in the log yet).', content.aiGenerated ? 'Remember to tick 创作声明 → AI生成 in the creator centre.' : undefined]
          .filter(Boolean)
          .join(' ') || undefined
      }
    }
    const tail = lastLines.join('\n').slice(-600)
    const code = /code:\s*(-?\d+)/.exec(out)?.[1]
    if (/601|上传过快/.test(out)) throw new RetryableError('Bilibili says uploads are too frequent (601).', 1800)
    if (/-101|账号未登录|未登录/.test(out)) throw new NeedsLoginError('Bilibili login expired.')
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
