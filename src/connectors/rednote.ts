// Rednote (Xiaohongshu) via browser automation of creator.xiaohongshu.com, in a persistent visible
// browser profile per account. No posting API exists for creators.
//
// Rednote's 2026-08 rules penalise accounts run automatically by scripts or AI tools, so the default
// is HANDOFF: OneDraft fills in the note and leaves the window open; you press Publish yourself.
// Selectors live in SELECTORS and can be overridden from Settings (JSON) when the site changes,
// and every failure saves a screenshot + page HTML for repair.

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserContext, Locator, Page } from 'playwright-core'
import { NeedsLoginError, UnconfirmedError, VerificationRequiredError, type Connector, type ConnectorContext } from '../core/connector'
import type { Account } from '../shared/types'
import { isVideo } from './util'

const CREATOR = 'https://creator.xiaohongshu.com'

/** Selector lists: each entry is tried in order. Override any key via Settings → Rednote → selectors. */
export const SELECTORS = {
  loginBox: ["div[class*='login-box']", '.login-box-container'],
  tabVideo: ["div.creator-tab:has-text('上传视频')"],
  tabImage: ["div.creator-tab:has-text('上传图文')"],
  videoInput: ["div[class^='upload-content'] input[class='upload-input']", "input[type='file'][accept*='video']", "input[type='file']"],
  imageInput: ["input[type='file'][accept*='image']", "input[type='file']"],
  videoDone: ["div.preview-new:has-text('重新上传')", "div.preview-new:has-text('上传成功')", "text=上传成功"],
  imageDone: ['.img-preview-area .pr', '.img-preview-area img'],
  title: ["input[placeholder*='填写标题']", 'div.d-input input'],
  body: ["div.ql-editor[contenteditable='true']", "p[data-placeholder*='输入正文描述']", "[contenteditable='true']"],
  topicSuggestion: ['#creator-editor-topic-container .item', '.publish-topic-item'],
  declareMenu: ["text=添加内容类型声明", "text=内容类型声明"],
  declareAi: ["text=笔记含AI合成内容", "text=AI合成"],
  scheduleSwitch: [".custom-switch-card:has-text('定时发布') .d-switch"],
  scheduleInput: ['.d-datepicker-input-filter input.d-text', "input[placeholder*='选择日期']"],
  visibilityMenu: ["text=公开可见"],
  privateOption: ["text=仅自己可见"],
  publishButton: ["button:has-text('定时发布')", "button:has-text('发布')", '.publish-page-publish-btn button.bg-red'],
  verifyPrompt: ["text=实名认证", "text=身份验证", "text=验证码"]
} as const

type SelectorKey = keyof typeof SELECTORS

function selectors(ctx: ConnectorContext, key: SelectorKey): string[] {
  try {
    const custom = JSON.parse(ctx.setting('selectors') || '{}') as Partial<Record<SelectorKey, string[]>>
    return custom[key] ?? [...SELECTORS[key]]
  } catch {
    return [...SELECTORS[key]]
  }
}

/** First selector that matches a visible element within the timeout. */
async function find(page: Page, ctx: ConnectorContext, key: SelectorKey, timeoutMs = 15_000, visible = true): Promise<Locator> {
  const list = selectors(ctx, key)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const s of list) {
      const loc = page.locator(s).first()
      if ((await loc.count()) > 0 && (!visible || (await loc.isVisible().catch(() => false)))) return loc
    }
    await page.waitForTimeout(400)
  }
  throw new Error(`Could not find "${key}" on the page (tried ${list.join(' | ')}). The site may have changed.`)
}

async function maybe(page: Page, ctx: ConnectorContext, key: SelectorKey, timeoutMs = 2500): Promise<Locator | undefined> {
  return find(page, ctx, key, timeoutMs).catch(() => undefined)
}

async function snapshot(page: Page | undefined, ctx: ConnectorContext, label: string): Promise<string | undefined> {
  if (!page) return undefined
  try {
    const dir = join(ctx.paths.data, 'diagnostics')
    mkdirSync(dir, { recursive: true })
    const stem = join(dir, `rednote-${label}-${Date.now()}`)
    await page.screenshot({ path: `${stem}.png`, fullPage: true })
    writeFileSync(`${stem}.html`, await page.content())
    return `${stem}.png`
  } catch {
    return undefined
  }
}

async function isLoggedIn(page: Page, ctx: ConnectorContext): Promise<boolean> {
  if (page.url().includes('/login')) return false
  return !(await maybe(page, ctx, 'loginBox', 800))
}

const profileKey = (account: Account) => account.meta.profileKey as string

/** Rednote counts ASCII as half a character in titles. */
export function rednoteTitleLength(s: string): number {
  let n = 0
  for (const ch of s) n += (ch.codePointAt(0) ?? 0) < 128 ? 0.5 : 1
  return Math.ceil(n)
}

function formatCnTime(iso: string): string {
  // Rednote's picker wants Beijing time, "YYYY-MM-DD HH:mm".
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

export const rednote: Connector = {
  manifest: {
    id: 'rednote',
    name: 'Rednote',
    kind: 'browser',
    color: '#ff2442',
    source: 'builtin',
    docsUrl: 'https://creator.xiaohongshu.com',
    capabilities: {
      video: true,
      image: true,
      text: false,
      nativeSchedule: true,
      scheduleWindow: { minSec: 3600, maxSec: 14 * 86400 },
      comments: false,
      reply: false,
      stats: false
    },
    constraints: {
      title: { max: 20, unit: 'halfAscii' },
      caption: { max: 1000 },
      tags: { style: 'field', max: 10 },
      video: { preferredAspect: '9:16', formats: ['mp4', 'mov'] },
      image: { maxCount: 18, preferredAspect: '3:4', formats: ['jpg', 'jpeg', 'png', 'webp'] },
      media: { required: true, mixed: false, maxVideos: 1 }
    },
    settings: [
      {
        key: 'browserChannel',
        label: 'Browser for website accounts',
        help: 'Used for Rednote and for every account connected by signing in on the website (YouTube, TikTok, Instagram, X).',
        type: 'select',
        default: 'msedge',
        options: [
          { value: 'msedge', label: 'Microsoft Edge' },
          { value: 'chrome', label: 'Google Chrome' }
        ]
      },
      { key: 'selectors', label: 'Selector overrides (JSON)', type: 'textarea', help: 'Only if the site changed: {"title": ["new selector"]}. Keys are listed in the connector source.' }
    ],
    connectFields: [{ key: 'label', label: 'Name for this account', type: 'text', placeholder: 'e.g. My Rednote' }],
    options: [
      {
        key: 'publishMode',
        label: 'Publishing',
        type: 'select',
        default: 'handoff',
        options: [
          { value: 'handoff', label: 'Fill it in, I press Publish (recommended)' },
          { value: 'auto', label: 'Press Publish for me' }
        ],
        help: 'Rednote penalises accounts run by scripts; keeping a person on the button is safer.'
      },
      {
        key: 'visibility',
        label: 'Visibility',
        type: 'select',
        default: 'public',
        options: [
          { value: 'public', label: 'Public' },
          { value: 'private', label: 'Only me' }
        ]
      }
    ],
    signIn:
      'A browser window opens on Rednote’s creator site (creator.xiaohongshu.com). Sign in there: scan the QR code with the Rednote (小红书) app, or use your phone number. The window closes by itself when you are in; OneDraft keeps that login in its own browser profile.',
    notes: [
      'One web session per account: logging in on another computer’s browser signs OneDraft out.',
      'OneDraft sets Rednote’s AI-content declaration when the post is marked AI-generated.',
      'Rednote allows roughly 50 posts a day; titles are 20 characters (English letters count half).'
    ]
  },

  async connect(ctx, input) {
    const fresh = !input._profileKey
    const key = input._profileKey || `rednote-${randomUUID()}`
    const canceled = () => new Error('Sign-in canceled.')
    const closedEarly = () => new Error('The sign-in window was closed before you finished signing in. Press Connect to try again.')
    let browser: BrowserContext | undefined
    let page: Page | undefined
    // Cancel closes the page, which also ends one that is still loading.
    const onAbort = () => void page?.close().catch(() => undefined)
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      browser = await ctx.browser(key, { headless: false, locale: 'zh-CN' })
      page = browser.pages()[0] ?? (await browser.newPage())
      if (ctx.signal?.aborted) throw canceled()
      await page.goto(`${CREATOR}/login`, { waitUntil: 'domcontentloaded' })
      ctx.log('Scan the QR code in the browser window with the Rednote app (switch to QR-code login if needed).')
      const deadline = Date.now() + 5 * 60_000
      let signedIn = false
      while (!signedIn && Date.now() < deadline) {
        if (ctx.signal?.aborted) throw canceled()
        if (page.isClosed()) throw closedEarly()
        await new Promise((r) => setTimeout(r, 2000))
        // Signed in = on Rednote's creator site, past its login page, with no login box showing (an error page or
        // any other site doesn't count).
        signedIn = !page.isClosed() && page.url().startsWith(`${CREATOR}/`) && !page.url().includes('/login') && (await isLoggedIn(page, ctx).catch(() => false))
      }
      if (!signedIn) throw new Error('Not signed in after 5 minutes. Press Connect to try again.')
      const cookies = await browser.cookies(CREATOR)
      const uid = cookies.find((c) => /user.?id/i.test(c.name))?.value
      return {
        name: input.label?.trim() || 'Rednote account',
        remoteUserId: uid ?? key,
        meta: { profileKey: key }
      }
    } catch (e) {
      const m = String((e as Error)?.message ?? e)
      const reason = ctx.signal?.aborted
        ? canceled()
        : page?.isClosed() || /has been closed|frame was detached/i.test(m)
          ? closedEarly()
          : /net::ERR_/.test(m)
            ? new Error(`Couldn’t open Rednote (${/net::ERR_\w+/.exec(m)?.[0]}). Check the internet connection and press Connect again.`)
            : (e as Error)
      // A new profile that never got signed in is just clutter (and may hold half a sign-in).
      if (fresh) {
        await browser?.close().catch(() => undefined)
        await ctx.forgetBrowser?.(key).catch(() => undefined)
      }
      throw reason
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort)
      await browser?.close().catch(() => undefined)
    }
  },

  async check(ctx, account) {
    const browser = await ctx.browser(profileKey(account), { headless: true, locale: 'zh-CN' })
    try {
      const page = await browser.newPage()
      await page.goto(`${CREATOR}/publish/publish?from=homepage&target=video`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(3000)
      if (!(await isLoggedIn(page, ctx))) throw new NeedsLoginError('Rednote login expired.')
      return { ok: true }
    } finally {
      await browser.close().catch(() => undefined)
    }
  },

  async publish(ctx, account, { content, publishAt }) {
    const video = content.media.find(isVideo)
    const images = content.media.filter((m) => !isVideo(m))
    const handoff = content.options.publishMode !== 'auto'
    let browser: BrowserContext | undefined
    let page: Page | undefined
    try {
      browser = await ctx.browser(profileKey(account), { headless: false, locale: 'zh-CN' })
      // A fresh tab each time: an earlier handoff may still be open with a note waiting for the person.
      page = browser.pages().find((p) => p.url() === 'about:blank') ?? (await browser.newPage())
      await page.goto(`${CREATOR}/publish/publish?from=homepage&target=${video ? 'video' : 'image'}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2500)
      if (!(await isLoggedIn(page, ctx))) throw new NeedsLoginError('Rednote login expired; reconnect the account.')
      if (await maybe(page, ctx, 'verifyPrompt', 1000)) throw new VerificationRequiredError('Rednote is asking for verification; finish it in the browser window.')

      // 1. media
      const tab = await maybe(page, ctx, video ? 'tabVideo' : 'tabImage', 3000)
      await tab?.click()
      let uploaded: Promise<unknown> | undefined
      if (video) {
        await (await find(page, ctx, 'videoInput', 15_000, false)).setInputFiles(video)
        ctx.progress(0.2, 'Uploading video to Rednote')
        // The form appears while the video is still uploading: fill it in meanwhile, publish only once it's done.
        uploaded = find(page, ctx, 'videoDone', 20 * 60_000)
        uploaded.catch(() => undefined)
        await Promise.race([uploaded, find(page, ctx, 'title', 20 * 60_000)])
      } else {
        await (await find(page, ctx, 'imageInput', 15_000, false)).setInputFiles(images)
        ctx.progress(0.2, 'Uploading images to Rednote')
        await find(page, ctx, 'title', 3 * 60_000)
      }
      ctx.progress(0.6, 'Filling in the note')

      // 2. title + body + topics
      await (await find(page, ctx, 'title')).fill(content.title)
      const editor = await find(page, ctx, 'body')
      await editor.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Delete')
      await page.keyboard.insertText(content.caption)
      for (const tag of content.tags.slice(0, 10)) {
        await page.keyboard.type(` #${tag.replace(/^#/, '')}`, { delay: 40 })
        const s = await maybe(page, ctx, 'topicSuggestion', 3000)
        if (s) await s.click()
        else await page.keyboard.type(' ')
      }

      // 3. AI declaration (required by Chinese rules for AI content)
      let declared = !content.aiGenerated
      if (content.aiGenerated) {
        const menu = await maybe(page, ctx, 'declareMenu', 4000)
        if (menu) {
          await menu.click()
          const ai = await maybe(page, ctx, 'declareAi', 4000)
          if (ai) {
            await ai.click()
            declared = true
          }
        }
      }

      // 4. visibility + schedule
      if (content.options.visibility === 'private') {
        const v = await maybe(page, ctx, 'visibilityMenu', 3000)
        if (v) {
          await v.click()
          await (await maybe(page, ctx, 'privateOption', 3000))?.click()
        }
      }
      if (publishAt) {
        await (await find(page, ctx, 'scheduleSwitch', 8000)).click()
        const input = await find(page, ctx, 'scheduleInput', 8000)
        await input.click()
        await page.keyboard.press('Control+A')
        await page.keyboard.type(formatCnTime(publishAt))
        await page.keyboard.press('Enter')
      }

      if (handoff || !declared) {
        // Leave the window open for the person to check and press Publish.
        await page.bringToFront()
        const reason = !declared ? 'Could not find the AI-content declaration; set it in the note’s content-type declaration, then press Publish.' : 'Check the note and press Publish in the browser window.'
        ctx.log(reason)
        browser = undefined // keep it open
        return { state: 'handoff', note: reason }
      }

      // 5. publish and confirm
      if (uploaded) {
        ctx.progress(0.8, 'Waiting for Rednote to finish the upload')
        await uploaded
      }
      await (await find(page, ctx, 'publishButton')).click()
      try {
        await page.waitForURL(/publish\/success|\/new\/note-manager/, { timeout: 60_000 })
      } catch {
        const shot = await snapshot(page, ctx, 'after-publish')
        throw new UnconfirmedError(`Pressed Publish but Rednote did not confirm.${shot ? ` Screenshot: ${shot}` : ''} Check your notes before retrying.`)
      }
      return { state: publishAt ? 'scheduled' : 'published', note: 'Rednote does not show the note link right away; find it in the note manager.' }
    } catch (e) {
      if (e instanceof UnconfirmedError) throw e
      if (e instanceof NeedsLoginError || e instanceof VerificationRequiredError) {
        browser = undefined // leave the window for the person
        throw e
      }
      const shot = await snapshot(page, ctx, 'error')
      throw new Error(`${(e as Error).message}${shot ? ` (screenshot: ${shot})` : ''}`)
    } finally {
      await browser?.close().catch(() => undefined)
    }
  },

  /** Disconnecting signs out: the browser profile (its cookies are the sign-in) is deleted. */
  async disconnect(ctx, account) {
    await ctx.forgetBrowser?.(profileKey(account))
  }
}
