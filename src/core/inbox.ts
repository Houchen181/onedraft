// The Inbox: comments on the person's posts from every platform that lets OneDraft read them, answered in
// place, plus the numbers (views, likes...) of what was published.
//
// Reading is safe, so it happens by itself: when the Inbox opens, on "Check now" and in the background.
// Sending a reply always comes from the person: their click in the Inbox, or their OK on an approval card.
// Platforms that bill per read (X) only fetch what OneDraft hasn't seen yet.

import type { Account, Comment, InboxComment, InboxProblem, InboxStatus, Target, TargetStats } from '../shared/types'
import { NeedsLoginError, RetryableError } from './connector'
import type { Engine } from './engine'

/** A comment that is already older than this when OneDraft first sees it doesn't wait for an answer. */
export const OLD_COMMENT_DAYS = 14
/** Stats refreshes without a list cover posts that went out in this many days. */
export const STATS_DAYS = 30

// ---------------------------------------------------------------- stats names

/** Each platform's own names for the same numbers. */
const ALIASES: Record<string, string> = {
  views: 'views',
  view: 'views',
  viewCount: 'views',
  view_count: 'views',
  plays: 'views',
  play_count: 'views',
  impressions: 'views',
  impression_count: 'views',
  likes: 'likes',
  like: 'likes',
  likeCount: 'likes',
  like_count: 'likes',
  comments: 'comments',
  commentCount: 'comments',
  comment_count: 'comments',
  replies: 'comments',
  reply: 'comments',
  replyCount: 'comments',
  reply_count: 'comments',
  shares: 'shares',
  share: 'shares',
  shareCount: 'shares',
  share_count: 'shares',
  reposts: 'shares',
  repost_count: 'shares',
  retweet_count: 'shares',
  saves: 'saves',
  saved: 'saves',
  bookmarks: 'saves',
  bookmark_count: 'saves',
  favorite: 'saves',
  favorites: 'saves',
  favoriteCount: 'saves',
  favorite_count: 'saves',
  quote_count: 'quotes',
  coin: 'coins',
  coins: 'coins'
}

/** Numbers a platform returns that aren't engagement (always zero, or a sum of the others). */
const IGNORE: Record<string, string[]> = {
  youtube: ['favoriteCount', 'dislikeCount'],
  bilibili: ['dislike', 'vt', 'vv', 'evaluation', 'argue_msg'],
  instagram: ['total_interactions']
}

/** Ids and ranks look like numbers but aren't counts (Bilibili's stats include the video's aid). */
const notACount = (key: string) => /^(id|aid|cid|bvid|mid)$/i.test(key) || /(_id|Id)$/.test(key) || /rank/i.test(key)

/** Put a platform's raw numbers under OneDraft's common names; extras (coins, quotes, reach) keep theirs. */
export function normalizeStats(platform: string, raw: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  const skip = new Set(IGNORE[platform] ?? [])
  for (const [key, v] of Object.entries(raw ?? {})) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    if (!Number.isFinite(n) || skip.has(key) || notACount(key)) continue
    const name = ALIASES[key] ?? key
    // Two raw names for one number (views and impressions): the first one wins.
    if (!(name in out)) out[name] = n
  }
  return out
}

// ---------------------------------------------------------------- the inbox

export interface CheckResult {
  /** Comments seen for the first time that are waiting for an answer. */
  added: InboxComment[]
  problems: InboxProblem[]
}

const isError = (e: unknown, cls: { prototype: Error }, name: string) => e instanceof (cls as never) || (e as Error)?.name === name

export class Inbox {
  lastCheckedAt?: string
  problems: InboxProblem[] = []
  private running?: Promise<CheckResult>
  /** Rate-limited accounts: background checks leave them alone until this time (ms). */
  private notBefore = new Map<string, number>()
  private sending = new Set<string>()
  private statsInFlight = new Set<string>()

  constructor(
    private engine: Engine,
    private opts: { everyMin?: () => number; onChange?: () => void } = {}
  ) {
    // Remembered across restarts, so the background schedule and "Checked 2 h ago" carry on.
    const last = engine.store.getSetting('inbox.lastCheckedAt')
    if (typeof last === 'string') this.lastCheckedAt = last
  }

  private name(platform: string) {
    return this.engine.registry.has(platform) ? this.engine.connector(platform).manifest.name : platform
  }

  /** Connected accounts on platforms whose comments OneDraft can read. */
  accounts(): Account[] {
    return this.engine.store.listAccounts().filter((a) => {
      if (!this.engine.registry.has(a.platform)) return false
      const c = this.engine.connector(a.platform)
      return !!c.listComments && c.manifest.capabilities.comments
    })
  }

  status(): InboxStatus {
    return {
      checking: !!this.running,
      lastCheckedAt: this.lastCheckedAt,
      everyMin: this.opts.everyMin?.() ?? 0,
      problems: this.problems,
      open: this.engine.store.countOpenComments()
    }
  }

  /** Look for new comments on every account. One check at a time: callers during a check share it. */
  check(opts: { background?: boolean } = {}): Promise<CheckResult> {
    if (this.running) return this.running
    const run = this.runCheck(!!opts.background).finally(() => {
      this.running = undefined
      this.opts.onChange?.()
    })
    this.running = run
    this.opts.onChange?.()
    return run
  }

  private async runCheck(background: boolean): Promise<CheckResult> {
    const added: InboxComment[] = []
    const problems: InboxProblem[] = []
    await Promise.all(
      this.accounts().map(async (a) => {
        if (a.status === 'needs_login') {
          problems.push({ accountId: a.id, platform: a.platform, message: `Reconnect ${this.name(a.platform)} to see its new comments.`, needsLogin: true })
          return
        }
        const wait = this.notBefore.get(a.id)
        if (background && wait && wait > Date.now()) {
          const earlier = this.problems.find((p) => p.accountId === a.id)
          if (earlier) problems.push(earlier)
          return
        }
        try {
          added.push(...(await this.checkAccount(a)))
          this.notBefore.delete(a.id)
        } catch (e) {
          problems.push(this.problemFor(a, e))
        }
      })
    )
    this.problems = problems
    this.lastCheckedAt = new Date().toISOString()
    this.engine.store.setSetting('inbox.lastCheckedAt', this.lastCheckedAt)
    return { added: added.filter((c) => c.state === 'open'), problems }
  }

  private async checkAccount(a: Account): Promise<InboxComment[]> {
    const c = this.engine.connector(a.platform)
    const ctx = this.engine.makeContext(a.platform, a, a.id)
    const perPost = c.manifest.capabilities.commentsPerPost
    if (!perPost) return this.save(a, (await c.listComments!(ctx, a, { limit: 50 })) ?? [])
    // One post at a time, keeping what came in before a later one fails.
    const added: InboxComment[] = []
    const since = new Date(Date.now() - perPost.days * 86400_000)
    for (const t of this.engine.store.liveTargets({ accountId: a.id, since, limit: 50 })) {
      const sinceId = this.engine.store.commentCursor(a.id, t.remoteId!)
      const list = (await c.listComments!(ctx, a, { remoteId: t.remoteId, limit: 50, sinceId })) ?? []
      added.push(...this.save(a, list.map((x) => ({ ...x, postRemoteId: x.postRemoteId ?? t.remoteId }))))
      // Past the account's own replies too, so they aren't fetched (and billed) again.
      this.engine.store.advanceCommentCursor(a.id, t.remoteId!, list)
    }
    return added
  }

  /** Keep comments a platform returned, leaving out the account's own. Returns the ones seen for the first time. */
  save(a: Account, comments: Comment[]): InboxComment[] {
    const handle = a.handle?.replace(/^@/, '').toLowerCase()
    const theirs = comments.filter((c) => c && !c.mine && !(handle && String(c.author ?? '').replace(/^@/, '').toLowerCase() === handle))
    return this.engine.store.saveComments(a, theirs, { oldAfterDays: OLD_COMMENT_DAYS })
  }

  private problemFor(a: Account, e: unknown): InboxProblem {
    const name = this.name(a.platform)
    const message = (e as Error)?.message ?? String(e)
    if (isError(e, NeedsLoginError, 'NeedsLoginError')) {
      this.engine.store.setAccountStatus(a.id, 'needs_login', message)
      return { accountId: a.id, platform: a.platform, message: `${name}: the login expired. Reconnect it to see new comments.`, needsLogin: true }
    }
    if (isError(e, RetryableError, 'RetryableError')) {
      this.notBefore.set(a.id, Date.now() + ((e as RetryableError).retryAfterSec ?? 900) * 1000)
      return { accountId: a.id, platform: a.platform, message: `${name} is limiting requests right now; OneDraft will look again later.` }
    }
    return { accountId: a.id, platform: a.platform, message: `${name}: ${message}` }
  }

  /** Send a reply the person wrote (or approved) and remember it on the comment. */
  async reply(key: string, text: string): Promise<InboxComment> {
    const body = text.trim()
    if (!body) throw new Error('Write a reply first.')
    const comment = this.engine.store.getComment(key)
    if (!comment) throw new Error('That comment is no longer in the Inbox.')
    const a = this.engine.mustAccount(comment.accountId)
    const c = this.engine.connector(a.platform)
    if (!c.reply || !c.manifest.capabilities.reply) throw new Error(`${c.manifest.name} replies are not available through OneDraft.`)
    // A double click must not answer twice.
    if (this.sending.has(key)) throw new Error('Already sending a reply to this comment.')
    this.sending.add(key)
    try {
      const r = await c.reply(this.engine.makeContext(a.platform, a, a.id), a, { commentId: comment.id, remoteId: comment.postRemoteId, text: body })
      this.engine.store.recordReply(key, { text: body, id: r?.id })
      this.engine.store.log('info', `Replied on ${c.manifest.name} to ${comment.author}`, a.id)
      return this.engine.store.getComment(key)!
    } catch (e) {
      if (isError(e, NeedsLoginError, 'NeedsLoginError')) this.engine.store.setAccountStatus(a.id, 'needs_login', (e as Error).message)
      throw e
    } finally {
      this.sending.delete(key)
    }
  }

  /** Can this target have numbers yet? Live on its platform, with an id, on a platform that reports them. */
  hasStats(t: Target): boolean {
    if (!t.remoteId || !this.engine.registry.has(t.platform)) return false
    const live = t.status === 'published' || (t.status === 'scheduled' && !!t.scheduledAt && new Date(t.scheduledAt).getTime() <= Date.now())
    const c = this.engine.connector(t.platform)
    return live && !!c.stats && c.manifest.capabilities.stats
  }

  /**
   * Read fresh numbers for these targets (default: everything that went out in the last STATS_DAYS days).
   * Platforms run side by side, one request at a time each.
   */
  async refreshStats(targetIds?: string[]): Promise<{ updated: number; failed: number; stats: TargetStats[] }> {
    const store = this.engine.store
    const targets = (targetIds ? targetIds.map((id) => store.getTarget(id)) : store.liveTargets({ since: new Date(Date.now() - STATS_DAYS * 86400_000), limit: 60 }))
      .filter((t): t is Target => !!t && this.hasStats(t) && !this.statsInFlight.has(t.id))
    const byPlatform = new Map<string, Target[]>()
    for (const t of targets) byPlatform.set(t.platform, [...(byPlatform.get(t.platform) ?? []), t])
    let updated = 0
    let failed = 0
    for (const t of targets) this.statsInFlight.add(t.id)
    try {
      await Promise.all(
        [...byPlatform.values()].map(async (list) => {
          for (const t of list) {
            const a = store.getAccount(t.accountId)
            if (!a) continue
            const c = this.engine.connector(t.platform)
            try {
              const raw = await c.stats!(this.engine.makeContext(a.platform, a, a.id), a, t.remoteId!)
              store.setStats(t.id, normalizeStats(t.platform, raw as Record<string, unknown>))
              updated++
            } catch (e) {
              failed++
              store.setStats(t.id, undefined, (e as Error)?.message ?? String(e))
              if (isError(e, NeedsLoginError, 'NeedsLoginError')) {
                store.setAccountStatus(a.id, 'needs_login', (e as Error).message)
                break
              }
            }
          }
        })
      )
    } finally {
      for (const t of targets) this.statsInFlight.delete(t.id)
    }
    return { updated, failed, stats: targets.map((t) => store.getStats(t.id)).filter((s): s is TargetStats => !!s) }
  }
}
