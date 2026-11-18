// Posting through a platform's own website, for people who don't want a developer app: they sign in once in a
// plain browser window (BrowserManager.signIn, which nothing automates), and each post opens the site's upload page
// in that profile with the media attached and the text filled in. The person checks it and presses Post (the window
// is theirs from then on), the same handoff the Rednote connector uses.
//
// Selectors are data (WEB_SELECTORS below, each list tried in order) and can be overridden per platform under
// Options when a site changes. Whatever OneDraft can't do on the page (a field it couldn't find, a choice the site
// doesn't let it make) goes into the note the person reads; a fill that stops part way saves a screenshot and the
// page HTML for repair, and the window stays open so the post can still be finished by hand. What the person can't
// finish there (signed out, the site down, the window closed) is an error instead, so the post says what to do.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { BrowserContext, Locator, Page } from 'playwright-core'
import { CanceledError, ContentError, NeedsLoginError, RetryableError, type ConnectorContext, type ConnectResult, type PublishRequest, type PublishResult, type WebCookie } from '../core/connector'
import { captionWithHashtags, weightedLength } from '../core/validate'
import type { Account, Constraints, FieldSpec, Issue, ResolvedContent } from '../shared/types'
import { isVideo } from './util'

export type WebPlatform = 'youtube' | 'tiktok' | 'instagram' | 'x' | 'bilibili'

/**
 * Selector lists per platform; each entry is tried in order. Text ones come in English and Simplified Chinese.
 * Checked 2026-11-17 against maintained uploaders' source (social-auto-upload, QianFan-Sync, MultiPost-Extension,
 * tiktok-uploader, opencli, youtube-uploader; see docs/platform-research-2026-11.md), not against the live sites.
 * Bilibili's follow MultiPost-Extension's video uploader (src/sync/video/bilibili.ts), on the same page.
 */
export const WEB_SELECTORS: Record<WebPlatform, Record<string, string[]>> = {
  youtube: {
    fileInput: ["input[name='Filedata']", "ytcp-uploads-file-picker input[type='file']", "input[type='file']"],
    title: ['#title-textarea #textbox', "ytcp-social-suggestions-textbox[label*='Title'] #textbox"],
    description: ['#description-textarea #textbox', "ytcp-social-suggestions-textbox[label*='Description'] #textbox"],
    notForKids: ["tp-yt-paper-radio-button[name='VIDEO_MADE_FOR_KIDS_NOT_MFK']"],
    forKids: ["tp-yt-paper-radio-button[name='VIDEO_MADE_FOR_KIDS_MFK']"],
    /** "Altered content: Yes" for AI-made videos (named like the made-for-kids radios; unverified, a miss becomes a note). */
    aiYes: ["tp-yt-paper-radio-button[name='VIDEO_HAS_ALTERED_CONTENT_YES']"],
    /** The "#hashtag" suggestions that cover the Next button. */
    suggestions: ['tp-yt-iron-dropdown'],
    next: ['#next-button'],
    /** The Visibility step's radio group (Public / Unlisted / Private are found inside it). */
    visibility: ['#privacy-radios']
  },
  tiktok: {
    fileInput: ["input[type='file'][accept='video/*']", "input[type='file'][accept*='video']", "input[type='file']"],
    ready: ["[data-e2e='caption_container']", 'div.public-DraftEditor-content'],
    caption: ['div.public-DraftEditor-content', "[data-e2e='caption_container'] [contenteditable='true']", "div[contenteditable='true'][role='combobox']"],
    /** Tours and tips that cover the page (clicked away when they show). */
    dismiss: ["button[data-action='skip']", "div.tutorial-tooltip button:has-text('Got it')", "div.tutorial-tooltip button:has-text('知道了')", "button:has-text('Not now')"]
  },
  instagram: {
    /** "Turn on notifications" and similar prompts over the home page. */
    dismiss: ["[role='dialog'] button:text-is('Not Now')", "[role='dialog'] button:text-is('以后再说')"],
    newPost: ["svg[aria-label='New post']", "svg[aria-label='新帖子']", "svg[aria-label='Create']", "svg[aria-label='创建']"],
    postOption: ["svg[aria-label='Post']", "svg[aria-label='帖子']"],
    fileInput: ["[role='dialog'] input[type='file'][accept*='video/mp4']", "[role='dialog'] input[type='file']", "input[type='file'][accept*='image']"],
    reelsOk: ["[role='dialog'] button:text-is('OK')", "[role='dialog'] button:text-is('确定')"],
    heading: ["[role='dialog'] [role='heading']"],
    next: ["[role='dialog'] div[role='button']:text-is('Next')", "[role='dialog'] div[role='button']:text-is('下一步')", "[role='dialog'] button:text-is('Next')"],
    caption: [
      "[role='dialog'] div[contenteditable='true'][role='textbox'][data-lexical-editor='true']",
      "[role='dialog'] div[contenteditable='true'][aria-label*='caption' i]",
      "[role='dialog'] div[contenteditable='true']"
    ]
  },
  x: {
    /** /compose/post opens a dialog over the Home timeline, whose own composer has the same test ids. */
    dialog: ["[role='dialog'] [data-testid='tweetTextarea_0']"],
    fileInput: ["[role='dialog'] input[data-testid='fileInput']", "input[type='file'][data-testid='fileInput']", "input[data-testid='fileInput']"],
    text: [
      "[role='dialog'] div[data-testid='tweetTextarea_0'][contenteditable='true']",
      "[role='dialog'] [data-testid='tweetTextarea_0']",
      "div[data-testid='tweetTextarea_0'][contenteditable='true']",
      "[data-testid='tweetTextarea_0']"
    ],
    attachments: ["[role='dialog'] [data-testid='attachments']", "[data-testid='attachments']"]
  },
  bilibili: {
    /** The "Upload Video" area: a click on it opens the page's file box. */
    uploadArea: ['.bcc-upload-wrapper .upload-area', 'div.upload-area'],
    /** The file box that click opens (the upload component's own, hidden), then any video box. */
    fileInput: [".bcc-upload-wrapper input[type='file']", "input[type='file'][accept*='mp4']", "input[type='file'][accept*='video']"],
    /** Appears once the upload starts, holding the file name. */
    title: ["input[maxlength='80'][type='text']", "input.input-val[type='text'][maxlength='80']", "input[placeholder*='标题']"],
    /** The close buttons of the tags Bilibili suggests by itself. */
    tagRemove: ['div.tag-pre-wrp .label-item-v2-close'],
    // The Chinese page's placeholder, then the box inside the tag area (the English page words it otherwise).
    tags: ["input[placeholder='按回车键Enter创建标签']", '.tag-input-wrp input', "input[placeholder*='回车']", "input[placeholder*='Enter']"],
    description: ["div.ql-editor[contenteditable='true']", 'div.ql-editor']
  }
}

interface Site {
  name: string
  /** Where signing in starts. */
  signInUrl: string
  /** Signed in once one of these cookies has a value on the site's domain. */
  cookies: string[]
  domain: string
  /** The platform's own id for the account, if the sign-in cookies carry it. */
  remoteId?: (cookies: WebCookie[]) => string | undefined
  uploadUrl: string
  /** Where the site sends someone whose sign-in has expired. */
  loginPage: RegExp
  /** The button that posts, as the person sees it (default “Post”). */
  press?: string
  /**
   * Whether a password box on the site's pages means it is asking to sign in (default yes: Instagram shows its sign-in
   * form at the same address). Sites that send a signed-out visitor to their sign-in page say no.
   */
  passwordBox?: boolean
}

/** The site's domain or one under it (x.com and api.x.com, not notx.com). */
const onDomain = (cookieDomain: string, domain: string) => {
  const d = cookieDomain.replace(/^\./, '').toLowerCase()
  return d === domain || d.endsWith(`.${domain}`)
}

const cookie = (cookies: WebCookie[], name: string, domain: string) => cookies.find((c) => c.name === name && c.value && onDomain(c.domain, domain))?.value

/** A cookie value that is an id: unquoted, URL-decoded, digits only after an optional prefix like "u=". */
function idFrom(raw: string | undefined, prefix = ''): string | undefined {
  if (!raw) return undefined
  let v = raw.replace(/^"|"$/g, '')
  try {
    v = decodeURIComponent(v)
  } catch {
    // not URL-encoded after all
  }
  v = v.replace(/^"|"$/g, '')
  if (prefix && v.startsWith(prefix)) v = v.slice(prefix.length)
  return /^\d+$/.test(v) ? v : undefined
}

export const SITES: Record<WebPlatform, Site> = {
  youtube: {
    name: 'YouTube',
    signInUrl: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fstudio.youtube.com%2F',
    // LOGIN_INFO goes away when Google rotates cookies; the *PAPISID ones don't (yt-dlp's check).
    cookies: ['LOGIN_INFO', '__Secure-3PAPISID', 'SAPISID', '__Secure-1PAPISID'],
    domain: 'youtube.com',
    uploadUrl: 'https://www.youtube.com/upload',
    loginPage: /^https:\/\/(accounts\.google\.com\/|www\.youtube\.com\/signin)/
  },
  tiktok: {
    name: 'TikTok',
    signInUrl: 'https://www.tiktok.com/login',
    cookies: ['sessionid', 'sessionid_ss', 'sid_tt'],
    domain: 'tiktok.com',
    remoteId: (c) => idFrom(cookie(c, 'uid_tt', 'tiktok.com')) ?? cookie(c, 'uid_tt', 'tiktok.com'),
    uploadUrl: 'https://www.tiktok.com/tiktokstudio/upload?from=webapp',
    loginPage: /^https:\/\/www\.tiktok\.com\/login/
  },
  instagram: {
    name: 'Instagram',
    signInUrl: 'https://www.instagram.com/accounts/login/',
    cookies: ['sessionid'],
    domain: 'instagram.com',
    remoteId: (c) => idFrom(cookie(c, 'ds_user_id', 'instagram.com')),
    uploadUrl: 'https://www.instagram.com/',
    // Signed out, instagram.com/ itself shows the sign-in form: the password box gives that away (loggedOut).
    loginPage: /^https:\/\/www\.instagram\.com\/accounts\/login/
  },
  x: {
    name: 'X',
    signInUrl: 'https://x.com/i/flow/login',
    cookies: ['auth_token'],
    domain: 'x.com',
    // twid is "u=<user id>", URL-encoded.
    remoteId: (c) => idFrom(cookie(c, 'twid', 'x.com'), 'u='),
    uploadUrl: 'https://x.com/compose/post',
    // The older sign-in flow and the newer onboarding one (?mode=login).
    loginPage: /^https:\/\/(x|twitter)\.com\/((i\/flow\/)?login|i\/jf\/onboarding)/
  },
  bilibili: {
    name: 'Bilibili',
    // The website's own sign-in, which takes accounts Bilibili keeps out of the TV-app login biliup uses (48007).
    signInUrl: 'https://passport.bilibili.com/login',
    cookies: ['SESSDATA'],
    domain: 'bilibili.com',
    remoteId: (c) => idFrom(cookie(c, 'DedeUserID', 'bilibili.com')),
    // The creator centre's uploader without the centre around it (what MultiPost-Extension opens too).
    uploadUrl: 'https://member.bilibili.com/platform/upload/video/frame',
    // Signed out, the creator centre sends you to passport.bilibili.com (/login, or /pc/passport/login).
    loginPage: /^https:\/\/passport\.bilibili\.com\//,
    press: '立即投稿 (Submit)',
    // That redirect (checked) says signed out; a password box seen while the creator centre loads is something else.
    passwordBox: false
  }
}

export const signedIn = (site: Site) => (cookies: WebCookie[]) => site.cookies.some((n) => !!cookie(cookies, n, site.domain))

const signedOut = (site: Site) => new NeedsLoginError(`Signed out of ${site.name}.`)

/** Under Options: replacement selectors for when a site changes and posts can't be filled in. */
export const WEB_SELECTOR_SETTING: FieldSpec = {
  key: 'webSelectors',
  label: 'Website selector overrides (JSON)',
  type: 'textarea',
  help: 'Only if the site changed and OneDraft can’t fill in posts: {"caption": ["new selector"]}. The keys are listed in src/connectors/web.ts.'
}

/** The "Sign in with your browser" fields: only a name to show for the account. */
export const WEB_FIELDS: FieldSpec[] = [{ key: 'label', label: 'Name for this account (optional)', type: 'text', placeholder: 'e.g. My account' }]

export const isWeb = (account: Account) => account.meta.method === 'web'
const profileKey = (account: Account) => account.meta.profileKey as string

/** The first n characters (code points, as the checks count them; never half an emoji). */
const cut = (s: string, n: number) => [...s].slice(0, n).join('')

/** Sign in on the website in a plain window; the account is the browser profile OneDraft keeps for it. */
export async function webConnect(platform: WebPlatform, ctx: ConnectorContext, input: Record<string, string>): Promise<ConnectResult> {
  if (!ctx.signInWindow) throw new Error('This version of OneDraft can’t open a sign-in window.')
  const site = SITES[platform]
  const reuse = /^[\w-]+$/.test(input._profileKey ?? '')
  const key = reuse ? input._profileKey : `${platform}-${randomUUID()}`
  ctx.log(`Opening ${site.name}’s sign-in page in a browser window.`)
  let cookies: WebCookie[]
  try {
    cookies = await ctx.signInWindow(key, site.signInUrl, signedIn(site))
  } catch (e) {
    // A new profile that never got signed in is just clutter (and may hold half a sign-in): delete it.
    if (!reuse) await ctx.forgetBrowser?.(key).catch(() => undefined)
    throw e
  }
  return {
    name: cut(input.label?.trim() ?? '', 80) || `${site.name} account`,
    remoteUserId: site.remoteId?.(cookies) ?? key,
    meta: { method: 'web', profileKey: key }
  }
}

/** Disconnecting signs out: the browser profile (and with it the sign-in) is deleted. */
export async function webDisconnect(ctx: ConnectorContext, account: Account) {
  await ctx.forgetBrowser?.(profileKey(account))
}

/**
 * Still signed in? Reads the profile's cookies without opening any page. (A sign-in the site revoked still looks
 * fine here; posting notices it on the page and asks to sign in again.)
 */
export async function webCheck(platform: WebPlatform, ctx: ConnectorContext, account: Account) {
  const site = SITES[platform]
  const browser = await ctx.browser(profileKey(account), { headless: true })
  try {
    if (!signedIn(site)(await browser.cookies())) throw signedOut(site)
    return { ok: true, name: account.name }
  } finally {
    await browser.close().catch(() => undefined)
  }
}

/** What a website account can't post (the official API ways can), for the editor's checks. */
export function webIssues(platform: WebPlatform, content: ResolvedContent): Issue[] {
  const out: Issue[] = []
  if (platform === 'instagram' && content.options.format === 'story')
    out.push({ level: 'error', field: 'options.format', message: 'Instagram’s website can’t post Stories. Choose “Feed post / Reel”, or connect Instagram with the Official API.' })
  // (Ten photos alone are the image limit's job; this is for photos and videos together.)
  if (platform === 'instagram' && content.media.length > 10 && content.media.some(isVideo))
    out.push({ level: 'warning', field: 'media', message: `Instagram’s website takes 10 photos or videos per post; OneDraft adds the first 10 of ${content.media.length}.` })
  return out
}

// ---------------------------------------------------------------- page helpers

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A page call that can't wait forever: a page whose script is busy never answers. */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error('the page stopped responding')), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(t))
}

/** The first line of an error, without the browser's color codes and call log: for notes people read. */
function short(e: unknown): string {
  const m = String((e as Error)?.message ?? e).replace(/\u001b\[[0-9;]*m/g, '')
  const line = (m.split(/\r?\n|Call log:/)[0] ?? '').trim().replace(/^[\w.]+: /, '')
  // Playwright's "Timeout 10000ms exceeded." on a click: something covered the button or the page didn't answer.
  if (/^Timeout \d+ms exceeded/.test(line)) return 'a button on the page didn’t respond in time (a pop-up may be covering it)'
  return line.slice(0, 160)
}

/** Stopped on purpose (canceled, the window closed, time up): never "finish it by hand". */
class Stop extends Error {}
/** An element that didn't show up in time. */
class NotFound extends Error {}

/** The person's selector overrides for a platform, checked: anything unusable is reported, not guessed at. */
function readSelectors(platform: WebPlatform, ctx: ConnectorContext): { sel: Record<string, string[]>; problem?: string } {
  const base = WEB_SELECTORS[platform]
  const raw = ctx.setting('webSelectors')?.trim()
  if (!raw) return { sel: base }
  const name = SITES[platform].name
  let custom: unknown
  try {
    custom = JSON.parse(raw)
  } catch {
    return { sel: base, problem: `Your ${name} selector overrides (under Options) aren’t valid JSON, so OneDraft used its own.` }
  }
  if (!custom || typeof custom !== 'object' || Array.isArray(custom))
    return { sel: base, problem: `Your ${name} selector overrides need to look like {"caption": ["selector"]}, so OneDraft used its own.` }
  const sel = { ...base }
  const bad: string[] = []
  for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
    const list = typeof value === 'string' ? [value] : value
    if (!(key in base)) bad.push(`“${key}” isn’t one of ${Object.keys(base).join(', ')}`)
    else if (!Array.isArray(list) || !list.length || !list.every((s) => typeof s === 'string' && s.trim())) bad.push(`“${key}” needs a list of selectors`)
    else sel[key] = list as string[]
  }
  return { sel, problem: bad.length ? `Part of your ${name} selector overrides was skipped: ${bad.join('; ')}.` : undefined }
}

/** What each selector key is, for messages people read. */
const WHAT: Record<string, string> = {
  fileInput: 'the place to add your file',
  title: 'the title box',
  description: 'the description box',
  caption: 'the caption box',
  text: 'the post box',
  newPost: 'the New post button',
  next: 'the Next button',
  ready: 'the post form (the upload may still be starting)',
  tags: 'the tag box',
  attachments: 'the attached media',
  visibility: 'the Visibility step',
  notForKids: 'the “made for kids” choice',
  forKids: 'the “made for kids” choice'
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

/** One post being filled in on one page. */
class Filler {
  /** What the person should know or still do, gathered while filling in. */
  readonly notes: string[] = []
  /** Set when time is up or the post is canceled: whatever is still running stops at its next step. */
  stopped = false
  private invalid = new Set<string>()
  /** The last search got no answer from the page at all. */
  private unresponsive = false

  constructor(
    readonly page: Page,
    readonly ctx: ConnectorContext,
    readonly platform: WebPlatform,
    private sel: Record<string, string[]>
  ) {}

  selectors(key: string): string[] {
    return this.sel[key] ?? []
  }

  /** Stop if the post was canceled, its window closed, time ran out, or the site went to its sign-in page. */
  check() {
    if (this.stopped) throw new Stop('the page stopped responding')
    if (this.ctx.signal?.aborted) throw new Stop('canceled')
    if (this.page.isClosed()) throw new Stop('the window was closed')
    if (SITES[this.platform].loginPage.test(this.page.url())) throw signedOut(SITES[this.platform])
  }

  async wait(ms: number) {
    this.check()
    await sleep(ms)
    this.check()
  }

  /** First selector with a visible match (any match if `hidden`), polled until the timeout. */
  async find(key: string, timeoutMs = 20_000, hidden = false): Promise<Locator> {
    const list = this.selectors(key)
    const deadline = Date.now() + timeoutMs
    for (let round = 1; ; round++) {
      this.check()
      let answered = false
      for (const s of list) {
        const all = this.page.locator(s)
        const loc = (hidden ? all : all.filter({ visible: true })).first()
        const n = await bounded(loc.count(), 5000).then(
          (n) => {
            answered = true
            return n
          },
          (e: Error) => {
            if (/selector|Unexpected token|SyntaxError/i.test(e.message) && !/stopped responding/.test(e.message)) {
              this.invalid.add(s)
              answered = true
            }
            return 0
          }
        )
        if (n > 0) return loc
      }
      this.unresponsive = list.length > 0 && !answered
      // A sign-in form instead of the page (Instagram shows one without changing the address).
      if (round % 4 === 0 && SITES[this.platform].passwordBox !== false && (await this.passwordBox())) throw signedOut(SITES[this.platform])
      if (Date.now() > deadline) {
        // A page whose script is stuck can't be searched: that isn't a missing button.
        if (this.unresponsive) throw new Error('the page stopped responding')
        const bad = list.filter((s) => this.invalid.has(s))
        throw new NotFound(`couldn’t find ${WHAT[key] ?? `“${key}”`} on the page${bad.length ? ` (not a valid selector: ${bad.join(', ')})` : ''}`)
      }
      await sleep(500)
    }
  }

  /** find(), but not finding it is fine. */
  async maybe(key: string, timeoutMs = 3000): Promise<Locator | undefined> {
    try {
      return await this.find(key, timeoutMs)
    } catch (e) {
      if (e instanceof NotFound) return undefined
      throw e
    }
  }

  async passwordBox(): Promise<boolean> {
    return (await bounded(this.page.locator("input[type='password']").filter({ visible: true }).count(), 3000).catch(() => 0)) > 0
  }

  /**
   * Replace an editor's text (contenteditable editors ignore fill()) and read it back; false if the page still
   * shows something else after a second try. insertText goes through the browser's own input path, which Draft.js
   * and Lexical editors take as typing. A tour or tip covering the box doesn't stop it: it's focused then.
   */
  async type(editor: Locator, text: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.check()
      await editor.click({ timeout: 5000 }).catch(() => editor.focus({ timeout: 5000 }).catch(() => undefined))
      this.check()
      await this.keys(() => this.page.keyboard.press('Control+A'))
      await this.keys(() => this.page.keyboard.press('Delete'))
      if (text) await this.keys(() => this.page.keyboard.insertText(text))
      const shown = await bounded(editor.innerText({ timeout: 3000 }), 5000).catch(() => undefined)
      if (shown === undefined || flat(shown) === flat(text)) return true
    }
    return false
  }

  /**
   * Replace a plain text box's value and read it back; false if the page doesn't keep it. fill() fires the input
   * events Vue and React listen to (type() above is for editors, whose text an input's innerText doesn't show).
   */
  async setValue(box: Locator, text: string): Promise<boolean> {
    this.check()
    if (!(await bounded(box.fill(text, { timeout: 5000 }), 8000).then(() => true, () => false))) return false
    this.check()
    return (await bounded(box.inputValue({ timeout: 3000 }), 5000).catch(() => undefined)) === text
  }

  /** Keystrokes, given up on when the page stops taking them (a busy page never answers). */
  async keys(press: () => Promise<void>, ms = 10_000) {
    this.check()
    await bounded(press(), ms).catch((e: Error) => {
      throw /stopped responding/.test(e.message) ? new Stop('the page stopped responding') : e
    })
  }

  /** Is the keyboard still in this editor? (A tip that grabs the focus would get the keystrokes otherwise.) */
  holds(editor: Locator): Promise<boolean> {
    return bounded(
      editor.evaluate((el) => el.contains(el.ownerDocument.activeElement)),
      3000
    ).catch(() => false)
  }

  /** Click away whatever tours or tips the site shows. */
  async dismiss() {
    for (const s of this.selectors('dismiss')) {
      this.check()
      const b = this.page.locator(s).filter({ visible: true }).first()
      if ((await bounded(b.count(), 3000).catch(() => 0)) > 0) await b.click({ timeout: 3000 }).catch(() => undefined)
    }
  }
}

/** Signed out after all? The sign-in page's address, a password box, or the sign-in cookie gone. */
async function loggedOut(site: Site, page: Page, browser: BrowserContext): Promise<boolean> {
  if (page.isClosed()) return false
  if (site.loginPage.test(page.url())) return true
  const cookies = await bounded(browser.cookies(), 5000).catch(() => undefined)
  if (cookies && !signedIn(site)(cookies)) return true
  if (site.passwordBox === false) return false
  return (await bounded(page.locator("input[type='password']").filter({ visible: true }).count(), 3000).catch(() => 0)) > 0
}

/** Keep the newest diagnostics only: they are for repairing selectors, not an archive. */
function prune(dir: string, keep: number) {
  try {
    const files = readdirSync(dir)
      .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const f of files.slice(keep)) rmSync(f.path, { force: true })
  } catch {
    // nothing to tidy
  }
}

async function snapshot(page: Page | undefined, ctx: ConnectorContext, label: string): Promise<string | undefined> {
  if (!page || page.isClosed()) return undefined
  try {
    const dir = join(ctx.paths.data, 'diagnostics')
    mkdirSync(dir, { recursive: true })
    prune(dir, 40)
    const stem = join(dir, `${label}-${Date.now()}`)
    await page.screenshot({ path: `${stem}.png`, timeout: 10_000 })
    // The page's scripts can carry session tokens: the HTML keeps the markup only.
    const html = await bounded(page.content(), 10_000)
    writeFileSync(`${stem}.html`, html.replace(/<script\b[\s\S]*?<\/script>/gi, ''))
    return `${stem}.png`
  } catch {
    return undefined
  }
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const yes = (v: unknown) => v === true || v === 'true'
/** Tags to add as hashtags: tidied, once each, and not ones the text already has. */
const newTags = (text: string, tags: string[]) =>
  tags
    .map((t) => t.trim().replace(/^#/, '').replace(/\s+/g, ''))
    .filter((t, i, all) => t && all.indexOf(t) === i && !text.toLowerCase().includes(`#${t.toLowerCase()}`))

/** TikTok's "Who can watch" names for the privacy levels OneDraft offers. */
const WHO: Record<string, string> = { PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only you' }

/** For posts marked as made with AI, where OneDraft can't set the site's label itself. */
const AI_NOTE: Record<WebPlatform, string> = {
  youtube: 'This video is marked as made with AI: on Details, under “Altered content”, choose Yes.',
  tiktok: 'This video is marked as made with AI: under Show more, turn on “AI-generated content”.',
  instagram: 'This post is marked as made with AI: if Instagram offers “Add AI label” (under Advanced settings), turn it on.',
  x: 'This post is marked as made with AI; X’s website has no label for that, so say so in the text if you need to.',
  bilibili: 'This video is marked as made with AI: under Creation Statement (创作声明), choose the one for AI-generated content.'
}

const KEPT = 'the page didn’t keep what OneDraft typed'

// ---------------------------------------------------------------- filling in a post, per site

/** Fills in the page and returns what's left for the person to do. */
type Fill = (f: Filler, content: ResolvedContent, publishAt?: string) => Promise<string>

const FILL: Record<WebPlatform, Fill> = {
  async youtube(f, content, publishAt) {
    const video = content.media.find(isVideo)!
    await (await f.find('fileInput', 45_000, true)).setInputFiles(video)
    f.ctx.progress(0.3, 'Uploading to YouTube')
    // The details form appears while the video uploads. YouTube refuses < and > in both boxes.
    const clean = (s: string) => s.replace(/</g, '‹').replace(/>/g, '›')
    if (!(await f.type(await f.find('title', 120_000), cut(clean(content.title), 100)))) f.notes.push(`Check the title: ${KEPT}.`)
    const description = cut(clean(content.caption), 5000)
    const desc = await f.maybe('description', 8000)
    if (desc) {
      if (!(await f.type(desc, description))) f.notes.push(`Check the description: ${KEPT}.`)
    } else if (description.trim()) f.notes.push('OneDraft couldn’t find the description box: paste the description yourself.')
    // A "#hashtag" in the text opens a suggestions list over the Next button.
    if (await f.maybe('suggestions', 800)) await f.keys(() => f.page.keyboard.press('Escape'))
    await (await f.find(yes(content.options.madeForKids) ? 'forKids' : 'notForKids', 15_000)).click({ timeout: 10_000 })
    if (content.aiGenerated) {
      const ai = await f.maybe('aiYes', 2000)
      if (!ai || !(await ai.click({ timeout: 5000 }).then(() => true, () => false))) f.notes.push(AI_NOTE.youtube)
    }
    if (content.tags.length) f.notes.push(`Add the tags under Show more → Tags: ${content.tags.join(', ')}.`)
    const vis = content.options.privacy === 'unlisted' ? 'Unlisted' : content.options.privacy === 'private' ? 'Private' : 'Public'
    const action = publishAt
      ? `choose Schedule, set ${when(publishAt)} and press Schedule`
      : `check it says ${vis}, then press ${vis === 'Public' ? 'Publish' : 'Save'}`
    // Details → Video elements → Checks → Visibility; the last button stays for the person.
    try {
      for (let i = 0; i < 3; i++) {
        await (await f.find('next', 10_000)).click({ timeout: 10_000 })
        await f.wait(900)
      }
      const radios = await f.find('visibility', 10_000)
      if (!publishAt) await radios.locator(`tp-yt-paper-radio-button[name='${vis.toUpperCase()}']`).first().click({ timeout: 5000 })
      return `On Visibility, ${action}.`
    } catch (e) {
      if (e instanceof Stop || e instanceof NeedsLoginError) throw e
      await snapshot(f.page, f.ctx, 'youtube-steps')
      return `Check the details, press Next until Visibility, ${action}.`
    }
  },

  async tiktok(f, content) {
    const video = content.media.find(isVideo)!
    await (await f.find('fileInput', 45_000, true)).setInputFiles(video)
    f.ctx.progress(0.3, 'Uploading to TikTok')
    await f.find('ready', 120_000)
    await f.dismiss()
    // The caption box starts with the file name: replace it.
    const editor = await f.find('caption', 30_000)
    if (!(await f.type(editor, content.caption))) f.notes.push(`Check the caption: ${KEPT}.`)
    // Hashtags are typed one by one (each becomes a tag once a space follows); pasted ones stay plain text and can
    // stall TikTok's editor. Keystrokes go on only while the caption still has the keyboard.
    const tags = newTags(content.caption, content.tags)
    for (let i = 0; i < tags.length; i++) {
      f.check()
      if (!(await f.holds(editor))) {
        f.notes.push(`Add these hashtags to the caption: ${tags.slice(i).map((t) => `#${t}`).join(' ')}.`)
        break
      }
      await f.keys(() => f.page.keyboard.type(`${i === 0 && content.caption.trim() ? ' ' : ''}#${tags[i]}`, { delay: 30 }))
      await f.wait(700)
      await f.keys(() => f.page.keyboard.press('Space'))
    }
    await f.dismiss()
    if (content.aiGenerated) f.notes.push(AI_NOTE.tiktok)
    const who = WHO[String(content.options.privacyLevel ?? '')]
    return `Check the caption, ${who ? `set “Who can watch” to ${who}` : 'choose who can watch'}, and press Post once the upload finishes.`
  },

  async instagram(f, content) {
    await f.dismiss()
    await (await f.find('newPost', 30_000)).click({ timeout: 10_000 })
    // Newer layouts ask "Post, Reel or Live" first.
    await (await f.maybe('postOption', 2500))?.click({ timeout: 5000 })
    // This box takes photos and MP4s (the cover picker later has its own); 10 items on the website.
    const media = content.media.slice(0, 10)
    if (content.media.length > media.length) f.notes.push(`Instagram’s website takes 10 photos or videos per post: OneDraft added the first 10 of ${content.media.length}.`)
    await (await f.find('fileInput', 20_000, true)).setInputFiles(media)
    f.ctx.progress(0.3, 'Adding the media on Instagram')
    if (media.some(isVideo)) await (await f.maybe('reelsOk', 4000))?.click({ timeout: 5000 })
    // Crop → Edit → Caption: each Next changes the dialog's heading (without one to watch, give it a moment).
    const headingSel = f.selectors('heading')[0] ?? "[role='dialog'] [role='heading']"
    const heading = async () => (await bounded(f.page.locator(headingSel).first().textContent({ timeout: 1000 }), 3000).catch(() => null)) ?? ''
    for (let i = 0; i < 2; i++) {
      const before = await heading()
      await (await f.find('next', 30_000)).click({ timeout: 10_000 })
      if (!before) await f.wait(1500)
      else for (let t = 0; t < 20 && (await heading()) === before; t++) await f.wait(500)
    }
    if (!(await f.type(await f.find('caption', 20_000), captionWithHashtags(content.caption, content.tags)))) f.notes.push(`Check the caption: ${KEPT}.`)
    if (content.aiGenerated) f.notes.push(AI_NOTE.instagram)
    return 'Check the post and press Share.'
  },

  async x(f, content, publishAt) {
    // Wait for the compose dialog, so the Home timeline's composer underneath isn't the one filled in.
    await f.maybe('dialog', 10_000)
    const box = await f.find('text', 30_000)
    // Media first, and the text only once it's attached: an upload finishing later can reset X's editor.
    if (content.media.length) {
      const files = content.media.slice(0, isVideo(content.media[0]) ? 1 : 4)
      if (files.length < content.media.length) f.notes.push(`X took ${files.length} of your ${content.media.length} files: add the rest in a reply.`)
      await (await f.find('fileInput', 10_000, true)).setInputFiles(files)
      f.ctx.progress(0.3, 'Adding the media on X')
      if (await f.maybe('attachments', 60_000)) await f.wait(1500)
      else f.notes.push('Check that your media is attached: X didn’t show it within a minute.')
    }
    const text = captionWithHashtags(content.caption, content.tags)
    if (!(await f.type(box, text))) f.notes.push(`Check the text: ${KEPT}.`)
    if (weightedLength(text) > 280) f.notes.push('The text is longer than 280 characters, which X posts only with Premium: otherwise shorten it, or split it into a thread with the + button.')
    if (content.aiGenerated) f.notes.push(AI_NOTE.x)
    return publishAt ? `Check the post. To post it later, press the schedule (calendar) button, set ${when(publishAt)} and confirm.` : 'Check the post and press Post.'
  },

  async bilibili(f, content, publishAt) {
    const video = content.media.find(isVideo)!
    // Bilibili's page drops a file chosen while it is still starting up: its own script fails ("reading 'catch'") and
    // no upload starts. Seen 2026-11-17 on the user's account: a file chosen as the upload area appeared started
    // nothing; the same file chosen 20 s later started at once. So OneDraft lets the page settle, chooses the way a
    // person does (a click on the area, then the file box it opens), and chooses again while no upload has started.
    const errors: string[] = []
    const onError = (e: Error) => void (errors.length < 3 && errors.push(short(e)))
    f.page.on('pageerror', onError)
    let titleBox: Locator | undefined
    try {
      const area = await f.find('uploadArea', 45_000)
      await f.wait(3000)
      for (let attempt = 1; attempt <= 3 && !titleBox; attempt++) {
        if (attempt > 1) {
          // An upload that did start has replaced the upload area: wait for its form, never add the video twice.
          if (!(await f.maybe('uploadArea', 1000))) {
            titleBox = await f.maybe('title', 60_000)
            break
          }
          f.ctx.log(`Bilibili didn’t take the video${errors.length ? ` (its page said: ${errors[errors.length - 1]})` : ''}; choosing it again.`, 'warn')
          await f.wait(3000)
        }
        f.check()
        const chooser = f.page.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => undefined)
        await area.click({ timeout: 10_000 }).catch(() => undefined)
        const box = await chooser
        const chosen = box ? await bounded(box.setFiles(video), 30_000).then(() => true, () => false) : false
        if (!chosen) await (await f.find('fileInput', 10_000, true)).setInputFiles(video)
        if (attempt === 1) f.ctx.progress(0.3, 'Uploading to Bilibili')
        // The form appears as soon as an upload starts, its title set to the file name.
        titleBox = await f.maybe('title', 12_000)
      }
    } finally {
      f.page.off('pageerror', onError)
    }
    if (!titleBox)
      throw new NotFound(
        `Bilibili didn’t start the upload${errors.length ? ` (its page said: ${errors[0]})` : ''}; press Upload Video (上传视频) and choose ${basename(video)}`
      )
    // The file-name title is replaced. Filling in doesn't wait for the upload (a big video takes longer than OneDraft
    // gives a page); the person presses 立即投稿 once it's done.
    if (!(await f.setValue(titleBox, cut(content.title, 80)))) f.notes.push(`Check the title: ${KEPT}.`)
    const description = cut(content.caption, 2000)
    const desc = await f.maybe('description', 8000)
    if (desc) {
      if (!(await f.type(desc, description))) f.notes.push(`Check the description (简介): ${KEPT}.`)
    } else if (description.trim()) f.notes.push('OneDraft couldn’t find the description box (简介): paste the description yourself.')
    // Bilibili suggests tags of its own; the post's take their place (the page takes 10, each up to 20 characters).
    const tags = [...new Set(content.tags.map((t) => cut(t.trim().replace(/^#/, ''), 20)).filter(Boolean))].slice(0, 10)
    if (tags.length) {
      const box = await f.maybe('tags', 8000)
      if (!box) f.notes.push(`Add the tags: ${tags.join(', ')}.`)
      else {
        for (let i = 0; i < 12; i++) {
          const suggested = await f.maybe('tagRemove', 500)
          if (!suggested) break
          await suggested.click({ timeout: 3000 }).catch(() => undefined)
          await f.wait(300)
        }
        const left: string[] = []
        for (const t of tags) {
          if (!(await f.setValue(box, t))) {
            left.push(t)
            continue
          }
          await f.keys(() => box.press('Enter', { timeout: 5000 }))
          await f.wait(400)
        }
        if (left.length) f.notes.push(`Add these tags: ${left.join(', ')}.`)
      }
    }
    // The page's own choices, which OneDraft only reminds of.
    const o = content.options
    if (o.copyright === '2') f.notes.push(`Choose 转载 (Repost)${o.source ? ` and give the source: ${String(o.source)}` : ''}.`)
    if (o.dynamic) f.notes.push(`Add the feed text (粉丝动态): ${String(o.dynamic)}`)
    if (content.cover) f.notes.push(`To use your cover, set it under 封面: ${content.cover}`)
    if (content.aiGenerated) f.notes.push(AI_NOTE.bilibili)
    // Bilibili shows its page in Chinese or English: both names are given. The creation statement is required, and
    // what fits is the person's call (seen on the live page 2026-11-17).
    const go = 'press 立即投稿 (Submit) once the upload says 上传完成 (Upload complete)'
    const check = 'Choose a creation statement (创作声明 / Creation Statement), check the details and the category (分区 / Category)'
    return publishAt
      ? `${check}. To post it at ${when(publishAt)}, turn on 定时发布 (Scheduled), set that time, and ${go}.`
      : `${check}, and ${go}.`
  }
}

/** Filling in gives up after this long (a page that stopped responding), and right away on Cancel. */
const FILL_LIMIT_MS = 5 * 60_000

function withDeadline<T>(work: Promise<T>, ms: number, signal: AbortSignal | undefined, onStop: () => void): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stop = new Promise<never>((_, reject) => {
    t = setTimeout(() => {
      onStop()
      reject(new Stop('the page stopped responding'))
    }, ms)
    onAbort = () => {
      onStop()
      reject(new Stop('canceled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  work.catch(() => undefined)
  return Promise.race([work, stop]).finally(() => {
    clearTimeout(t)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  })
}

/** Tabs OneDraft is filling in or has handed over, so a new post never takes over an earlier one's tab. */
const taken = new WeakSet<Page>()

/**
 * Open the site's upload page in the account's window and fill in the post; the window stays open for the person
 * to check it and press Post. If something can't be filled in, the window still stays open, with what's left to do.
 */
export async function webPublish(platform: WebPlatform, ctx: ConnectorContext, account: Account, req: PublishRequest): Promise<PublishResult> {
  const site = SITES[platform]
  const { content } = req
  // What can't work is said before any window opens.
  const missing = content.media.find((m) => !existsSync(m))
  if (missing) throw new ContentError(`A file in this post is missing: ${missing}`)
  if ((platform === 'youtube' || platform === 'tiktok' || platform === 'bilibili') && !content.media.some(isVideo)) throw new ContentError(`${site.name} needs a video.`)
  if (platform === 'instagram' && !content.media.length) throw new ContentError('Instagram needs a photo or a video.')
  for (const i of webIssues(platform, content)) if (i.level === 'error') throw new ContentError(i.message)
  if (ctx.signal?.aborted) throw new CanceledError()
  const { sel, problem } = readSelectors(platform, ctx)
  if (problem) ctx.log(problem, 'warn')

  let browser: BrowserContext | undefined
  let page: Page | undefined
  let releasing: Promise<void> | undefined
  let onAbort: (() => void) | undefined
  /** This post's hold on the account's browser: it ends when its tab closes, or when the post fails. */
  const release = (): Promise<void> => {
    if (!releasing) releasing = browser ? browser.close().catch(() => undefined) : Promise.resolve()
    return releasing
  }
  /** Close this post's tab and let go of the browser (waiting until it has, so the profile is free again). */
  const drop = async () => {
    await page?.close().catch(() => undefined)
    await release()
  }
  try {
    browser = await ctx.browser(profileKey(account), { headless: false })
    if (!signedIn(site)(await browser.cookies())) throw signedOut(site)
    // A tab of its own: an earlier post may still be open, waiting for the person.
    page = browser.pages().find((p) => p.url() === 'about:blank' && !taken.has(p)) ?? (await browser.newPage())
    taken.add(page)
    page.once('close', () => void release())
    // Cancel closes the tab, which also ends a page that is still loading.
    const tab = page
    onAbort = () => void tab.close().catch(() => undefined)
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    if (ctx.signal?.aborted) throw new CanceledError()
    ctx.progress(0.1, `Opening ${site.name}`)
    const res = await page.goto(site.uploadUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(async (e: Error) => {
      // Sent elsewhere while loading (usually the sign-in page): the checks below sort that out.
      if (/ERR_ABORTED|interrupted by another navigation/i.test(e.message)) return null
      // A site that refuses the page and drops the sign-in cookie with it means: signed out.
      if (/ERR_HTTP_RESPONSE_CODE_FAILURE/.test(e.message) && browser && !signedIn(site)(await browser.cookies().catch(() => []))) throw signedOut(site)
      throw new RetryableError(`Couldn’t open ${site.name} (${/Timeout \d+ms/.test(e.message) ? 'it didn’t load within a minute' : short(e)}). OneDraft will try again.`, 120)
    })
    if (res && res.status() >= 500) throw new RetryableError(`${site.name} answered ${res.status()}. OneDraft will try again.`)
    const f = new Filler(page, ctx, platform, sel)
    if (problem) f.notes.push(problem)
    const todo = await withDeadline(FILL[platform](f, content, req.publishAt), FILL_LIMIT_MS, ctx.signal, () => (f.stopped = true))
    await page.bringToFront().catch(() => undefined)
    const note = [todo, ...f.notes].join(' ')
    ctx.log(`Filled in the post on ${site.name}: ${note}`)
    return { state: 'handoff', note: `${note} (It’s open in the ${site.name} window.)`, closed: whenClosed(page, site) }
  } catch (e) {
    if (ctx.signal?.aborted) {
      await drop()
      throw new CanceledError()
    }
    if (!page) {
      await release()
      // The browser closed under it (the account disconnected meanwhile, or the window was closed as it opened).
      if (/has been closed/i.test(String((e as Error)?.message))) throw new Error(`The ${site.name} window was closed before the post was ready. Press Retry to open it again.`)
      throw e
    }
    if (page.isClosed()) {
      await release()
      throw new Error(`The ${site.name} window was closed before the post was ready. Press Retry to open it again.`)
    }
    if (e instanceof NeedsLoginError || (browser && (await loggedOut(site, page, browser)))) {
      // What the site showed, to check it really asked to sign in (the tab closes next).
      const shot = await snapshot(page, ctx, `${platform}-signedout`)
      if (shot) ctx.log(`${site.name} looked signed out (screenshot: ${shot})`, 'warn')
      await drop()
      throw e instanceof NeedsLoginError ? e : signedOut(site)
    }
    if (e instanceof RetryableError || e instanceof ContentError) {
      await drop()
      throw e
    }
    // Filling in stopped part way: the page stays open with what's left to do.
    const shot = await snapshot(page, ctx, `${platform}-fill`)
    ctx.log(`Couldn’t fill in everything on ${site.name}: ${short(e)}${shot ? ` (screenshot: ${shot})` : ''}`, 'warn')
    await page.bringToFront().catch(() => undefined)
    return {
      state: 'handoff',
      note: `OneDraft couldn’t fill in everything on ${site.name} (${short(e)}). The page is open in the ${site.name} window: finish the post there and press ${site.press ?? 'Post'}.`,
      closed: whenClosed(page, site)
    }
  } finally {
    if (onAbort) ctx.signal?.removeEventListener('abort', onAbort)
  }
}

/** The note a handed-over post gets once the person closes its tab (posted there or not). */
const whenClosed = (page: Page, site: Site) =>
  new Promise<string>((resolve) =>
    page.once('close', () => resolve(`The ${site.name} tab with this post was closed. If you didn’t press ${site.press ?? 'Post'} there, press “Post again”.`))
  )

/** Fields and texts for a connector's manifest.web; `options` are the post options the website way uses. */
export function webManifest(platform: WebPlatform, extraNotes: string[] = [], options: string[] = [], constraints?: Partial<Constraints>) {
  const name = SITES[platform].name
  return {
    signIn: `A browser window opens on ${name}’s sign-in page. Sign in the way you always do; the window closes by itself once you’re in, and OneDraft keeps that sign-in for this account.`,
    fields: WEB_FIELDS,
    notes: [
      `When you post, OneDraft opens ${name}’s own upload page in that window, adds your media and text, and you press Post.`,
      `Comments and numbers from ${name} need the Official API way.`,
      ...extraNotes
    ],
    options,
    constraints
  }
}
