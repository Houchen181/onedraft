import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectorContext } from '../src/core/connector'
import { Engine, type ContextFactory } from '../src/core/engine'
import { Registry } from '../src/core/registry'
import { Store } from '../src/core/store'
import { Studio, type StudioPlatform } from '../src/core/studio'
import { runTool, splitImages, type ToolEnv } from '../src/core/tools'
import { BUILTINS } from '../src/connectors'

const tools = { ffmpeg: ffmpegStatic as string, ffprobe: ffprobeStatic.path }
let dir: string
let clip: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'polycast-studio-'))
  clip = join(dir, 'clip.mp4')
  const r = spawnSync(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip])
  if (r.status !== 0) throw new Error(r.stderr.toString())
}, 60_000)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function setup() {
  const store = new Store(':memory:')
  const registry = new Registry()
  for (const c of BUILTINS) registry.register(c)
  const makeContext: ContextFactory = () => ({ pendingSecrets: () => undefined }) as unknown as ConnectorContext & { pendingSecrets(): unknown }
  const engine = new Engine(store, registry, makeContext, tools)
  // A fake "renderer": copies a file into the output, as the Electron composer would render one.
  const platform: StudioPlatform = {
    async renderComposition(_c, out) {
      mkdirSync(join(out, '..'), { recursive: true })
      copyFileSync(clip, out)
      return { path: out, kind: 'video', sizeBytes: 1, width: 1280, height: 720, durationSec: 3, hasAudio: true }
    },
    async speak() {},
    async voices() {
      return [{ name: 'Test Voice', culture: 'en-US', gender: 'Female' }]
    }
  }
  const studio = new Studio(store, tools, join(dir, 'media'), platform)
  engine.isAiMedia = studio.isAiMedia
  const env: ToolEnv = { engine, studio, mediaDir: join(dir, 'media'), requestApproval: async () => true, autoApprove: () => false, source: 'agent' }
  const account = store.upsertAccount({ platform: 'youtube', remoteUserId: 'c1', name: 'Channel' })
  return { store, engine, studio, env, account }
}

describe('studio', () => {
  it('renders an edit of human footage without an AI label', async () => {
    const { env, studio } = setup()
    const r = await runTool('edit_video', { name: 'Cut', spec: { clips: [{ src: clip, in: 0.5, out: 2.5 }], aspect: '1:1', texts: [{ text: 'Hi', start: 0, end: 1 }] } }, env)
    expect(r.ok).toBe(true)
    const out = r.result as { projectId: string; output: string; width: number; height: number; aiGenerated: boolean; durationSec: number }
    expect(out).toMatchObject({ width: 1920, height: 1920, aiGenerated: false })
    expect(out.durationSec).toBeCloseTo(2, 0)
    expect(studio.isAiMedia(out.output)).toBe(false)
  }, 60_000)

  it('labels generated videos, their edits and renditions, and posts that use them', async () => {
    const { env, studio, engine, account } = setup()
    const g = (await runTool('generate_video', { html: '<div>hello world</div>', durationSec: 3, aspect: '9:16' }, env)).result as { output: string; aiGenerated: boolean }
    expect(g.aiGenerated).toBe(true)
    expect(studio.isAiMedia(g.output)).toBe(true)

    const e = (await runTool('edit_video', { spec: { clips: [{ src: g.output }, { src: clip }] } }, env)).result as { output: string; aiGenerated: boolean }
    expect(e.aiGenerated).toBe(true)
    expect(studio.isAiMedia(e.output)).toBe(true)

    const fitted = (await runTool('fit_media', { path: g.output, aspect: '1:1', mode: 'pad', maxSec: 1 }, env)).result as { path: string }
    expect(studio.isAiMedia(fitted.path)).toBe(true)

    const post = engine.savePost({ title: 't', body: 'b', tags: [], media: [clip], aiGenerated: false, targets: [{ accountId: account.id, variant: {} }] })
    expect(post.aiGenerated).toBe(false)
    engine.updateVariant(post.targets[0].id, { media: [g.output] })
    expect(engine.mustPost(post.id).aiGenerated).toBe(true)
  }, 90_000)

  it('returns frames as images and analysis as data', async () => {
    const { env } = setup()
    const v = await runTool('view_frames', { path: clip, count: 3 }, env)
    const { data, images } = splitImages(v.result)
    expect(images).toHaveLength(3)
    expect(images[0].label).toMatch(/^t = 0\.50 s$/)
    expect(JSON.stringify(data)).not.toContain('__images')
    const a = (await runTool('analyze_video', { path: clip }, env)).result as { info: { hasAudio: boolean }; silences: unknown[] }
    expect(a.info.hasAudio).toBe(true)
    expect(a.silences).toEqual([])
  }, 60_000)
})
