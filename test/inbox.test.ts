// The Inbox (comments across platforms, replies, drafts) and post numbers (stats).

import { describe, expect, it, vi } from 'vitest'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { NeedsLoginError, RetryableError, type Connector, type ConnectorContext } from '../src/core/connector'
import { Engine, type ContextFactory } from '../src/core/engine'
import { Inbox, normalizeStats } from '../src/core/inbox'
import { Registry } from '../src/core/registry'
import { Store } from '../src/core/store'
import { runTool, type ToolEnv } from '../src/core/tools'
import type { Capabilities, Comment, PlatformManifest } from '../src/shared/types'

const tools = { ffmpeg: ffmpegStatic as string, ffprobe: ffprobeStatic.path }
const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString()

function manifest(id: string, caps: Partial<Capabilities> = {}): PlatformManifest {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'api',
    color: '#000',
    capabilities: { video: true, image: true, text: true, nativeSchedule: false, comments: true, reply: true, stats: true, ...caps },
    constraints: { caption: { max: 5000 } },
    settings: [],
    connectFields: [],
    options: [],
    notes: []
  }
}

type Extra = Partial<Pick<Connector, 'listComments' | 'reply' | 'stats'>> & { caps?: Partial<Capabilities> }

function rig(platforms: Record<string, Extra>) {
  const store = new Store(':memory:')
  const registry = new Registry()
  for (const [id, extra] of Object.entries(platforms)) {
    registry.register({
      manifest: manifest(id, extra.caps),
      async connect() {
        return { name: id, remoteUserId: id }
      },
      async publish() {
        return { state: 'published', remoteId: `${id}-1` }
      },
      listComments: extra.listComments,
      reply: extra.reply,
      stats: extra.stats
    })
  }
  const makeContext: ContextFactory = (_p, _a, _s, signal) =>
    ({ log: () => undefined, progress: () => undefined, pendingSecrets: () => undefined, signal }) as unknown as ConnectorContext & { pendingSecrets(): unknown }
  const engine = new Engine(store, registry, makeContext, tools)
  const accounts = Object.fromEntries(Object.keys(platforms).map((p) => [p, store.upsertAccount({ platform: p, remoteUserId: p, name: `${p} me`, handle: `@${p}_me` })]))
  return { store, engine, accounts, inbox: new Inbox(engine) }
}

/** A post with one target per platform, marked live on its platform with the given remote ids. */
function livePost(engine: Engine, store: Store, title: string, live: Record<string, { accountId: string; remoteId: string; daysAgo?: number }>) {
  const post = engine.savePost({ title, body: '', tags: [], media: [], aiGenerated: false, targets: Object.values(live).map((l) => ({ accountId: l.accountId, variant: {} })) })
  for (const t of post.targets) {
    const l = Object.values(live).find((x) => x.accountId === t.accountId)!
    store.setTarget(t.id, { status: 'published', remoteId: l.remoteId })
    if (l.daysAgo) store.db.prepare('update targets set updated_at = ? where id = ?').run(ago(l.daysAgo), t.id)
  }
  return engine.mustPost(post.id)
}

const env = (engine: Engine, inbox: Inbox, approve = true): ToolEnv => ({
  engine,
  inbox,
  mediaDir: '.',
  requestApproval: async () => approve,
  autoApprove: () => false,
  source: 'agent'
})

describe('normalizeStats', () => {
  it('puts every built-in platform under the common names', () => {
    expect(normalizeStats('youtube', { viewCount: '1200', likeCount: '85', favoriteCount: '0', commentCount: '12' })).toEqual({ views: 1200, likes: 85, comments: 12 })
    expect(normalizeStats('x', { retweet_count: 3, reply_count: 4, like_count: 50, quote_count: 1, bookmark_count: 2, impression_count: 900 })).toEqual({
      shares: 3,
      comments: 4,
      likes: 50,
      quotes: 1,
      saves: 2,
      views: 900
    })
    expect(normalizeStats('instagram', { views: 500, reach: 300, likes: 40, comments: 5, shares: 2, saved: 7, total_interactions: 54 })).toEqual({
      views: 500,
      reach: 300,
      likes: 40,
      comments: 5,
      shares: 2,
      saves: 7
    })
    expect(normalizeStats('tiktok', { id: '7312', view_count: 1000, like_count: 100, comment_count: 10, share_count: 5 })).toEqual({ views: 1000, likes: 100, comments: 10, shares: 5 })
  })
  it("drops Bilibili's video id, ranks and always-zero fields", () => {
    const s = normalizeStats('bilibili', { aid: 113000000, view: 2000, danmaku: 30, reply: 12, favorite: 40, coin: 25, share: 6, now_rank: 0, his_rank: 0, like: 150, dislike: 0, evaluation: '', vt: 0 })
    expect(s).toEqual({ views: 2000, danmaku: 30, comments: 12, saves: 40, coins: 25, shares: 6, likes: 150 })
  })
  it("keeps a plugin's own numbers but not its ids", () => {
    expect(normalizeStats('bluesky', { reposts: 2, followers_gained: 3, post_id: 99, label: 'x' })).toEqual({ shares: 2, followers_gained: 3 })
    expect(normalizeStats('bluesky', undefined)).toEqual({})
  })
})

describe('checking for comments', () => {
  it('saves new comments, leaves out the account’s own, and files old ones as done', async () => {
    let batch: Comment[] = [
      { id: 'c1', author: 'Ana', text: 'Love it', publishedAt: ago(0.1), likeCount: 2 },
      { id: 'c2', author: 'Bo', text: 'Old one', publishedAt: ago(20) },
      { id: 'c3', author: '@tube_me', text: 'my own reply, found by handle' },
      { id: 'c4', author: 'Me', text: 'my own, flagged by the platform', mine: true }
    ]
    const listComments = vi.fn(async () => batch)
    const { store, inbox, accounts } = rig({ tube: { listComments } })
    const first = await inbox.check()
    expect(listComments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: accounts.tube.id }), { limit: 50 })
    expect(first.added.map((c) => c.id)).toEqual(['c1'])
    expect(store.listComments().map((c) => [c.id, c.state])).toEqual([
      ['c1', 'open'],
      ['c2', 'done']
    ])
    expect(inbox.status().open).toBe(1)

    // You set c1 aside; the platform then reports new likes on it and one new comment.
    store.setCommentState([`${accounts.tube.id}:c1`], 'done')
    batch = [{ id: 'c1', author: 'Ana', text: 'Love it (edited)', publishedAt: ago(0.1), likeCount: 9 }, { id: 'c5', author: 'Cy', text: 'New!', publishedAt: ago(0) }]
    const second = await inbox.check()
    expect(second.added.map((c) => c.id)).toEqual(['c5'])
    const c1 = store.getComment(`${accounts.tube.id}:c1`)!
    expect([c1.state, c1.text, c1.likeCount]).toEqual(['done', 'Love it (edited)', 9])
    expect(inbox.lastCheckedAt).toBeTruthy()
    // A restart remembers when it last looked.
    expect(new Inbox(inbox['engine']).lastCheckedAt).toBe(inbox.lastCheckedAt)
  })

  it('asks per-post platforms about recent posts only, for replies newer than the ones it has', async () => {
    const calls: { remoteId?: string; sinceId?: string }[] = []
    const replies: Record<string, Comment[]> = {
      'T-new': [
        { id: '1007', author: '@chirp_me', text: 'Part 2 of my own thread', publishedAt: ago(0.1), mine: true },
        { id: '1005', author: 'Dee', text: 'First!', publishedAt: ago(0.2) }
      ]
    }
    const { store, engine, inbox, accounts } = rig({
      chirp: {
        caps: { commentsPerPost: { days: 7 } },
        listComments: async (_c, _a, o) => {
          calls.push({ remoteId: o.remoteId, sinceId: o.sinceId })
          return replies[o.remoteId!] ?? []
        }
      }
    })
    const post = livePost(engine, store, 'Fresh post', { chirp: { accountId: accounts.chirp.id, remoteId: 'T-new' } })
    livePost(engine, store, 'Old post', { chirp: { accountId: accounts.chirp.id, remoteId: 'T-old', daysAgo: 10 } })
    engine.savePost({ title: 'Draft', body: '', tags: [], media: [], aiGenerated: false, targets: [{ accountId: accounts.chirp.id, variant: {} }] })

    await inbox.check()
    expect(calls).toEqual([{ remoteId: 'T-new', sinceId: undefined }])
    const saved = store.getComment(`${accounts.chirp.id}:1005`)!
    expect([saved.postRemoteId, saved.postId, saved.targetId]).toEqual(['T-new', post.id, post.targets[0].id])
    expect(store.getComment(`${accounts.chirp.id}:1007`)).toBeUndefined()

    // Next time only replies after the newest one seen, the account's own included (X bills every read).
    replies['T-new'] = []
    await inbox.check()
    expect(calls[1]).toEqual({ remoteId: 'T-new', sinceId: '1007' })
    // An empty answer keeps the cursor where it was.
    await inbox.check()
    expect(calls[2]).toEqual({ remoteId: 'T-new', sinceId: '1007' })
  })

  it('marks an expired login, reports it, and still checks the other accounts', async () => {
    const { store, inbox, accounts } = rig({
      pics: { listComments: async () => Promise.reject(new NeedsLoginError('token revoked')) },
      tube: { listComments: async () => [{ id: 'k', author: 'Ed', text: 'hi', publishedAt: ago(0) }] }
    })
    const r = await inbox.check()
    expect(r.added.map((c) => c.id)).toEqual(['k'])
    expect(r.problems).toEqual([expect.objectContaining({ accountId: accounts.pics.id, needsLogin: true })])
    expect(store.getAccount(accounts.pics.id)!.status).toBe('needs_login')
    // From now on it isn't asked at all until it is reconnected.
    const again = await inbox.check()
    expect(again.problems[0]).toMatchObject({ accountId: accounts.pics.id, needsLogin: true })
  })

  it('leaves a rate-limited account alone in the background but tries again when asked', async () => {
    const listComments = vi.fn(async (): Promise<Comment[]> => Promise.reject(new RetryableError('429', 900)))
    const { inbox } = rig({ tube: { listComments } })
    await inbox.check()
    await inbox.check({ background: true })
    expect(listComments).toHaveBeenCalledTimes(1)
    expect(inbox.problems[0].message).toMatch(/limiting requests/)
    await inbox.check()
    expect(listComments).toHaveBeenCalledTimes(2)
  })

  it('runs one check at a time: callers during a check share it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const listComments = vi.fn(async () => {
      await gate
      return [{ id: 'z', author: 'Flo', text: 'yo', publishedAt: ago(0) }]
    })
    const changes = vi.fn()
    const { engine } = rig({ tube: { listComments } })
    const inbox = new Inbox(engine, { onChange: changes, everyMin: () => 30 })
    const a = inbox.check()
    const b = inbox.check({ background: true })
    expect(inbox.status()).toMatchObject({ checking: true, everyMin: 30 })
    release()
    expect(await a).toBe(await b)
    expect(listComments).toHaveBeenCalledTimes(1)
    expect(inbox.status().checking).toBe(false)
    expect(changes).toHaveBeenCalledTimes(2)
  })
})

describe('replying', () => {
  const setup = (reply: Connector['reply']) => {
    const r = rig({ tube: { listComments: async () => [{ id: 'q1', author: 'Gus', text: 'When is part 2?', publishedAt: ago(0), postRemoteId: 'V1' }], reply } })
    return { ...r, key: `${r.accounts.tube.id}:q1` }
  }

  it('sends the text, marks the comment answered and clears its draft', async () => {
    const reply = vi.fn(async () => ({ id: 'r9' }))
    const { inbox, store, key } = setup(reply)
    await inbox.check()
    store.setCommentDraft(key, 'Next week', 'claude')
    const c = await inbox.reply(key, '  Next Friday!  ')
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.anything(), { commentId: 'q1', remoteId: 'V1', text: 'Next Friday!' })
    expect(c).toMatchObject({ state: 'replied', reply: { text: 'Next Friday!', id: 'r9' } })
    expect(c.draft).toBeUndefined()
    expect(store.listEvents(5).some((e) => e.message.startsWith('Replied on TUBE to Gus'))).toBe(true)
  })

  it('refuses empty text and a second send while the first is in flight', async () => {
    let release!: () => void
    const reply = vi.fn(() => new Promise<{ id: string }>((r) => (release = () => r({ id: 'r1' }))))
    const { inbox, key } = setup(reply)
    await inbox.check()
    await expect(inbox.reply(key, '   ')).rejects.toThrow(/Write a reply/)
    const first = inbox.reply(key, 'Soon')
    await expect(inbox.reply(key, 'Soon')).rejects.toThrow(/Already sending/)
    release()
    await first
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it('keeps the comment open when the platform refuses the reply', async () => {
    const { inbox, store, key } = setup(async () => Promise.reject(new Error('Comment was deleted')))
    await inbox.check()
    await expect(inbox.reply(key, 'Hi')).rejects.toThrow(/deleted/)
    expect(store.getComment(key)!.state).toBe('open')
  })
})

describe('inbox tools', () => {
  it('lets Claude list waiting comments and save drafts without sending anything', async () => {
    const reply = vi.fn(async () => ({ id: 'x' }))
    const { store, engine, inbox, accounts } = rig({ tube: { listComments: async () => [{ id: 'm1', author: 'Hal', text: 'Where was this filmed?', publishedAt: ago(0), postRemoteId: 'tube-9' }], reply } })
    livePost(engine, store, 'Kyoto in autumn', { tube: { accountId: accounts.tube.id, remoteId: 'tube-9' } })
    await inbox.check()

    const listed = await runTool('list_inbox', {}, env(engine, inbox))
    expect(listed.result).toEqual([expect.objectContaining({ accountId: accounts.tube.id, commentId: 'm1', onPost: 'Kyoto in autumn', state: 'open' })])

    const saved = await runTool('draft_reply', { accountId: accounts.tube.id, commentId: 'm1', text: 'In Arashiyama!' }, env(engine, inbox))
    expect(saved.ok).toBe(true)
    expect(store.getComment(`${accounts.tube.id}:m1`)).toMatchObject({ draft: 'In Arashiyama!', draftBy: 'claude', state: 'open' })
    expect(reply).not.toHaveBeenCalled()

    const missing = await runTool('draft_reply', { accountId: accounts.tube.id, commentId: 'nope', text: 'x' }, env(engine, inbox))
    expect(missing).toMatchObject({ ok: false, result: { error: expect.stringMatching(/not in the Inbox/) } })
  })

  it('records replies sent with reply_comment, only after the person approves', async () => {
    const reply = vi.fn(async () => ({ id: 'sent-1' }))
    const { store, engine, inbox, accounts } = rig({ tube: { listComments: async () => [{ id: 'm2', author: 'Ivy', text: 'Nice', publishedAt: ago(0) }], reply } })
    await runTool('list_comments', { accountId: accounts.tube.id }, env(engine, inbox))
    const key = `${accounts.tube.id}:m2`
    expect(store.getComment(key)!.state).toBe('open')

    const declined = await runTool('reply_comment', { accountId: accounts.tube.id, commentId: 'm2', text: 'Thanks!' }, env(engine, inbox, false))
    expect(declined.result).toMatchObject({ sent: false })
    expect(reply).not.toHaveBeenCalled()

    const approved = await runTool('reply_comment', { accountId: accounts.tube.id, commentId: 'm2', text: 'Thanks!' }, env(engine, inbox, true))
    expect(approved.result).toEqual({ sent: true, id: 'sent-1' })
    expect(store.getComment(key)).toMatchObject({ state: 'replied', reply: { text: 'Thanks!' } })
  })
})

describe('post numbers', () => {
  it('refreshes live targets, keeps the last numbers when a refresh fails, and forgets them with the post', async () => {
    let fail = false
    const { store, engine, inbox, accounts } = rig({
      tube: { stats: async () => ({ viewCount: 10, likeCount: 2 }) },
      chirp: {
        stats: async () => {
          if (fail) throw new Error('quota')
          return { impression_count: 40, like_count: 4, reply_count: 1 }
        }
      },
      quiet: { caps: { stats: false } }
    })
    const post = livePost(engine, store, 'Launch', {
      tube: { accountId: accounts.tube.id, remoteId: 'v1' },
      chirp: { accountId: accounts.chirp.id, remoteId: 't1' },
      quiet: { accountId: accounts.quiet.id, remoteId: 'q1' }
    })
    const draft = engine.savePost({ title: 'Not out yet', body: '', tags: [], media: [], aiGenerated: false, targets: [{ accountId: accounts.tube.id, variant: {} }] })

    const r = await inbox.refreshStats()
    expect([r.updated, r.failed]).toEqual([2, 0])
    const byPlatform = (p: string) => store.getStats(post.targets.find((t) => t.platform === p)!.id)
    expect(byPlatform('tube')!.metrics).toEqual({ views: 10, likes: 2 })
    expect(byPlatform('chirp')!.metrics).toEqual({ views: 40, likes: 4, comments: 1 })
    expect(byPlatform('quiet')).toBeUndefined()
    expect(store.getStats(draft.targets[0].id)).toBeUndefined()

    fail = true
    const again = await inbox.refreshStats([post.targets.find((t) => t.platform === 'chirp')!.id])
    expect(again.failed).toBe(1)
    expect(byPlatform('chirp')).toMatchObject({ metrics: { views: 40, likes: 4, comments: 1 }, error: 'quota' })

    // get_stats answers with the common names too.
    fail = false
    const tool = await runTool('get_stats', { targetId: post.targets.find((t) => t.platform === 'chirp')!.id }, env(engine, inbox))
    expect(tool.result).toMatchObject({ views: 40, likes: 4, comments: 1 })
    expect(byPlatform('chirp')!.error).toBeUndefined()

    engine.removePost(post.id)
    expect(store.listStats()).toEqual([])
  })

  it('waits for a natively scheduled post to go live before reading its numbers', async () => {
    const stats = vi.fn(async () => ({ viewCount: 1 }))
    const { store, engine, inbox, accounts } = rig({ tube: { stats } })
    const post = engine.savePost({ title: 'Later', body: '', tags: [], media: [], aiGenerated: false, targets: [{ accountId: accounts.tube.id, variant: {} }] })
    const t = post.targets[0]
    store.setTarget(t.id, { status: 'scheduled', remoteId: 'v2', scheduledAt: new Date(Date.now() + 3600_000).toISOString() })
    expect((await runTool('get_stats', { targetId: t.id }, env(engine, inbox))).result).toEqual({ error: expect.stringMatching(/scheduled/) })
    store.setTarget(t.id, { scheduledAt: ago(0.01) })
    await inbox.refreshStats()
    expect(stats).toHaveBeenCalledTimes(1)
  })
})

describe('accounts and comments', () => {
  it("drops an account's comments when another person signs in on that platform", async () => {
    const { store, inbox, accounts } = rig({ tube: { listComments: async () => [{ id: 'p1', author: 'Jo', text: 'hey', publishedAt: ago(0) }] } })
    await inbox.check()
    store.upsertAccount({ platform: 'tube', remoteUserId: 'tube', name: 'same person again' })
    expect(store.listComments()).toHaveLength(1)
    const other = store.upsertAccount({ platform: 'tube', remoteUserId: 'someone-else', name: 'New person' })
    expect(other.id).toBe(accounts.tube.id)
    expect(store.listComments()).toEqual([])
    await inbox.check()
    store.removeAccount(accounts.tube.id)
    expect(store.listComments()).toEqual([])
  })
})
