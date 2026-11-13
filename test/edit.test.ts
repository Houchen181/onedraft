import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEdit, detectScenes, detectSilences, evenTimes, extractFrames, parseSrt, renderEdit, speechSegments, toSrt, wrapText } from '../src/core/edit'
import { probe } from '../src/core/media'
import type { MediaInfo } from '../src/shared/types'

const tools = { ffmpeg: ffmpegStatic as string, ffprobe: ffprobeStatic.path }
let dir: string
let talk: string // 8 s: tone 0–2 s, silence 2–5 s, tone 5–8 s
let scene: string // 4 s: red then blue (one hard cut at 2 s), no audio
let photo: string

const ff = (args: string[]) => {
  const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-y', ...args])
  if (r.status !== 0) throw new Error(r.stderr.toString())
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'polycast-edit-'))
  talk = join(dir, 'talk.mp4')
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,5),0,0.4*sin(2*PI*440*t))':s=48000",
    '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk])
  scene = join(dir, 'scene.mp4')
  ff(['-f', 'lavfi', '-i', 'color=red:size=1280x720:rate=30:d=2', '-f', 'lavfi', '-i', 'color=blue:size=1280x720:rate=30:d=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', scene])
  photo = join(dir, 'photo.png')
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1200x1600', '-frames:v', '1', photo])
}, 60_000)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const info = (p: Partial<MediaInfo>): MediaInfo => ({ path: 'x', kind: 'video', sizeBytes: 1, ...p })

describe('edit graph', () => {
  it('computes size, length and crossfade offsets', () => {
    const b = buildEdit(
      { clips: [{ src: 'a.mp4', in: 1, out: 5 }, { src: 'b.mp4', speed: 2 }, { src: 'c.png', durationSec: 2 }], aspect: '9:16', transitionSec: 0.5 },
      [info({ width: 1920, height: 1080, durationSec: 10, hasAudio: true }), info({ width: 1920, height: 1080, durationSec: 6 }), info({ kind: 'image', width: 800, height: 800 })],
      { out: 'o.mp4', fontRef: 'f.ttf' }
    )
    expect([b.width, b.height]).toEqual([1080, 1920])
    // 4 + 3 + 2 - 2*0.5
    expect(b.durationSec).toBeCloseTo(8)
    expect(b.graph).toContain('xfade=transition=fade:duration=0.5:offset=3.5')
    expect(b.graph).toContain('xfade=transition=fade:duration=0.5:offset=6')
    expect(b.graph).toContain('anullsrc') // clips without sound get silence
    expect(b.args).toEqual(expect.arrayContaining(['-ss', '1', '-t', '4', '-i', 'a.mp4']))
  })
  it('wraps long Latin and Chinese text', () => {
    expect(wrapText('one two three four five six seven eight nine ten', 1080, 120).split('\n').length).toBeGreaterThan(1)
    expect(wrapText('这是一段很长的中文字幕需要自动换行才能放进竖屏画面里面', 1080, 90).split('\n').length).toBeGreaterThan(1)
  })
  it('keeps speech around silences', () => {
    expect(speechSegments(8, [{ start: 2, end: 5 }], 0.15)).toEqual([
      { in: 0, out: 2.15 },
      { in: 4.85, out: 8 }
    ])
  })
  it('round-trips SRT', () => {
    const cues = parseSrt('1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>世界</i>\n')
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: 'Hello' },
      { start: 3, end: 4, text: '世界' }
    ])
    expect(parseSrt(toSrt(cues))).toEqual(cues)
  })
})

describe('analysis', () => {
  it('finds the silence and the scene cut', async () => {
    const s = await detectSilences(tools, talk, -35, 0.5)
    expect(s).toHaveLength(1)
    expect(s[0].start).toBeCloseTo(2, 0)
    expect(s[0].end).toBeCloseTo(5, 0)
    const cuts = await detectScenes(tools, scene, 0.3)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]).toBeCloseTo(2, 0)
    const frames = await extractFrames(tools, scene, evenTimes(4, 2), join(dir, 'frames'), 256)
    expect(frames).toHaveLength(2)
    expect((await probe(tools, frames[0].path)).width).toBe(256)
  }, 60_000)
})

describe('render', () => {
  it('cuts silence, mixes a photo, adds text, captions, music, logo and fades into a 9:16 video', async () => {
    const segs = speechSegments(8, await detectSilences(tools, talk))
    const out = join(dir, 'out', 'edit.mp4')
    const r = await renderEdit(
      tools,
      {
        clips: [...segs.map((s) => ({ src: talk, in: s.in, out: s.out })), { src: photo, durationSec: 1.5 }, { src: scene, speed: 2 }],
        aspect: '9:16',
        fit: 'blur',
        transitionSec: 0.3,
        texts: [{ text: 'Polycast 测试 title', start: 0, end: 2, position: 'top', box: true }],
        captions: [{ start: 2, end: 3.5, text: 'A caption that is long enough to need wrapping on a phone screen' }],
        music: { src: scene.replace('scene', 'talk'), volume: 0.2 },
        logo: { src: photo, position: 'bottom-right', widthFraction: 0.12 },
        fadeInSec: 0.3,
        fadeOutSec: 0.5,
        normalizeAudio: true
      },
      out,
      join(dir, 'work')
    )
    if (process.env.POLYCAST_KEEP) (await import('node:fs')).copyFileSync(out, join(process.env.POLYCAST_KEEP, 'edit-test.mp4'))
    // 2.15 + 3.15 + 1.5 + 2 - 3*0.3 = 7.9
    expect(r).toMatchObject({ width: 1080, height: 1920, hasAudio: true })
    expect(r.durationSec!).toBeGreaterThan(7.6)
    expect(r.durationSec!).toBeLessThan(8.2)
  }, 120_000)
})
