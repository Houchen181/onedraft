// Persistent Playwright browser profiles, one per account, using the installed Edge or Chrome
// (no bundled browser download). Contexts are leased: a connector that leaves a window open for the
// person (handoff) keeps its lease until that tab closes; others close their lease when done.
//
// Signing in happens in a plain window instead (signIn): the same profile, but the browser is started like any
// other, without automation attached, because Google, TikTok, Instagram and X refuse or challenge sign-ins in
// automated browsers. OneDraft only reads the cookies over a browser-level DevTools pipe (it attaches to no page)
// to see when the sign-in is done.
//
// Two browsers can't share a profile, so a profile is used by one thing at a time: a sign-in window, or
// OneDraft's own browser (a hidden one for account checks, a visible one for posts). A browser that is closing is
// waited for before the profile opens again, and a disconnected account's profile never opens again.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { chromium, type BrowserContext } from 'playwright-core'
import { RetryableError, type WebCookie } from '../core/connector'

/** The installed Edge (default) or Chrome. */
export function browserExe(channel: string): string {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = process.env['LOCALAPPDATA'] ?? ''
  const candidates =
    channel === 'chrome'
      ? [join(pf, 'Google\\Chrome\\Application\\chrome.exe'), join(pf86, 'Google\\Chrome\\Application\\chrome.exe'), join(local, 'Google\\Chrome\\Application\\chrome.exe')]
      : [join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'), join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'), join(local, 'Microsoft\\Edge\\Application\\msedge.exe')]
  const hit = candidates.find((p) => existsSync(p))
  if (!hit)
    throw new Error(
      channel === 'chrome'
        ? 'Google Chrome isn’t installed. Install it, or set “Browser for website accounts” back to Microsoft Edge (Settings → Rednote → Options).'
        : 'Microsoft Edge isn’t installed.'
    )
  return hit
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A pause that ends early when the signal aborts. */
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

/** Extra switches for every browser OneDraft starts, from ONEDRAFT_BROWSER_ARGS (tests pass --headless=new). */
const extraSwitches = (): string[] => (process.env['ONEDRAFT_BROWSER_ARGS'] ?? '').split(/\s+/).filter(Boolean)

/** How the plain sign-in window is started. */
const SIGN_IN_SWITCHES = [
  // DevTools over a pipe only OneDraft holds: a debugging port would let any program on this computer read the
  // new sign-in's cookies while the window is open.
  '--remote-debugging-pipe',
  // With that pipe, Chromium tells every page the browser is automated (navigator.webdriver), and Google refuses to
  // sign in ("This browser or app may not be secure"). OneDraft only reads cookies: the sites see plain Edge.
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  // A fresh Edge profile otherwise signs in to the Windows (work or school) Microsoft account and syncs with it.
  '--disable-sync',
  '--disable-features=msImplicitSignin',
  // Edge may restart itself (its compatibility layer, or to drop administrator rights): the window would stay
  // open, but OneDraft would see its browser exit and think the window was closed.
  '--edge-skip-compat-layer-relaunch',
  '--do-not-de-elevate'
]

/**
 * Features off in OneDraft's own (Playwright) windows: Playwright's list as of 1.65 (it passes its own
 * --disable-features, and a browser takes only the last one, so ours repeats it) plus Edge's implicit sign-in, which
 * otherwise signs the account's profile in to the Windows work or school account the first time it opens.
 */
const DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'HttpsUpgrades',
  'HttpsFirstBalancedModeAutoEnable',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'AvoidCorsURLLoaderRestartOnRedirect',
  'TcpPortRandomizationWin',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
  'PreconnectToSearch',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
  'msImplicitSignin'
]

/**
 * A browser that was ended rather than closed (OneDraft quit, a crash) offers to restore its pages next time, or
 * reopens them: mark the profile's last exit as a clean one.
 */
function cleanExit(dir: string) {
  const file = join(dir, 'Default', 'Preferences')
  try {
    const prefs = JSON.parse(readFileSync(file, 'utf8')) as { profile?: { exit_type?: string; exited_cleanly?: boolean } }
    if (!prefs.profile || (prefs.profile.exit_type === 'Normal' && prefs.profile.exited_cleanly !== false)) return
    prefs.profile.exit_type = 'Normal'
    prefs.profile.exited_cleanly = true
    writeFileSync(file, JSON.stringify(prefs))
  } catch {
    // a new profile (nothing to restore), or one the browser is writing
  }
}

/** The browser went away: closed, crashed or ended. */
class BrowserGone extends Error {
  constructor() {
    super('The browser closed.')
  }
}

/** Rejects with `error` once the signal aborts; otherwise settles like `p`. */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal | undefined, error: () => Error): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(error())
    const onAbort = () => reject(error())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

/**
 * A minimal DevTools client for the browser target only (no page is attached), over the browser's debugging pipe:
 * JSON messages, each ended by a NUL character. Every command settles: it rejects once the browser goes away or
 * doesn't answer in time.
 */
class Cdp {
  private next = 0
  private closed = false
  private buffer = ''
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  constructor(
    private out: Writable,
    input: Readable
  ) {
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => {
      this.buffer += chunk
      for (let end = this.buffer.indexOf('\0'); end >= 0; end = this.buffer.indexOf('\0')) {
        const text = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        this.receive(text)
      }
    })
    const gone = () => this.shut()
    input.on('end', gone)
    input.on('close', gone)
    input.on('error', gone)
    out.on('error', gone)
    out.on('close', gone)
  }
  private receive(text: string) {
    let j: { id?: number; result?: unknown; error?: { message: string } }
    try {
      j = JSON.parse(text) as typeof j
    } catch {
      return
    }
    const w = j.id === undefined ? undefined : this.waiting.get(j.id)
    if (!w) return
    this.waiting.delete(j.id!)
    if (j.error) w.reject(new Error(j.error.message))
    else w.resolve(j.result)
  }
  private shut() {
    if (this.closed) return
    this.closed = true
    for (const w of this.waiting.values()) w.reject(new BrowserGone())
    this.waiting.clear()
  }
  get alive() {
    return !this.closed && this.out.writable
  }
  send<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.alive) return Promise.reject(new BrowserGone())
    const id = ++this.next
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('The sign-in window stopped responding. Close it and press Connect again.'))
      }, timeoutMs)
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(t)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(t)
          reject(e)
        }
      })
      this.out.write(`${JSON.stringify({ id, method, params })}\0`, (err) => {
        if (!err) return
        clearTimeout(t)
        this.waiting.delete(id)
        reject(new BrowserGone())
      })
    })
  }
  close() {
    this.shut()
    try {
      this.out.end()
    } catch {
      // already closed
    }
  }
}

interface Entry {
  ctx: BrowserContext
  leases: number
  headless: boolean
  /** Settles once the context has closed. */
  closed: Promise<void>
  /** Disconnected while posts were waiting in its window: the profile goes once the window does. */
  forget?: boolean
}

export class BrowserManager {
  private open = new Map<string, Entry>()
  private opening = new Map<string, Promise<Entry>>()
  /** Browsers on their way out: the profile opens again only once they're gone. */
  private closing = new Map<string, Promise<void>>()
  /** Profiles with a sign-in window open: nothing else may start a browser on them meanwhile. */
  private signingIn = new Set<string>()
  /** Profiles of disconnected accounts: never opened again. */
  private forgotten = new Set<string>()

  constructor(
    private profilesDir: string,
    private channel: () => string
  ) {}

  private checkKey(key: string) {
    if (!/^[\w-]+$/.test(key)) throw new Error(`Bad browser profile key "${key}"`)
  }

  async lease(key: string, opts: { headless?: boolean; locale?: string } = {}): Promise<BrowserContext> {
    this.checkKey(key)
    const headless = opts.headless ?? false
    const giveUp = Date.now() + 60_000
    for (;;) {
      if (this.forgotten.has(key)) throw new Error('This account was disconnected.')
      if (this.signingIn.has(key)) throw new RetryableError('This account’s sign-in window is open. OneDraft will try again once it’s closed.', 120)
      const closing = this.closing.get(key)
      if (closing) {
        await closing
        continue
      }
      // A launch on its way: let it finish, then look again (it may be the wrong kind).
      const launching = this.opening.get(key)
      if (launching) {
        await launching.catch(() => undefined)
        continue
      }
      const entry = this.open.get(key)
      if (entry && entry.headless && !headless) {
        // A hidden browser (an account check) holds the profile and a window is wanted: once it's let go, the
        // profile is opened again, visibly.
        if (entry.leases > 0) {
          if (Date.now() > giveUp) throw new RetryableError('This account’s browser is busy. OneDraft will try again in a minute.', 60)
          await Promise.race([entry.closed, sleep(500)])
          continue
        }
        await this.shut(key, entry)
        continue
      }
      if (entry) {
        entry.leases++
        return this.wrap(key, entry)
      }
      const p = this.launch(key, headless, opts.locale)
      this.opening.set(key, p)
      let fresh: Entry
      try {
        fresh = await p
      } finally {
        this.opening.delete(key)
      }
      fresh.leases++
      return this.wrap(key, fresh)
    }
  }

  private async launch(key: string, headless: boolean, locale?: string): Promise<Entry> {
    const dir = join(this.profilesDir, key)
    mkdirSync(dir, { recursive: true })
    cleanExit(dir)
    // The same browser the sign-in window uses (Playwright would look elsewhere first with two installed).
    const executablePath = browserExe(this.channel() || 'msedge')
    let ctx: BrowserContext | undefined
    for (let attempt = 1; !ctx; attempt++) {
      try {
        ctx = await chromium.launchPersistentContext(dir, {
          executablePath,
          headless,
          viewport: null,
          locale,
          // The person uses these windows like any browser: Edge's sandbox stays on (Playwright turns it off).
          chromiumSandbox: true,
          // Look like an ordinary browser: sites change behaviour (or refuse) when they see automation flags. The
          // "unsafe" switches only serve Playwright's own tests and could put a warning bar on the person's window.
          ignoreDefaultArgs: ['--enable-automation', '--enable-unsafe-swiftshader', '--unsafely-disable-devtools-self-xss-warnings'],
          args: ['--start-maximized', '--disable-blink-features=AutomationControlled', `--disable-features=${DISABLED_FEATURES.join(',')}`, ...extraSwitches()]
        })
      } catch (e) {
        const m = String((e as Error)?.message ?? e)
        // Exit code 21: another browser still has the profile, usually one that closed a moment ago.
        const inUse = /exitCode=21|has been closed/i.test(m)
        if (inUse && attempt < 4) {
          await sleep(1500)
          continue
        }
        if (inUse) throw new RetryableError('This account’s browser profile is open in another browser window. Close that window; OneDraft will try again.', 120)
        throw new Error(`The browser couldn’t start (${m.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)[0].replace(/^[\w.]+: /, '')}).`)
      }
    }
    // In a window the person uses, the site's own dialogs ("Leave site?", confirmations) are theirs to answer;
    // without a listener Playwright would answer them itself.
    if (!headless) ctx.on('dialog', () => undefined)
    const closed = new Promise<void>((resolve) => ctx.once('close', () => resolve()))
    const entry: Entry = { ctx, leases: 0, headless, closed }
    this.open.set(key, entry)
    void closed.then(() => {
      if (this.open.get(key) === entry) this.open.delete(key)
      // The person closed the window of a disconnected account: its profile goes now.
      if (entry.forget) void this.remove(key)
    })
    return entry
  }

  /** Close an entry's browser; the profile opens again only after it has (see `closing`). */
  private shut(key: string, entry: Entry): Promise<void> {
    if (this.open.get(key) === entry) this.open.delete(key)
    const p = entry.ctx
      .close()
      .catch(() => undefined)
      .then(() => (entry.forget ? this.remove(key) : undefined))
    this.closing.set(key, p)
    void p.finally(() => {
      if (this.closing.get(key) === p) this.closing.delete(key)
    })
    return p
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
            if (entry.leases <= 0 && this.open.get(key) === entry) await this.shut(key, entry)
          }
        }
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? v.bind(target) : v
      }
    })
  }

  /**
   * A plain browser window on this profile for the person to sign in (see the top of this file). Resolves with the
   * cookies once `signedIn` accepts them, after closing the window; rejects if the window is closed first.
   */
  async signIn(
    key: string,
    url: string,
    signedIn: (cookies: WebCookie[]) => boolean,
    signal?: AbortSignal,
    /** Extra browser switches (tests run it with --headless=new). */
    extraArgs: string[] = []
  ): Promise<WebCookie[]> {
    this.checkKey(key)
    if (signal?.aborted) throw new Error('Sign-in canceled.')
    if (this.forgotten.has(key)) throw new Error('This account was disconnected.')
    if (this.signingIn.has(key)) throw new Error('A sign-in window for this account is already open.')
    this.signingIn.add(key)
    try {
      await this.opening.get(key)?.catch(() => undefined)
      const open = this.open.get(key)
      if (open) {
        // OneDraft's own window on this profile is in use: posts waiting there would be lost.
        if (!open.headless && open.leases > 0) throw new Error('Posts are waiting in this account’s browser window. Finish or close them, then press Connect again.')
        await this.shut(key, open)
      }
      await this.closing.get(key)
      return await this.watchSignIn(key, url, signedIn, signal, extraArgs)
    } finally {
      this.signingIn.delete(key)
    }
  }

  private async watchSignIn(key: string, url: string, signedIn: (cookies: WebCookie[]) => boolean, signal: AbortSignal | undefined, extraArgs: string[]): Promise<WebCookie[]> {
    const dir = join(this.profilesDir, key)
    mkdirSync(dir, { recursive: true })
    cleanExit(dir)
    let child: ChildProcess
    try {
      child = spawn(browserExe(this.channel() || 'msedge'), [`--user-data-dir=${dir}`, ...SIGN_IN_SWITCHES, ...extraSwitches(), ...extraArgs, url], {
        // fd 3 and 4: the DevTools pipe (OneDraft writes to 3, the browser answers on 4).
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
        windowsHide: false
      })
    } catch (e) {
      throw new Error(`The browser couldn’t start (${(e as Error).message}).`)
    }
    let exited = false
    let spawnError: Error | undefined
    const gone = new Promise<void>((resolve) => {
      child.once('exit', () => {
        exited = true
        resolve()
      })
      child.once('error', (e) => {
        exited = true
        spawnError = e
        resolve()
      })
    })
    const canceled = () => new Error('Sign-in canceled.')
    const closedEarly = () => new Error('The sign-in window was closed before you finished signing in. Press Connect to try again.')
    // Gone before DevTools ever answered: it never showed a window of its own (often because another window
    // already has this profile open, and the new one handed over to it).
    const couldntOpen = () =>
      spawnError
        ? new Error(`The browser couldn’t start (${spawnError.message}).`)
        : new Error('The browser closed before it showed the sign-in page. If a window for this account is already open, close it, then press Connect again.')
    const cdp = new Cdp(child.stdio[3] as Writable, child.stdio[4] as Readable)
    let up = false
    let graceMs = 0
    try {
      // The browser answers once it is up.
      try {
        await unlessAborted(cdp.send('Browser.getVersion', {}, 30_000), signal, canceled)
        up = true
      } catch (e) {
        if (signal?.aborted || e instanceof BrowserGone || exited) throw e
        throw new Error('The browser didn’t start, or it doesn’t let OneDraft watch the sign-in (an organization policy can block that). Close its other windows and press Connect again.')
      }
      for (const t0 = Date.now(); ; await pause(1500, signal)) {
        if (signal?.aborted) throw canceled()
        if (exited) throw closedEarly()
        if (Date.now() - t0 > 20 * 60_000) throw new Error('Sign-in took longer than 20 minutes. Press Connect to try again.')
        const { cookies } = await unlessAborted(cdp.send<{ cookies: WebCookie[] }>('Storage.getCookies'), signal, canceled)
        const list = cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain }))
        if (signedIn(list)) {
          // The browser saves the cookies as it shuts down: give it time before forcing it.
          graceMs = 20_000
          await cdp.send('Browser.close').catch(() => undefined)
          return list
        }
        // Closing the last window may leave the browser running in the background: that still means "closed".
        const { targetInfos } = await unlessAborted(cdp.send<{ targetInfos: { type: string }[] }>('Target.getTargets'), signal, canceled)
        if (!targetInfos.some((t) => t.type === 'page')) throw closedEarly()
      }
    } catch (e) {
      if (signal?.aborted) throw canceled()
      // The browser went away mid-question: the window was closed, or Edge crashed or was ended.
      if (e instanceof BrowserGone || exited) {
        await Promise.race([gone, sleep(3000)])
        throw up ? closedEarly() : couldntOpen()
      }
      throw e
    } finally {
      // Close it gently first (a killed browser offers to "restore pages" next time), then make sure it's gone:
      // the profile must be free again before OneDraft opens it.
      if (!exited && graceMs === 0 && cdp.alive) {
        await cdp.send('Browser.close', {}, 3000).catch(() => undefined)
        graceMs = 3000
      }
      await Promise.race([gone, sleep(graceMs)])
      cdp.close()
      if (!exited) child.kill()
      await Promise.race([gone, sleep(5000)])
    }
  }

  /**
   * Sign the account out of OneDraft: close its browser and delete its profile (the cookies are the sign-in).
   * Posts still waiting in its window keep that window until the person closes them; the profile goes then.
   * Either way the profile never opens again.
   */
  async forget(key: string): Promise<void> {
    this.checkKey(key)
    if (this.signingIn.has(key)) throw new Error('A sign-in window for this account is open. Close it first.')
    this.forgotten.add(key)
    await this.opening.get(key)?.catch(() => undefined)
    await this.closing.get(key)
    const open = this.open.get(key)
    if (open && !open.headless && open.leases > 0) {
      open.forget = true
      return
    }
    if (open) await this.shut(key, open)
    await this.remove(key)
  }

  /** Delete a profile folder without holding up the app (files can stay locked for a moment after a browser exits). */
  private async remove(key: string) {
    await rm(join(this.profilesDir, key), { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }).catch(() => undefined)
  }

  /** Is any of OneDraft's own browsers open (a post waiting in its window, a check running)? */
  hasWindows(): boolean {
    return this.open.size > 0 || this.opening.size > 0
  }

  async closeAll() {
    await Promise.all([...this.open].map(([key, e]) => this.shut(key, e)))
    this.open.clear()
  }
}
