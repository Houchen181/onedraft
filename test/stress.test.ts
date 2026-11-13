// Stress and edge-case tests for the publish engine, the store and the tool layer:
// floods of posts, random failures, concurrency limits, cancel/delete mid-publish, odd inputs.

import { describe, expect, it } from 'vitest'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { ContentError, NeedsLoginError, RetryableError, UnconfirmedError, type Connector, type ConnectorContext } from '../src/core/connector'
import { Engine, type ContextFactory } from '../src/core/engine'
import { Registry } from '../src/core/registry'
import { Store } from '../src/core/store'
import { runTool, type ToolEnv } from '../src/core/tools'
import type { PlatformManifest } from '../src/shared/types'

const tools = { ffmpeg: ffmpegStatic as string, ffprobe: ffprobeStatic.path }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function manifest(id: string, extra: Partial<PlatformManifest['capabilities']> = {}): PlatformManifest {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'api',
    color: '#000',
    capabilities: { video: true, image: true, text: true, nativeSchedule: false, comments: false, reply: false, stats: false, ...extra },
    constraints: { caption: { max: 5000 } },
    settings: [],
    connectFields: [],
    options: [],
    notes: []
  }
}

type Publish = Connector['publish']

function rig(platforms: string[], publish: (platform: string) => Publish) {
  const store = new Store(':memory:')
  const registry = new Registry()
  for (const p of platforms) {
    registry.register({
      manifest: manifest(p),
      async connect() {
        return { name: p, remoteUserId: p }
      },
      publish: (ctx, account, req) => publish(p)(ctx, account, req)
    })
  }
  const makeContext: ContextFactory = (_p, _a, _s, signal) =>
    ({ log: () => undefined, progress: () => undefined, pendingSecrets: () => undefined, signal }) as unknown as ConnectorContext & {
      pendingSecrets(): unknown
    }
  const engine = new Engine(store, registry, makeContext, tools)
  const accounts = platforms.map((p) => store.upsertAccount({ platform: p, remoteUserId: p, name: p }))
  return { store, engine, accounts }
}

const env = (engine: Engine, approve = true): ToolEnv => ({
  engine,
  mediaDir: '.',
  requestApproval: async () => approve,
  autoApprove: () => false,
  source: 'mcp'
})

describe('engine under load', () => {
  it('publishes 300 targets exactly once each with random failures, within the concurrency limits', async () => {
    const platforms = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']
    const sent = new Map<string, number>()
    let inFlight = 0
    let peak = 0
    const perAccount = new Map<string, number>()
    let accountClash = false
    let seed = 7
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const { store, engine } = rig(platforms, () => async (_ctx, account, req) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      perAccount.set(account.id, (perAccount.get(account.id) ?? 0) + 1)
      if (perAccount.get(account.id)! > 1) accountClash = true
      try {
        await sleep(rand() * 4)
        const r = rand()
        if (r < 0.15) throw new RetryableError('rate limited', 0)
        if (r < 0.2) throw new ContentError('rejected')
        if (r < 0.23) throw new UnconfirmedError('timed out after submit')
        sent.set(req.targetId, (sent.get(req.targetId) ?? 0) + 1)
        return { state: 'published', remoteId: req.targetId }
      } finally {
        inFlight--
        perAccount.set(account.id, perAccount.get(account.id)! - 1)
      }
    })
    engine.maxConcurrent = 3
    const accounts = store.listAccounts()
    const posts = []
    for (let i = 0; i < 50; i++) {
      const p = engine.savePost({ title: `Post ${i}`, body: `Body ${i} 🍁 こんにちは`, tags: [], media: [], aiGenerated: false, targets: accounts.map((a) => ({ accountId: a.id, variant: {} })) })
      await engine.approve(p.id)
      posts.push(p.id)
    }
    for (let round = 0; round < 2000; round++) {
      engine.tick()
      await sleep(1)
      const left = store.listPosts(1000).some((p) => p.targets.some((t) => t.status === 'queued' || t.status === 'publishing'))
      if (!left) break
    }
    const all = store.listPosts(1000).flatMap((p) => p.targets)
    expect(all).toHaveLength(300)
    expect(all.filter((t) => t.status === 'queued' || t.status === 'publishing')).toEqual([])
    for (const [, n] of sent) expect(n).toBe(1)
    for (const t of all.filter((t) => t.status === 'published')) expect(sent.get(t.id)).toBe(1)
    expect(peak).toBeLessThanOrEqual(3)
    expect(accountClash).toBe(false)
  }, 60_000)

  it('cancel mid-publish marks the target unconfirmed and frees the slot', async () => {
    const { store, engine, accounts } = rig(['a'], () => async (ctx) => {
      await new Promise((_r, reject) => ctx.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      return { state: 'published' }
    })
    const p = engine.savePost({ title: '', body: 'x', tags: [], media: [], aiGenerated: false, targets: [{ accountId: accounts[0].id, variant: {} }] })
    await engine.approve(p.id)
    engine.tick()
    await sleep(20)
    expect(store.getPost(p.id)!.targets[0].status).toBe('publishing')
    engine.cancel(p.id)
    await sleep(20)
    expect(store.getPost(p.id)!.targets[0].status).toBe('unconfirmed')
    expect(engine.isBusy()).toBe(false)
  })

  it('a post deleted while publishing does not crash or come back', async () => {
    let release!: () => void
    const { store, engine, accounts } = rig(['a'], () => async () => {
      await new Promise<void>((r) => (release = r))
      return { state: 'published' }
    })
    const p = engine.savePost({ title: '', body: 'x', tags: [], media: [], aiGenerated: false, targets: [{ accountId: accounts[0].id, variant: {} }] })
    await engine.approve(p.id)
    engine.tick()
    await sleep(20)
    expect(() => engine.removePost(p.id)).toThrow(/publishing/)
    release()
    await sleep(20)
    expect(store.getPost(p.id)!.targets[0].status).toBe('published')
    engine.removePost(p.id)
    expect(store.getPost(p.id)).toBeUndefined()
  })

  it('a removed account fails its queued targets instead of hanging', async () => {
    const { store, engine, accounts } = rig(['a'], () => async () => ({ state: 'published' }))
    const p = engine.savePost({ title: '', body: 'x', tags: [], media: [], aiGenerated: false, targets: [{ accountId: accounts[0].id, variant: {} }] })
    await engine.approve(p.id)
    store.removeAccount(accounts[0].id)
    engine.tick()
    await sleep(20)
    expect(store.getPost(p.id)!.targets[0].status).toBe('failed')
  })

  it('login expiry fails the target and flags the account', async () => {
    const { store, engine, accounts } = rig(['a'], () => async () => {
      throw new NeedsLoginError('token revoked')
    })
    const p = engine.savePost({ title: '', body: 'x', tags: [], media: [], aiGenerated: false, targets: [{ accountId: accounts[0].id, variant: {} }] })
    await engine.approve(p.id)
    engine.tick()
    await sleep(20)
    expect(store.getPost(p.id)!.targets[0].status).toBe('failed')
    expect(store.getAccount(accounts[0].id)!.status).toBe('needs_login')
  })

  it('a connector that throws a non-Error value still fails cleanly', async () => {
    const { store, engine, accounts } = rig(['a'], () => async () => {
      throw 'boom'
    })
    const p = engine.savePost({ title: '', body: 'x', tags: [], media: [], aiGenerated: false, targets: [{ accountId: accounts[0].id, variant: {} }] })
    await engine.approve(p.id)
    engine.tick()
    await sleep(20)
    const t = store.getPost(p.id)!.targets[0]
    expect(t.status).toBe('failed')
    expect(t.error).toMatch(/boom/)
    expect(engine.isBusy()).toBe(false)
  })

  it('never makes two targets for one account, even if a draft names it twice', () => {
    const { engine, accounts } = rig(['a'], () => async () => ({ state: 'published' }))
    const p = engine.savePost({
      title: '',
      body: 'x',
      tags: [],
      media: [],
      aiGenerated: false,
      targets: [
        { accountId: accounts[0].id, variant: { caption: 'one' } },
        { accountId: accounts[0].id, variant: { caption: 'two' } }
      ]
    })
    expect(p.targets).toHaveLength(1)
  })

  it('rejects publish times that have already passed', async () => {
    const { engine, accounts } = rig(['a'], () => async () => ({ state: 'published' }))
    const p = engine.savePost({ title: '', body: 'x', tags: [], media: [], aiGenerated: false, targets: [{ accountId: accounts[0].id, variant: {} }] })
    await expect(engine.approve(p.id, '2020-01-01T00:00:00Z')).rejects.toThrow(/passed/)
    await expect(engine.approve(p.id, 'not a date')).rejects.toThrow(/Bad publish time/)
  })

  it('keeps the post time in step with what was approved', async () => {
    const { store, engine, accounts } = rig(['a'], () => async () => ({ state: 'published' }))
    const later = new Date(Date.now() + 86400_000).toISOString()
    const p = engine.savePost({ title: '', body: 'x', tags: [], media: [], aiGenerated: false, scheduledAt: later, targets: [{ accountId: accounts[0].id, variant: {} }] })
    await engine.approve(p.id)
    expect(store.getPost(p.id)!.scheduledAt).toBeUndefined()
    const q = engine.savePost({ title: '', body: 'y', tags: [], media: [], aiGenerated: false, targets: [{ accountId: accounts[0].id, variant: {} }] })
    await engine.approve(q.id, later)
    expect(store.getPost(q.id)!.scheduledAt).toBe(later)
  })

  it('handles approve racing approve', async () => {
    const { store, engine, accounts } = rig(['a'], () => async () => ({ state: 'published' }))
    const p = engine.savePost({ title: '', body: 'x', tags: [], media: [], aiGenerated: false, targets: [{ accountId: accounts[0].id, variant: {} }] })
    const r = await Promise.allSettled([engine.approve(p.id), engine.approve(p.id), engine.approve(p.id)])
    expect(r.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    engine.tick()
    engine.tick()
    await sleep(20)
    expect(store.getPost(p.id)!.targets[0].status).toBe('published')
  })
})

describe('tools with hostile or malformed input', () => {
  it('rejects bad arguments without throwing', async () => {
    const { engine } = rig(['a'], () => async () => ({ state: 'published' }))
    const e = env(engine)
    const cases: [string, unknown][] = [
      ['create_post', { platforms: 'a' }],
      ['create_post', { platforms: ['nope'] }],
      ['create_post', {}],
      ['create_post', null],
      ['get_post', { postId: 'missing' }],
      ['update_variant', { targetId: 'missing', caption: 'x' }],
      ['approve_post', { postId: 'missing' }],
      ['cancel_post', { postId: 42 }],
      ['get_platform_rules', { platform: 'nope' }],
      ['probe_media', { path: 'C:/definitely/not/here.mp4' }],
      ['list_posts', { limit: -5 }],
      ['recent_activity', { limit: 1e9 }],
      ['nonexistent_tool', {}]
    ]
    for (const [name, input] of cases) {
      const r = await runTool(name, input, e)
      if (name === 'list_posts' || name === 'recent_activity') continue
      expect(r.ok, `${name} ${JSON.stringify(input)}`).toBe(false)
      expect((r.result as { error: string }).error).toBeTruthy()
    }
  })

  it('does not let tools change a post after it was approved', async () => {
    const { engine } = rig(['a'], () => async () => ({ state: 'published' }))
    const e = env(engine)
    const created = (await runTool('create_post', { platforms: ['a'], body: 'what the person approved' }, e)).result as {
      id: string
      targets: { targetId: string }[]
    }
    await engine.approve(created.id, new Date(Date.now() + 3600_000).toISOString())
    const r1 = await runTool('update_post', { postId: created.id, body: 'something else' }, e)
    const r2 = await runTool('update_variant', { targetId: created.targets[0].targetId, caption: 'something else' }, e)
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    expect(engine.mustPost(created.id).body).toBe('what the person approved')
    // Cancel, edit, approve again is the way.
    engine.cancel(created.id)
    expect((await runTool('update_post', { postId: created.id, body: 'fixed' }, e)).ok).toBe(true)
  })

  it('survives 200 concurrent tool calls', async () => {
    const { store, engine } = rig(['a', 'b'], () => async () => ({ state: 'published' }))
    const e = env(engine)
    const rs = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        i % 4 === 0
          ? runTool('create_post', { platforms: ['a', 'b'], body: `post ${i}`, variants: [{ platform: 'b', caption: `b ${i}` }] }, e)
          : i % 4 === 1
            ? runTool('list_posts', {}, e)
            : i % 4 === 2
              ? runTool('list_accounts', {}, e)
              : runTool('recent_activity', {}, e)
      )
    )
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(store.listPosts(1000)).toHaveLength(50)
    for (const p of store.listPosts(1000)) expect(p.targets).toHaveLength(2)
  })
})

describe('MCP server over HTTP', () => {
  it('serves 60 concurrent calls, rejects bad tokens, and survives junk bodies', async () => {
    const { OneDraftMcpServer } = await import('../src/main/mcp-server')
    const { engine } = rig(['a'], () => async () => ({ state: 'published' }))
    const server = new OneDraftMcpServer(() => env(engine))
    await server.start(0, 'secret-token')
    const url = `http://127.0.0.1:${server.port}/mcp`
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer secret-token' }
    const call = (id: number, name: string, args: unknown) =>
      fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) })
    try {
      const rs = await Promise.all(
        Array.from({ length: 60 }, (_, i) => call(i, i % 2 ? 'create_post' : 'list_posts', i % 2 ? { platforms: ['a'], body: `p${i}` } : {}))
      )
      for (const r of rs) expect(r.status).toBe(200)
      const bodies = await Promise.all(rs.map((r) => r.json() as Promise<{ result?: { isError?: boolean } }>))
      expect(bodies.every((b) => b.result && !b.result.isError)).toBe(true)
      expect(engine.store.listPosts(1000)).toHaveLength(30)

      expect((await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401)
      expect((await fetch(url, { method: 'POST', headers: { ...headers, authorization: '' }, body: '{}' })).status).toBe(401)
      const junk = await fetch(url, { method: 'POST', headers, body: '{not json' })
      expect(junk.status).toBeGreaterThanOrEqual(400)
      const big = await fetch(url, { method: 'POST', headers, body: 'x'.repeat(6_000_000) }).then(
        (r) => r.status,
        () => 'reset'
      )
      expect(big === 'reset' || (typeof big === 'number' && big >= 400)).toBe(true)
      // Still healthy afterwards.
      expect((await call(999, 'list_accounts', {})).status).toBe(200)
    } finally {
      await server.stop()
    }
  }, 30_000)
})

describe('fixes from the code review', () => {
  const draft = (engine: Engine, accountId: string, extra: Partial<Parameters<Engine['savePost']>[0]> = {}) =>
    engine.savePost({ title: '', body: 'x', tags: [], media: [], aiGenerated: false, targets: [{ accountId, variant: {} }], ...extra })

  it('an approval card approves only what it showed', async () => {
    const { engine, accounts } = rig(['a'], () => async () => ({ state: 'published' }))
    const p = draft(engine, accounts[0].id, { body: 'Happy holidays!' })
    let shown = ''
    const e: ToolEnv = {
      ...env(engine),
      requestApproval: async (req) => {
        shown = req.detail
        engine.updateVariant(p.targets[0].id, { caption: 'something else' })
        return true
      }
    }
    const r = (await runTool('approve_post', { postId: p.id }, e)).result as { approved: boolean }
    expect(shown).toContain('Happy holidays!')
    expect(r.approved).toBe(false)
    expect(engine.mustPost(p.id).targets[0].status).toBe('draft')
  })

  it("approve_post uses the post's own time when none is given", async () => {
    const { engine, accounts } = rig(['a'], () => async () => ({ state: 'published' }))
    const later = new Date(Date.now() + 7 * 86400_000).toISOString()
    const p = draft(engine, accounts[0].id, { scheduledAt: later })
    let title = ''
    await runTool('approve_post', { postId: p.id }, { ...env(engine), requestApproval: async (req) => ((title = req.title), true) })
    expect(title).toMatch(/Schedule/)
    const t = engine.mustPost(p.id).targets[0]
    expect(t.status).toBe('queued')
    expect(t.scheduledAt).toBe(later)
  })

  it('a late second approve cannot re-queue a target that already went out', async () => {
    let sends = 0
    let releaseProbe!: () => void
    const { engine, accounts, store } = rig(['a'], () => async () => (sends++, { state: 'published' }))
    const p = draft(engine, accounts[0].id)
    // Hold the second approve inside validation until the first one has published.
    const realValidate = engine.validateTarget.bind(engine)
    let calls = 0
    engine.validateTarget = async (...a) => {
      if (++calls === 2) await new Promise<void>((r) => (releaseProbe = r))
      return realValidate(...a)
    }
    const first = engine.approve(p.id)
    const second = engine.approve(p.id).catch((e: Error) => e)
    await first
    engine.validateTarget = realValidate
    engine.tick()
    await sleep(20)
    releaseProbe()
    expect(await second).toBeInstanceOf(Error)
    engine.tick()
    await sleep(20)
    expect(sends).toBe(1)
    expect(store.getTarget(p.targets[0].id)!.status).toBe('published')
  })

  it('cancel during the pre-send check sends nothing', async () => {
    let sends = 0
    const { engine, accounts, store } = rig(['a'], () => async () => (sends++, { state: 'published' }))
    const p = draft(engine, accounts[0].id)
    await engine.approve(p.id)
    const realValidate = engine.validateTarget.bind(engine)
    engine.validateTarget = async (...a) => {
      engine.cancel(p.id)
      return realValidate(...a)
    }
    engine.tick()
    await sleep(30)
    expect(sends).toBe(0)
    expect(store.getTarget(p.targets[0].id)!.status).toBe('canceled')
  })

  it('keeps posts the platform already holds, and resets attempts on retry', async () => {
    const { engine, accounts, store } = rig(['a'], () => async () => {
      throw new RetryableError('busy', 0)
    })
    const p = draft(engine, accounts[0].id)
    store.setTarget(p.targets[0].id, { status: 'scheduled', scheduledAt: new Date(Date.now() + 86400_000).toISOString() })
    expect(() => engine.removePost(p.id)).toThrow(/already scheduled on A/)
    store.setTarget(p.targets[0].id, { status: 'failed', attempts: 5 })
    engine.retry(p.targets[0].id)
    expect(store.getTarget(p.targets[0].id)!.attempts).toBe(0)
  })

  it('refuses aspect strings that could write outside the renditions folder', async () => {
    const { engine } = rig(['a'], () => async () => ({ state: 'published' }))
    const r = await runTool('fit_media', { path: 'C:/x/clip.mp4', aspect: '9:16:/../../escape/pwned', mode: 'pad' }, env(engine))
    expect(r.ok).toBe(false)
    expect((r.result as { error: string }).error).toMatch(/Aspect must look like/)
  })

  it('a half-valid post is not half saved', () => {
    const { engine, accounts, store } = rig(['a'], () => async () => ({ state: 'published' }))
    const p = draft(engine, accounts[0].id, { body: 'before' })
    expect(() =>
      engine.savePost({ id: p.id, title: '', body: 'after', tags: [], media: [], aiGenerated: false, targets: [{ accountId: 'nobody', variant: {} }] })
    ).toThrow(/Unknown account/)
    expect(store.getPost(p.id)!.body).toBe('before')
    expect(store.getPost(p.id)!.targets).toHaveLength(1)
  })
})
