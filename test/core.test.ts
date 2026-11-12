import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ContentError, RetryableError, UnconfirmedError, type Connector, type ConnectorContext } from '../src/core/connector'
import { Engine, type ContextFactory } from '../src/core/engine'
import { fit, probe } from '../src/core/media'
import { presign } from '../src/core/mediahost'
import { oauthLoopback, pkcePair } from '../src/core/oauth'
import { Registry } from '../src/core/registry'
import { derivePostStatus, Store } from '../src/core/store'
import { captionWithHashtags, validateContent, weightedLength } from '../src/core/validate'
import { fillTemplate } from '../src/connectors/mcp-bridge'
import { rednoteTitleLength } from '../src/connectors/rednote'
import { splitThread } from '../src/connectors/util'
import { BUILTINS } from '../src/connectors'
import type { PlatformManifest, Target } from '../src/shared/types'

const tools = { ffmpeg: ffmpegStatic as string, ffprobe: ffprobeStatic.path }
let dir: string
let video: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'polycast-test-'))
  video = join(dir, 'clip.mp4')
  const r = spawnSync(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video])
  if (r.status !== 0) throw new Error(r.stderr.toString())
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const fakeManifest: PlatformManifest = {
  id: 'fake',
  name: 'Fake',
  kind: 'api',
  color: '#fff',
  capabilities: { video: true, image: true, text: true, nativeSchedule: false, comments: false, reply: false, stats: false },
  constraints: { title: { max: 10 }, caption: { max: 50 }, tags: { style: 'hashtags', max: 3 }, video: { maxSec: 60, aspects: ['16:9'] } },
  settings: [],
  connectFields: [],
  options: [{ key: 'privacy', label: 'Privacy', type: 'select', required: true, default: 'public', options: [] }],
  notes: []
}

describe('validation', () => {
  it('appends hashtags only once', () => {
    expect(captionWithHashtags('hello #cat', ['cat', 'dog'])).toBe('hello #cat\n\n#dog')
  })
  it('weights URLs and CJK like X', () => {
    expect(weightedLength('hi https://example.com/very/long/path')).toBe(3 + 23)
    expect(weightedLength('你好')).toBe(4)
  })
  it('counts Rednote ASCII as half', () => {
    expect(rednoteTitleLength('abcd你好')).toBe(4)
  })
  it('flags limits, tags and aspect', () => {
    const issues = validateContent(
      fakeManifest,
      { title: 'a very long title', caption: 'x'.repeat(48), tags: ['a', 'b', 'c', 'd'], media: [], options: {}, aiGenerated: false },
      [{ path: 'v.mp4', kind: 'video', width: 1080, height: 1920, durationSec: 90, sizeBytes: 1 }]
    )
    const msgs = issues.map((i) => i.message).join('\n')
    expect(msgs).toMatch(/Title is 17/)
    expect(msgs).toMatch(/Caption is/)
    expect(msgs).toMatch(/4 tags/)
    expect(msgs).toMatch(/90 s/)
    expect(msgs).toMatch(/9:16; Fake accepts 16:9/)
  })
  it('turns X overflow into a thread warning', () => {
    const x = BUILTINS.find((c) => c.manifest.id === 'x')!
    const issues = validateContent(x.manifest, { title: '', caption: 'word '.repeat(100), tags: [], media: [], options: {}, aiGenerated: false }, [])
    expect(issues).toHaveLength(1)
    expect(issues[0].level).toBe('warning')
  })
  it('splits threads within the limit', () => {
    const parts = splitThread('Sentence one. '.repeat(40), 280, weightedLength)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(weightedLength(p)).toBeLessThanOrEqual(280)
    expect(parts[0]).toMatch(/ 1\/\d+$/)
  })
})

describe('built-in connectors', () => {
  it('all six are registered with sane manifests', () => {
    expect(BUILTINS.map((c) => c.manifest.id).sort()).toEqual(['bilibili', 'instagram', 'rednote', 'tiktok', 'x', 'youtube'])
    const r = new Registry()
    for (const c of BUILTINS) r.register(c)
    for (const m of r.manifests()) {
      expect(m.name).toBeTruthy()
      expect(m.capabilities.video || m.capabilities.image || m.capabilities.text).toBe(true)
    }
  })
})

describe('plugins', () => {
  it('loads the example Bluesky plugin from a plugins folder', async () => {
    const { cpSync } = await import('node:fs')
    const { loadPlugins } = await import('../src/connectors')
    const pdir = join(dir, 'plugins')
    cpSync(join(__dirname, '..', 'examples', 'bluesky-plugin'), join(pdir, 'bluesky'), { recursive: true })
    const r = new Registry()
    const res = loadPlugins(r, pdir)
    expect(res.errors).toEqual([])
    expect(r.get('bluesky').manifest.source).toBe('plugin')
  })
})

describe('helpers', () => {
  it('makes TikTok-style hex PKCE challenges', () => {
    const { verifier, challenge } = pkcePair('S256-hex')
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(challenge).toMatch(/^[0-9a-f]{64}$/)
    expect(pkcePair('S256').challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
  it('presigns S3 URLs like AWS (documented example)', () => {
    // AWS SigV4 query-string example: GET examplebucket/test.txt, 2013-05-24, 86400 s.
    const url = presign(
      { endpoint: 'https://s3.amazonaws.com', bucket: 'examplebucket', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', publicBaseUrl: '' },
      'GET',
      'test.txt',
      86400,
      new Date('2013-05-24T00:00:00Z')
    )
    // Path-style host differs from AWS's virtual-host example, so check the structure instead of the signature.
    expect(url).toMatch(/^https:\/\/s3\.amazonaws\.com\/examplebucket\/test\.txt\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/)
  })
  it('catches the OAuth loopback redirect and checks state', async () => {
    let seen = ''
    const r = await oauthLoopback(
      { authorizeUrl: ({ redirectUri, state, codeChallenge }) => `https://auth.example/?r=${encodeURIComponent(redirectUri)}&s=${state}&c=${codeChallenge}` },
      async (url) => {
        seen = url
        const u = new URL(url)
        // Play the browser: follow the redirect with a code (and once with a forged state first).
        const bad = await fetch(`${u.searchParams.get('r')}?code=evil&state=forged`).catch(() => undefined)
        expect(bad?.status ?? 400).toBe(400)
      }
    ).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toMatch(/state mismatch/)
    const good = await oauthLoopback({ path: '/cb/', authorizeUrl: ({ redirectUri, state }) => `https://auth.example/?r=${encodeURIComponent(redirectUri)}&s=${state}` }, async (url) => {
      const u = new URL(url)
      void fetch(`${u.searchParams.get('r')}?code=abc123&state=${u.searchParams.get('s')}`)
    })
    expect(seen).toContain('https://auth.example/')
    expect(good.code).toBe('abc123')
    expect(good.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cb\/$/)
  })
  it('fills MCP bridge templates keeping types', () => {
    const out = fillTemplate({ t: '{{title}}', tags: '{{tags}}', s: 'Hi {{title}} {{tags}}', none: '{{cover}}' }, { title: 'A', tags: ['x', 'y'] })
    expect(out).toEqual({ t: 'A', tags: ['x', 'y'], s: 'Hi A x,y' })
  })
  it('derives post status from targets', () => {
    const t = (status: Target['status']) => ({ status }) as Target
    expect(derivePostStatus([t('published'), t('failed')])).toBe('partial')
    expect(derivePostStatus([t('published'), t('scheduled')])).toBe('scheduled')
    expect(derivePostStatus([t('queued'), t('published')])).toBe('queued')
    expect(derivePostStatus([t('unconfirmed')])).toBe('partial')
  })
})

describe('media', () => {
  it('probes and fits a video to 9:16', async () => {
    const info = await probe(tools, video)
    expect(info).toMatchObject({ kind: 'video', width: 1280, height: 720 })
    expect(info.durationSec).toBeGreaterThan(3.5)
    const out = await fit(tools, video, { aspect: '9:16', mode: 'blur', maxSec: 2, outDir: join(dir, 'r') })
    expect(out).toMatchObject({ width: 1080, height: 1920 })
    expect(out.durationSec).toBeLessThan(2.3)
  }, 60_000)
})

describe('engine', () => {
  function setup(publish: Connector['publish']) {
    const store = new Store(':memory:')
    const registry = new Registry()
    const calls: string[] = []
    registry.register({
      manifest: fakeManifest,
      async connect() {
        return { name: 'Me', remoteUserId: 'u1' }
      },
      async publish(ctx, account, req) {
        calls.push(req.targetId)
        return publish(ctx, account, req)
      }
    })
    const makeContext: ContextFactory = () =>
      ({ log: () => undefined, progress: () => undefined, pendingSecrets: () => undefined }) as unknown as ConnectorContext & { pendingSecrets(): unknown }
    const engine = new Engine(store, registry, makeContext, tools)
    const account = store.upsertAccount({ platform: 'fake', remoteUserId: 'u1', name: 'Me' })
    const post = engine.savePost({ title: 'Hi', body: 'Body', tags: [], media: [], aiGenerated: false, targets: [{ accountId: account.id, variant: {} }] })
    return { store, engine, post, calls }
  }
  const settle = () => new Promise((r) => setTimeout(r, 50))

  it('keeps target ids across saves', () => {
    const { engine, post } = setup(async () => ({ state: 'published' }))
    const again = engine.savePost({ id: post.id, title: 'Hi2', body: 'Body', tags: [], media: [], aiGenerated: false, targets: post.targets.map((t) => ({ accountId: t.accountId, variant: { caption: 'x' } })) })
    expect(again.targets[0].id).toBe(post.targets[0].id)
    expect(again.targets[0].variant.caption).toBe('x')
  })

  it('publishes an approved post', async () => {
    const { engine, store, post, calls } = setup(async () => ({ state: 'published', url: 'https://example/1', remoteId: '1' }))
    await engine.approve(post.id)
    engine.tick()
    await settle()
    expect(calls).toHaveLength(1)
    expect(store.getPost(post.id)!.targets[0]).toMatchObject({ status: 'published', url: 'https://example/1' })
  })

  it('waits for the scheduled time when the platform cannot hold posts', async () => {
    const { engine, post, calls } = setup(async () => ({ state: 'published' }))
    await engine.approve(post.id, new Date(Date.now() + 3600_000).toISOString())
    engine.tick()
    await settle()
    expect(calls).toHaveLength(0)
  })

  it('backs off on retryable errors and never re-sends unconfirmed ones', async () => {
    let n = 0
    const { engine, store, post } = setup(async () => {
      n++
      if (n === 1) throw new RetryableError('busy', 1)
      throw new UnconfirmedError('timed out after submit')
    })
    await engine.approve(post.id)
    engine.tick()
    await settle()
    let t = store.getPost(post.id)!.targets[0]
    expect(t.status).toBe('queued')
    await new Promise((r) => setTimeout(r, 1100))
    engine.tick()
    await settle()
    t = store.getPost(post.id)!.targets[0]
    expect(t.status).toBe('unconfirmed')
    expect(() => engine.retry(t.id)).toThrow(/already be live/)
  })

  it('fails content errors without retrying, and blocks approval on validation errors', async () => {
    const { engine, store, post } = setup(async () => {
      throw new ContentError('nope')
    })
    await engine.approve(post.id)
    engine.tick()
    await settle()
    expect(store.getPost(post.id)!.targets[0]).toMatchObject({ status: 'failed' })
    const bad = engine.savePost({ title: 'Way too long title', body: '', tags: [], media: [], aiGenerated: false, targets: [{ accountId: post.targets[0].accountId, variant: {} }] })
    await expect(engine.approve(bad.id)).rejects.toThrow(/Title is/)
  })

  it('marks interrupted publishes unconfirmed on restart', () => {
    const { engine, store, post } = setup(async () => ({ state: 'published' }))
    store.setTarget(post.targets[0].id, { status: 'publishing' })
    engine.recover()
    expect(store.getTarget(post.targets[0].id)!.status).toBe('unconfirmed')
  })
})
