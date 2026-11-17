// The engine: accounts, posts, approval, and the publish state machine.
//
// Target lifecycle:  draft -> queued -> publishing -> published | scheduled | handoff
//                                               \-> failed (retry by hand)
//                                               \-> unconfirmed (never re-sent automatically)
//                    queued -> (retryable error) -> queued with backoff
//
// Rules borrowed from the tools we studied:
//  - never re-send something a platform may have accepted (Postiz's "unconfirmed")
//  - typed errors decide retries (Postiz/Mixpost), backoff carries the next attempt time
//  - prefer native scheduling: upload early, let the platform publish (social-auto-upload)

import { rmSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Account, Issue, MediaInfo, Post, PostDraft, Target, TargetStatus, Variant } from '../shared/types'
import {
  CanceledError,
  ContentError,
  NeedsLoginError,
  RetryableError,
  UnconfirmedError,
  VerificationRequiredError,
  type Connector,
  type ConnectorContext
} from './connector'
import { probe, type MediaTools } from './media'
import type { Registry } from './registry'
import type { Store } from './store'
import { resolveContent, validateContent, withOptionDefaults } from './validate'

export interface ContextFactory {
  (platform: string, account: Account | undefined, scope?: string, signal?: AbortSignal): ConnectorContext & {
    /** Secrets written during connect() before the account exists. */
    pendingSecrets(): unknown
  }
}

/** Upload early with the platform's own scheduler when the post is at least this far out. */
const NATIVE_SCHEDULE_MIN_LEAD_MS = 20 * 60_000
const MAX_ATTEMPTS = 5

/** Can this platform hold the post itself, given how far ahead it is? */
function nativeScheduleFits(c: Connector, leadMs: number, minLeadMs = NATIVE_SCHEDULE_MIN_LEAD_MS): boolean {
  const caps = c.manifest.capabilities
  if (!caps.nativeSchedule) return false
  const w = caps.scheduleWindow
  const min = Math.max(minLeadMs, (w?.minSec ?? 0) * 1000)
  const max = (w?.maxSec ?? 365 * 86400) * 1000
  return leadMs >= min && leadMs <= max
}

/** Is `file` inside `folder` (not merely a path that starts with the same letters)? */
function insideFolder(folder: string | undefined, file: string): boolean {
  if (!folder) return false
  const rel = relative(resolve(folder), resolve(file))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** An error's text for people: no terminal colour codes, and no browser call log or launch dump after it. */
const forPeople = (message: string) =>
  message
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\n\s*(?:Call log:|Browser logs:)/)[0]
    .trim()

/** Connectors (plugins especially) may throw strings or plain objects; keep their name and message. */
function asError(e: unknown): Error {
  if (e instanceof Error) return e
  if (e && typeof e === 'object' && 'message' in e) {
    const err = new Error(String((e as { message: unknown }).message))
    Object.assign(err, e)
    return err
  }
  return new Error(typeof e === 'string' ? e : JSON.stringify(e) ?? String(e))
}

export class Engine {
  private running = new Set<string>()
  private busyAccounts = new Set<string>()
  private aborts = new Map<string, AbortController>()
  maxConcurrent = 2

  constructor(
    public store: Store,
    public registry: Registry,
    public makeContext: ContextFactory,
    public mediaTools: MediaTools
  ) {}

  connector(platform: string): Connector {
    return this.registry.get(platform)
  }

  // ---------- accounts ----------

  async connect(platform: string, input: Record<string, string>, signal?: AbortSignal): Promise<Account> {
    const c = this.connector(platform)
    // "Sign in with your browser" asks only for its own fields (the same test the connectors use to pick the way).
    const viaWeb = !!c.manifest.web && (input.method === 'web' || (!input.method && !!input._profileKey))
    for (const f of viaWeb ? (c.manifest.web?.fields ?? []) : c.manifest.connectFields) {
      if (f.required && !input[f.key]?.trim()) throw new Error(`${f.label} is required.`)
    }
    const ctx = this.makeContext(platform, undefined, `connect:${platform}`, signal)
    // OneDraft keeps one account per platform: this one replaces it.
    const before = this.store.listAccounts().find((a) => a.platform === platform)
    const r = await c.connect(ctx, input)
    const account = this.store.upsertAccount({
      platform,
      remoteUserId: r.remoteUserId,
      name: r.name,
      handle: r.handle,
      avatarUrl: r.avatarUrl,
      meta: r.meta
    })
    this.store.setAccountSecret(account.id, r.secrets ?? ctx.pendingSecrets())
    this.store.log('info', `Connected ${c.manifest.name} account ${r.name}`, account.id)
    // What the replaced account signed in with still holds its sign-in: its browser profile, its saved login file.
    const oldProfile = before?.meta.profileKey
    if (typeof oldProfile === 'string' && oldProfile !== r.meta?.profileKey) {
      await ctx.forgetBrowser?.(oldProfile).catch((e: Error) => this.store.log('warn', `Couldn’t delete the previous sign-in’s browser profile: ${e.message}`, account.id))
    }
    const oldFile = before?.meta.cookieFile
    if (typeof oldFile === 'string' && oldFile !== r.meta?.cookieFile && insideFolder(ctx.paths?.data, oldFile)) {
      try {
        rmSync(oldFile, { force: true })
      } catch (e) {
        this.store.log('warn', `Couldn’t delete the previous sign-in’s login file: ${(e as Error).message}`, account.id)
      }
    }
    return account
  }

  async checkAccount(id: string): Promise<Account> {
    const account = this.mustAccount(id)
    const c = this.connector(account.platform)
    if (!c.check) return account
    try {
      const r = await c.check(this.makeContext(account.platform, account, account.id), account)
      this.store.setAccountStatus(id, r.ok ? 'connected' : 'needs_login', r.note)
    } catch (e) {
      const is = (name: string) => (e as Error)?.name === name
      // Busy right now (its browser is in use, a rate limit): says nothing about the account.
      if (e instanceof RetryableError || is('RetryableError')) {
        this.store.log('info', `Couldn’t check ${account.name} now: ${(e as Error).message}`, id)
        return this.mustAccount(id)
      }
      const needs = e instanceof NeedsLoginError || is('NeedsLoginError')
      this.store.setAccountStatus(id, needs ? 'needs_login' : 'error', (e as Error).message)
    }
    return this.mustAccount(id)
  }

  /** Accounts being disconnected: their posts don't start meanwhile. */
  private removing = new Set<string>()

  async removeAccount(id: string) {
    const account = this.mustAccount(id)
    const c = this.registry.has(account.platform) ? this.connector(account.platform) : undefined
    this.removing.add(id)
    try {
      try {
        await c?.disconnect?.(this.makeContext(account.platform, account, account.id), account)
      } catch (e) {
        this.store.log('warn', `Disconnect: ${(e as Error).message}`, id)
      }
      // What was on its way through this account can't go out from here any more: say so on each post.
      const name = c?.manifest.name ?? account.platform
      this.store.markTargets([
        ...this.store.targetsOfAccount(id, ['handoff']).map((t) => ({
          id: t.id,
          error: `${name} was disconnected. If the post’s window is still open, you can still press Post there.`
        })),
        ...this.store.targetsOfAccount(id, ['queued']).map((t) => ({
          id: t.id,
          status: 'failed' as const,
          error: `${name} was disconnected before this went out.`,
          clearNext: true
        }))
      ])
      this.store.removeAccount(id)
    } finally {
      this.removing.delete(id)
    }
  }

  mustAccount(id: string): Account {
    const a = this.store.getAccount(id)
    if (!a) throw new Error(`Unknown account ${id}`)
    return a
  }

  // ---------- posts ----------

  /** Set by the app: true for files rendered from AI compositions (they must carry the AI label). */
  isAiMedia?: (path: string) => boolean

  savePost(d: PostDraft): Post {
    const media = [...d.media, ...d.targets.flatMap((t) => t.variant.media ?? [])]
    const aiGenerated = d.aiGenerated || (!!this.isAiMedia && media.some((m) => this.isAiMedia!(m)))
    return this.store.savePost({ ...d, aiGenerated }, (accountId) => this.store.getAccount(accountId)?.platform)
  }

  /** Change one target's variant, keeping the post's AI label right if AI media was added. */
  updateVariant(targetId: string, patch: Variant): Target {
    const t = this.store.updateTargetVariant(targetId, patch)
    const post = this.mustPost(t.postId)
    if (!post.aiGenerated && this.isAiMedia && (t.variant.media ?? []).some((m) => this.isAiMedia!(m))) {
      this.savePost({
        id: post.id,
        title: post.title,
        body: post.body,
        tags: post.tags,
        media: post.media,
        aiGenerated: true,
        scheduledAt: post.scheduledAt,
        targets: post.targets.map((x) => ({ accountId: x.accountId, variant: x.variant }))
      })
    }
    return this.store.getTarget(targetId)!
  }

  mustPost(id: string): Post {
    const p = this.store.getPost(id)
    if (!p) throw new Error(`Unknown post ${id}`)
    return p
  }

  async probeAll(paths: string[]): Promise<{ infos: MediaInfo[]; issues: Issue[] }> {
    const infos: MediaInfo[] = []
    const issues: Issue[] = []
    for (const p of paths) {
      try {
        infos.push(await probe(this.mediaTools, p))
      } catch (e) {
        issues.push({ level: 'error', field: 'media', message: (e as Error).message })
      }
    }
    return { infos, issues }
  }

  async validateTarget(post: Post, t: Target): Promise<Issue[]> {
    if (!this.registry.has(t.platform)) return [{ level: 'error', field: 'platform', message: `No connector for ${t.platform}.` }]
    const c = this.connector(t.platform)
    const content = withOptionDefaults(c.manifest, resolveContent(post, t))
    const { infos, issues } = await this.probeAll(content.media)
    const opts = content.options
    const account = this.store.getAccount(t.accountId)
    // An account signed in on the website posts through the site's own page, where the person makes these choices.
    const web = account?.meta.method === 'web'
    for (const f of c.manifest.options) {
      if (f.required && !web && (opts[f.key] === undefined || opts[f.key] === '')) {
        issues.push({ level: 'error', field: `options.${f.key}`, message: `Choose ${f.label} for ${c.manifest.name}.` })
      }
    }
    if (!account) issues.push({ level: 'error', field: 'account', message: 'Account was removed.' })
    else if (account.status !== 'connected')
      issues.push({ level: 'warning', field: 'account', message: `${account.name} needs to be reconnected.` })
    // The website takes other media than the API: its limits replace the API's, group by group.
    const webLimits = web ? c.manifest.web?.constraints : undefined
    const manifest = webLimits
      ? {
          ...c.manifest,
          constraints: Object.fromEntries(
            Object.keys({ ...c.manifest.constraints, ...webLimits }).map((k) => {
              const key = k as keyof typeof webLimits
              return [k, webLimits[key] ? { ...(c.manifest.constraints[key] ?? {}), ...webLimits[key] } : c.manifest.constraints[key]]
            })
          )
        }
      : c.manifest
    return [...issues, ...validateContent(manifest, content, infos, { web }), ...(c.validate?.(content, account) ?? [])]
  }

  async validatePost(id: string): Promise<Record<string, Issue[]>> {
    const post = this.mustPost(id)
    const out: Record<string, Issue[]> = {}
    for (const t of post.targets) out[t.id] = await this.validateTarget(post, t)
    if (!post.targets.length) out['_'] = [{ level: 'error', field: 'targets', message: 'Pick at least one account.' }]
    return out
  }

  /**
   * Approve a post: queue every draft target. `publishAt` (ISO) schedules it; omitted = now.
   * Throws if any target has blocking issues, listing them.
   */
  async approve(id: string, publishAt?: string): Promise<Post> {
    const post = this.mustPost(id)
    const when = publishAt ? new Date(publishAt) : undefined
    if (when && Number.isNaN(when.getTime())) throw new Error(`Bad publish time "${publishAt}"`)
    // A time more than a few minutes gone is a mistake (wrong day or year), not "post now".
    if (when && when.getTime() < Date.now() - 5 * 60_000)
      throw new Error(`${when.toLocaleString()} has already passed. Pick a later time, or clear it to publish now.`)
    const drafts = post.targets.filter((t) => t.status === 'draft' || t.status === 'canceled')
    if (!drafts.length) throw new Error('Nothing to approve: no draft targets on this post.')
    const problems: string[] = []
    for (const t of drafts) {
      const errs = (await this.validateTarget(post, t)).filter((i) => i.level === 'error')
      if (errs.length) problems.push(`${t.platform}: ${errs.map((e) => e.message).join(' ')}`)
    }
    if (problems.length) throw new Error(`Fix these first:\n${problems.join('\n')}`)
    let queued = 0
    for (const t of drafts) {
      // Checked again after the (slow) validation: a second approve or a cancel may have moved it on meanwhile,
      // and queueing a target that already went out would post it twice.
      if (this.store.getTarget(t.id)?.status !== t.status) continue
      queued++
      const c = this.connector(t.platform)
      const lead = when ? when.getTime() - Date.now() : 0
      // Native scheduling: start the upload now; otherwise wait until the publish time.
      const startAt = when && !nativeScheduleFits(c, lead) ? when : new Date()
      this.store.setTarget(t.id, {
        status: 'queued',
        scheduledAt: when?.toISOString() ?? null,
        error: null,
        attempts: 0,
        nextAttemptAt: startAt.toISOString()
      })
    }
    if (!queued) throw new Error('This post was already approved.')
    // The post's own time follows what was approved, so lists and the calendar show the real time.
    this.store.setPostSchedule(id, when?.toISOString() ?? null)
    this.store.log('info', `Approved "${post.title || post.body.slice(0, 40)}" for ${drafts.length} account(s)${when ? ` for ${when.toLocaleString()}` : ''}`, id)
    return this.mustPost(id)
  }

  cancel(id: string): Post {
    const post = this.mustPost(id)
    for (const t of post.targets) {
      if (t.status === 'queued' || t.status === 'draft') this.store.setTarget(t.id, { status: 'canceled', nextAttemptAt: null })
      if (t.status === 'publishing') this.aborts.get(t.id)?.abort()
    }
    return this.mustPost(id)
  }

  /** Targets the platform itself holds for later: OneDraft can't take them back, only the platform can. */
  heldByPlatform(post: Post): Target[] {
    return post.targets.filter((t) => t.status === 'scheduled' && (!t.scheduledAt || new Date(t.scheduledAt).getTime() > Date.now()))
  }

  /** Delete a post from OneDraft. Refused while it is publishing: the result must land somewhere. */
  removePost(id: string) {
    const post = this.mustPost(id)
    if (post.targets.some((t) => t.status === 'publishing'))
      throw new Error('This post is publishing right now. Wait for it to finish, then delete it.')
    const held = this.heldByPlatform(post)
    if (held.length)
      throw new Error(
        `This post is already scheduled on ${held.map((t) => this.registry.has(t.platform) ? this.connector(t.platform).manifest.name : t.platform).join(', ')} and will go out from there. ` +
          'Remove it on the platform first; OneDraft keeps it here until its time has passed so you can find it.'
      )
    this.cancel(id)
    this.store.removePost(id)
  }

  /** Retry a failed target. Unconfirmed ones need `force` because they may already be live. */
  retry(targetId: string, force = false) {
    const t = this.store.getTarget(targetId)
    if (!t) throw new Error(`Unknown target ${targetId}`)
    if (t.status === 'unconfirmed' && !force)
      throw new Error('This one may already be live. Check the platform first, then retry with force to post it again.')
    if (!['failed', 'unconfirmed', 'canceled', 'handoff'].includes(t.status)) throw new Error(`Cannot retry a ${t.status} target.`)
    this.store.setTarget(targetId, { status: 'queued', error: null, attempts: 0, nextAttemptAt: new Date().toISOString() })
  }

  /** Called once at startup: anything left "publishing" may have gone through. */
  recover() {
    const changes: { id: string; status?: TargetStatus; error: string | null; clearNext?: boolean }[] = []
    for (const t of this.store.stuckTargets()) {
      // On a website OneDraft only fills the post in: it went nowhere unless the person pressed Post themselves.
      if (this.store.getAccount(t.accountId)?.meta.method === 'web') {
        changes.push({ id: t.id, status: 'failed', error: 'OneDraft was closed while it filled this in, so it wasn’t posted (unless you pressed Post there yourself). Press Retry.', clearNext: true })
        this.store.log('warn', 'Interrupted while filling in a post on a website; nothing was sent', t.postId)
        continue
      }
      changes.push({ id: t.id, status: 'unconfirmed', error: 'OneDraft closed while this was publishing. Check the platform before retrying.' })
      this.store.log('warn', 'Interrupted while publishing; marked unconfirmed', t.postId)
    }
    // A post handed over in OneDraft's browser window (website accounts, Rednote) lost that window on quitting.
    const gone = 'OneDraft was closed, and the browser window with this post closed with it.'
    for (const t of this.store.targetsByStatus('handoff')) {
      if (!this.store.getAccount(t.accountId)?.meta.profileKey || t.error?.startsWith(gone)) continue
      changes.push({ id: t.id, error: `${gone} If you didn’t press Post there, press “Post again”.` })
    }
    this.store.markTargets(changes)
  }

  // ---------- publishing ----------

  /** Start every due target, within concurrency limits. Returns the ids started. */
  tick(): string[] {
    const started: string[] = []
    for (const t of this.store.dueTargets()) {
      if (this.running.size >= this.maxConcurrent) break
      if (this.running.has(t.id) || this.busyAccounts.has(t.accountId)) continue
      started.push(t.id)
      void this.publishTarget(t.id)
    }
    return started
  }

  async publishTarget(targetId: string): Promise<void> {
    const t = this.store.getTarget(targetId)
    if (!t || this.running.has(targetId)) return
    const post = this.store.getPost(t.postId)
    const account = this.store.getAccount(t.accountId)
    const scope = t.postId
    if (!post || !account || this.removing.has(account.id)) {
      this.store.setTarget(targetId, { status: 'failed', error: 'Post or account no longer exists.' })
      return
    }
    // Too early to post and the platform can't hold it (e.g. a retry pushed us inside its window): wait.
    if (t.scheduledAt && this.registry.has(t.platform)) {
      const lead = new Date(t.scheduledAt).getTime() - Date.now()
      if (lead > 60_000 && !nativeScheduleFits(this.connector(t.platform), lead, 2 * 60_000)) {
        this.store.setTarget(targetId, { nextAttemptAt: t.scheduledAt })
        return
      }
    }
    this.running.add(targetId)
    this.busyAccounts.add(account.id)
    const abort = new AbortController()
    this.aborts.set(targetId, abort)
    const attempts = t.attempts + 1
    this.store.setTarget(targetId, { status: 'publishing', attempts, error: null })
    const label = this.labelOf(account)
    try {
      const c = this.connector(t.platform)
      const issues = (await this.validateTarget(post, t)).filter((i) => i.level === 'error' && i.field !== 'account')
      if (issues.length) throw new ContentError(issues.map((i) => i.message).join(' '))
      if (!this.store.getAccount(account.id) || this.removing.has(account.id)) throw new ContentError('The account was disconnected.')
      // Canceled while it was being checked: nothing has been sent, so it's a plain cancel.
      if (abort.signal.aborted) {
        this.store.setTarget(targetId, { status: 'canceled', error: null, nextAttemptAt: null })
        this.store.log('info', `Canceled before sending to ${label}`, scope)
        return
      }
      const content = withOptionDefaults(c.manifest, resolveContent(post, t))
      const lead = t.scheduledAt ? new Date(t.scheduledAt).getTime() - Date.now() : 0
      // The upload may run long; allow a smaller margin here than when deciding to start early.
      const publishAt = t.scheduledAt && nativeScheduleFits(c, lead, 2 * 60_000) ? t.scheduledAt : undefined
      this.store.log('info', `Publishing to ${label}${publishAt ? ` (scheduled on platform for ${publishAt})` : ''}`, scope)
      const ctx = this.makeContext(t.platform, account, scope, abort.signal)
      const r = await c.publish(ctx, account, { targetId, content, publishAt })
      const status = r.state === 'scheduled' ? 'scheduled' : r.state === 'handoff' ? 'handoff' : 'published'
      this.store.setTarget(targetId, { status, remoteId: r.remoteId ?? null, url: r.url ?? null, error: r.note ?? null, nextAttemptAt: null })
      if (this.store.getAccount(account.id)?.status === 'needs_login') this.store.setAccountStatus(account.id, 'connected')
      if (status === 'handoff' && r.closed) {
        const note = r.note ?? null
        void r.closed.then(
          (after) => {
            const now = this.store.getTarget(targetId)
            if (now?.status === 'handoff' && (now.error ?? null) === note) this.store.setTarget(targetId, { error: after })
          },
          () => undefined
        )
      }
      this.store.log('info', `${status === 'published' ? 'Published' : status === 'scheduled' ? 'Scheduled' : 'Ready for you to publish'} on ${label}${r.url ? `: ${r.url}` : ''}${r.note && !(r.url && r.note.includes(r.url)) ? `. ${r.note}` : ''}`, scope)
    } catch (e) {
      this.handleFailure(t, account, attempts, asError(e), abort.signal.aborted)
    } finally {
      this.running.delete(targetId)
      this.busyAccounts.delete(account.id)
      this.aborts.delete(targetId)
    }
  }

  /** "X (My account)" in events and notifications people read. */
  private labelOf(account: Account): string {
    const name = this.registry.has(account.platform) ? this.connector(account.platform).manifest.name : account.platform
    return name === account.name ? name : `${name} (${account.name})`
  }

  private handleFailure(t: Target, account: Account, attempts: number, e: Error, canceled: boolean) {
    const scope = t.postId
    const label = this.labelOf(account)
    // Plugins written in plain JS signal the kind by error name, so match on either.
    const is = (cls: { name: string; prototype: Error }, name: string) => e instanceof (cls as never) || e?.name === name
    if (canceled && is(CanceledError, 'CanceledError')) {
      this.store.setTarget(t.id, { status: 'canceled', error: null, nextAttemptAt: null })
      this.store.log('info', `Canceled before anything was sent to ${label}`, scope)
      return
    }
    if (canceled) {
      this.store.setTarget(t.id, { status: 'unconfirmed', error: 'Canceled mid-publish. Check the platform before retrying.' })
      this.store.log('warn', `Canceled while publishing to ${label}`, scope)
      return
    }
    e.message = forPeople(e.message)
    if (is(UnconfirmedError, 'UnconfirmedError')) {
      this.store.setTarget(t.id, { status: 'unconfirmed', error: e.message, remoteId: (e as UnconfirmedError).remoteId ?? null })
      this.store.log('warn', `${label}: ${e.message} (marked unconfirmed, will not re-send)`, scope)
      return
    }
    if (is(NeedsLoginError, 'NeedsLoginError')) {
      this.store.setAccountStatus(account.id, 'needs_login', e.message)
      this.store.setTarget(t.id, { status: 'failed', error: `Reconnect ${account.name}, then retry. ${e.message}` })
      this.store.log('error', `${label}: signed out; reconnect it, then retry`, scope)
      return
    }
    if (is(RetryableError, 'RetryableError') && attempts < MAX_ATTEMPTS) {
      const wait = ((e as RetryableError).retryAfterSec ?? 300) * 1000 * 2 ** (attempts - 1)
      const next = new Date(Date.now() + wait).toISOString()
      this.store.setTarget(t.id, { status: 'queued', error: `${e.message} (retrying at ${next})`, nextAttemptAt: next })
      this.store.log('warn', `${label}: ${e.message}; retry ${attempts}/${MAX_ATTEMPTS - 1} at ${next}`, scope)
      return
    }
    // Out of retries: "OneDraft will try again" no longer holds.
    if (is(RetryableError, 'RetryableError')) e.message = `${e.message.replace(/\s*OneDraft will try again[^.]*\./, '')} Press Retry to try again.`
    const kind = is(ContentError, 'ContentError')
      ? 'Content rejected'
      : is(VerificationRequiredError, 'VerificationRequiredError')
        ? 'Needs you'
        : is(RetryableError, 'RetryableError')
          ? `Failed after ${attempts} tries`
          : 'Failed'
    this.store.setTarget(t.id, { status: 'failed', error: `${kind}: ${e.message}`, nextAttemptAt: null })
    this.store.log('error', `${label}: ${kind}: ${e.message}`, scope)
  }

  isBusy() {
    return this.running.size > 0
  }
}
