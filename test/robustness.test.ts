// What the second pressure test (2026-11-17) found, kept fixed: cancels that sent nothing, restarts mid-post,
// retries that ran out, Disconnect racing the scheduler, comments of accounts that moved to the website, the post
// list's growth, and a Disconnect while posts wait in the account's window (real Edge, headless; skipped without).

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CanceledError, RetryableError, type Connector, type ConnectorContext, type PublishRequest } from '../src/core/connector'
import { Engine, type ContextFactory } from '../src/core/engine'
import { Inbox } from '../src/core/inbox'
import { Registry } from '../src/core/registry'
import { Store } from '../src/core/store'
import { BrowserManager } from '../src/main/browser'
import type { PlatformManifest } from '../src/shared/types'

const temp: string[] = []
afterAll(() => {
  for (const d of temp) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
})
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'od-robust-'))
  temp.push(d)
  return d
}

const EDGE = [process.env['ProgramFiles(x86)'], process.env['ProgramFiles'], process.env['LOCALAPPDATA']].some(
  (root) => !!root && existsSync(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
)

function manifest(id: string): PlatformManifest {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'api',
    color: '#000',
    capabilities: { video: true, image: true, text: true, nativeSchedule: true, comments: true, reply: true, stats: true },
    constraints: { caption: { max: 5000 } },
    settings: [],
    connectFields: [],
    options: [],
    notes: []
  }
}

/** An engine with one fake platform whose publish and disconnect the test decides. */
function rig(publish: (ctx: ConnectorContext, req: PublishRequest) => ReturnType<Connector['publish']>, disconnect?: () => Promise<void>) {
  const store = new Store(':memory:')
  const registry = new Registry()
  let published = 0
  registry.register({
    manifest: manifest('fake'),
    async connect() {
      return { name: 'Fake', remoteUserId: 'fake' }
    },
    publish: (ctx, _account, req) => {
      published++
      return publish(ctx, req)
    },
    disconnect
  })
  const makeContext: ContextFactory = (_p, _a, _s, signal) =>
    ({ log: () => undefined, progress: () => undefined, pendingSecrets: () => undefined, signal: signal ?? new AbortController().signal, paths: { data: tempDir() } }) as unknown as ConnectorContext & {
      pendingSecrets(): unknown
    }
  const engine = new Engine(store, registry, makeContext, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  const account = store.upsertAccount({ platform: 'fake', remoteUserId: 'fake', name: 'Fake', meta: { method: 'web', profileKey: 'fake-1' } })
  const post = (body = 'hello') => engine.savePost({ title: '', body, tags: [], media: [], aiGenerated: false, targets: [{ accountId: account.id, variant: {} }] })
  return { store, engine, account, post, published: () => published }
}

describe('posts that never reached the platform', () => {
  it('a website post canceled while it is filled in is canceled, not “may already be live”', async () => {
    const { store, engine, post } = rig(
      (ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new CanceledError()), { once: true })
        })
    )
    const p = post()
    await engine.approve(p.id)
    const t = p.targets[0]
    const running = engine.publishTarget(t.id)
    await new Promise((r) => setTimeout(r, 50))
    engine.cancel(p.id)
    await running
    expect(store.getTarget(t.id)).toMatchObject({ status: 'canceled', error: undefined })
  })

  it('after a restart, a website post that was being filled in failed (nothing sent), and handed-over ones say “Post again”', async () => {
    const { store, engine, post } = rig(async () => ({ state: 'handoff', note: 'x' }))
    const busy = post('busy')
    const waiting = post('waiting')
    const old = post('old')
    store.setTarget(busy.targets[0].id, { status: 'publishing' })
    store.setTarget(waiting.targets[0].id, { status: 'handoff', error: 'Check the post and press Post. (It’s open in the FAKE window.)' })
    const order = () => store.listPosts().map((p) => p.id)
    const before = order()
    engine.recover()
    expect(store.getTarget(busy.targets[0].id)).toMatchObject({ status: 'failed' })
    expect(store.getTarget(busy.targets[0].id)!.error).toMatch(/wasn’t posted.*Press Retry/)
    expect(store.getTarget(waiting.targets[0].id)!.error).toMatch(/closed with it.*Post again/)
    // A correction, not an edit: the list keeps its order (old posts don't jump to the top).
    expect(order()).toEqual(before)
    expect(before).toContain(old.id)
  })
})

describe('messages people read', () => {
  it('when retries run out, the post says so instead of “OneDraft will try again”', async () => {
    const { store, engine, post } = rig(async () => {
      throw new RetryableError('FAKE answered 503. OneDraft will try again.')
    })
    const p = post()
    await engine.approve(p.id)
    const t = p.targets[0]
    for (let i = 0; i < 5; i++) await engine.publishTarget(t.id)
    expect(store.getTarget(t.id)).toMatchObject({ status: 'failed', error: 'Failed after 5 tries: FAKE answered 503. Press Retry to try again.' })
  })

  it('keep a browser’s colour codes and call log out of the post', async () => {
    const { store, engine, post } = rig(async () => {
      throw new Error('locator.click: \u001b[2mTimeout\u001b[22m exceeded\nCall log:\n  - waiting for locator')
    })
    const p = post()
    await engine.approve(p.id)
    await engine.publishTarget(p.targets[0].id)
    expect(store.getTarget(p.targets[0].id)!.error).toBe('Failed: locator.click: Timeout exceeded')
  })
})

describe('accounts', () => {
  it('a post due while its account is being disconnected doesn’t start', async () => {
    let finish!: () => void
    const { store, engine, account, post, published } = rig(
      async () => ({ state: 'published' }),
      () => new Promise<void>((r) => (finish = r))
    )
    const p = post()
    await engine.approve(p.id)
    const removing = engine.removeAccount(account.id)
    await engine.publishTarget(p.targets[0].id)
    expect(published()).toBe(0)
    expect(store.getTarget(p.targets[0].id)).toMatchObject({ status: 'failed' })
    finish()
    await removing
    expect(store.getAccount(account.id)).toBeUndefined()
  })

  it('keep the comments of an account that moved to the website, hidden until it’s back on the API', () => {
    const store = new Store(':memory:')
    const a = store.upsertAccount({ platform: 'x', remoteUserId: '42', name: 'X', meta: {} })
    const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    const at = new Date().toISOString()
    db.prepare(
      `insert into comments (key, account_id, platform, comment_id, author, text, first_seen_at, updated_at, state, reply_text, replied_at) values (?, ?, 'x', 'c1', 'someone', 'hi', ?, ?, 'answered', 'thanks!', ?)`
    ).run(`${a.id}:c1`, a.id, at, at, at)
    expect(store.listComments()).toHaveLength(1)
    store.upsertAccount({ platform: 'x', remoteUserId: '42', name: 'X', meta: { method: 'web', profileKey: 'x-1' } })
    expect(store.listComments()).toHaveLength(0)
    expect(store.countOpenComments()).toBe(0)
    store.upsertAccount({ platform: 'x', remoteUserId: '42', name: 'X', meta: {} })
    expect(store.listComments()).toMatchObject([{ state: 'answered', reply: { text: 'thanks!' } }])
  })

  it('the Inbox drops problems of accounts that are signed in on the website now', () => {
    const store = new Store(':memory:')
    const registry = new Registry()
    registry.register({ manifest: manifest('fake'), connect: async () => ({ name: 'F', remoteUserId: 'f' }), publish: async () => ({ state: 'published' }), listComments: async () => [] })
    const engine = new Engine(store, registry, (() => ({})) as unknown as ContextFactory, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
    const a = store.upsertAccount({ platform: 'fake', remoteUserId: 'f', name: 'F', meta: {} })
    const inbox = new Inbox(engine)
    inbox.problems = [{ accountId: a.id, platform: 'fake', message: 'FAKE: the login expired. Reconnect.' }]
    expect(inbox.status().problems).toHaveLength(1)
    store.upsertAccount({ platform: 'fake', remoteUserId: 'f', name: 'F', meta: { method: 'web', profileKey: 'fake-1' } })
    expect(inbox.status().problems).toHaveLength(0)
  })
})

describe('the post list', () => {
  it('keeps posts still to go out, not every post that was ever scheduled', () => {
    const store = new Store(':memory:')
    const a = store.upsertAccount({ platform: 'yt', remoteUserId: '1', name: 'YT', meta: {} })
    const save = (body: string) => store.savePost({ title: '', body, tags: [], media: [], aiGenerated: false, targets: [{ accountId: a.id, variant: {} }] }, () => 'yt')
    const past = save('scheduled last year')
    const ahead = save('scheduled next week')
    store.setTarget(past.targets[0].id, { status: 'scheduled', scheduledAt: '2025-01-01T00:00:00.000Z' })
    store.setTarget(ahead.targets[0].id, { status: 'scheduled', scheduledAt: new Date(Date.now() + 7 * 86400_000).toISOString() })
    // Both were last edited long ago (several posts saved in one millisecond would tie otherwise).
    const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    db.prepare(`update posts set updated_at = '2025-01-01T00:00:00.000Z' where id in (?, ?)`).run(past.id, ahead.id)
    for (let i = 0; i < 5; i++) save(`newer ${i}`)
    const ids = store.listPosts(3).map((p) => p.id)
    expect(ids).toContain(ahead.id)
    expect(ids).not.toContain(past.id)
    expect(ids).toHaveLength(4)
    expect(store.listPosts(3).find((p) => p.id === ahead.id)!.targets).toHaveLength(1)
  })
})

describe.skipIf(!EDGE)('Disconnect with posts waiting in the window, in Edge', () => {
  it('keeps the window until its last post closes, never opens the profile again, then deletes it', async () => {
    process.env['ONEDRAFT_BROWSER_ARGS'] = '--headless=new'
    const profiles = tempDir()
    const m = new BrowserManager(profiles, () => 'msedge')
    try {
      const post = await m.lease('web-1', { headless: false })
      const tab = await post.newPage()
      await m.forget('web-1')
      expect(existsSync(join(profiles, 'web-1'))).toBe(true)
      expect(tab.isClosed()).toBe(false)
      await expect(m.lease('web-1', { headless: true })).rejects.toThrow('This account was disconnected.')
      await post.close()
      for (let i = 0; i < 50 && existsSync(join(profiles, 'web-1')); i++) await new Promise((r) => setTimeout(r, 200))
      expect(existsSync(join(profiles, 'web-1'))).toBe(false)
    } finally {
      delete process.env['ONEDRAFT_BROWSER_ARGS']
      await m.closeAll()
    }
  }, 60_000)
})
