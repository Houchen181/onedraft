// Adversarial edit specs: whatever the assistant (or a hand-edited project) sends, an edit either renders to
// roughly the promised length or fails with a plain explanation, never an ffmpeg filter-graph error or a hang.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderEdit } from '../src/core/edit'
import type { EditSpec } from '../src/shared/types'

const tools = { ffmpeg: ffmpegStatic as string, ffprobe: ffprobeStatic.path }
let dir: string
let wide: string // 2 s 16:9 with audio
let tall: string // 2 s 9:16, no audio
let photo: string
let tune: string
let notMedia: string

const ff = (args: string[]) => {
  const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-y', ...args])
  if (r.status !== 0) throw new Error(r.stderr.toString())
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'onedraft-fuzz-'))
  wide = join(dir, 'wide.mp4')
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', wide])
  tall = join(dir, 'tall.mp4')
  ff(['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=25', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', tall])
  photo = join(dir, 'photo.png')
  ff(['-f', 'lavfi', '-i', 'testsrc=size=400x300', '-frames:v', '1', photo])
  tune = join(dir, 'tune.mp3')
  ff(['-f', 'lavfi', '-i', 'sine=frequency=520', '-t', '1', tune])
  notMedia = join(dir, 'notes.txt')
  writeFileSync(notMedia, 'hello')
}, 60_000)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
async function attempt(spec: EditSpec) {
  const out = join(dir, `out${n++}.mp4`)
  try {
    const info = await renderEdit(tools, { longSide: 320, ...spec }, out, join(dir, `w${n}`))
    return { ok: true as const, info }
  } catch (e) {
    return { ok: false as const, message: (e as Error).message }
  }
}

const cases: [string, () => EditSpec, 'ok' | 'error'][] = [
  ['fps 0', () => ({ clips: [{ src: wide }], fps: 0 }), 'ok'],
  ['fps negative', () => ({ clips: [{ src: wide }], fps: -12 }), 'ok'],
  ['fps fractional', () => ({ clips: [{ src: wide }], fps: 23.976 }), 'ok'],
  ['longSide 0', () => ({ clips: [{ src: wide }], longSide: 0 }), 'ok'],
  ['longSide odd tiny', () => ({ clips: [{ src: wide }], longSide: 7 }), 'ok'],
  ['aspect garbage', () => ({ clips: [{ src: wide }], aspect: 'banana' }), 'ok'],
  ['aspect negative', () => ({ clips: [{ src: wide }], aspect: '-9:16' }), 'ok'],
  ['speed extremes', () => ({ clips: [{ src: wide, speed: 0.25 }, { src: wide, speed: 4 }] }), 'ok'],
  ['negative in', () => ({ clips: [{ src: wide, in: -3, out: 1 }] }), 'ok'],
  ['in equals out', () => ({ clips: [{ src: wide, in: 1, out: 1 }] }), 'error'],
  ['in past end', () => ({ clips: [{ src: wide, in: 9 }] }), 'error'],
  ['image zero duration', () => ({ clips: [{ src: photo, durationSec: 0 }, { src: wide }] }), 'ok'],
  ['image negative duration', () => ({ clips: [{ src: photo, durationSec: -4 }] }), 'ok'],
  ['silent tall + wide with crossfade', () => ({ clips: [{ src: tall }, { src: wide }, { src: photo, durationSec: 1 }], transitionSec: 0.5 }), 'ok'],
  ['crossfade longer than clips', () => ({ clips: [{ src: wide }, { src: tall }], transitionSec: 10 }), 'ok'],
  ['negative crossfade', () => ({ clips: [{ src: wide }, { src: tall }], transitionSec: -1 }), 'ok'],
  [
    'hostile text',
    () => ({
      clips: [{ src: wide }],
      texts: [
        { text: "It's 50% off: %{pts} \\ ; [x] 'quoted' {braces}", start: 0, end: 1 },
        { text: '', start: 0, end: 1 },
        { text: '   ', start: 0.5, end: 1.5, position: 'top' },
        { text: '🍁🎉 émoji ünïcode עברית', start: 0, end: 2, color: 'red; drawtext=text=pwned' },
        { text: 'x'.repeat(3000), start: 1, end: 2, size: 0.2, box: true },
        { text: 'giant', start: 0, end: 2, size: 5 },
        { text: 'zero', start: 0, end: 2, size: 0 },
        { text: 'neg', start: -5, end: 99, size: -1, color: '#zzzzzz' }
      ]
    }),
    'ok'
  ],
  ['text ends before it starts', () => ({ clips: [{ src: wide }], texts: [{ text: 'a', start: 2, end: 1 }] }), 'error'],
  ['captions past the end', () => ({ clips: [{ src: wide }], captions: [{ start: 1.5, end: 30, text: 'Late\nsecond line' }] }), 'ok'],
  ['music with no audio stream', () => ({ clips: [{ src: wide }], music: { src: photo } }), 'error'],
  ['music volume extremes, silent clip', () => ({ clips: [{ src: tall }], music: { src: tune, volume: -3, duck: true } }), 'ok'],
  ['logo is a video, odd values', () => ({ clips: [{ src: wide }], logo: { src: tall, widthFraction: 9, opacity: -2, position: 'bottom-left' } }), 'ok'],
  ['fades longer than the video', () => ({ clips: [{ src: wide }], fadeInSec: 50, fadeOutSec: 50, normalizeAudio: true }), 'ok'],
  ['negative fades', () => ({ clips: [{ src: wide }], fadeInSec: -1, fadeOutSec: -1 }), 'ok'],
  ['volume extremes', () => ({ clips: [{ src: wide, volume: -1 }, { src: wide, volume: 1000, mute: false }] }), 'ok'],
  ['missing file', () => ({ clips: [{ src: join(dir, 'gone.mp4') }] }), 'error'],
  ['not a media file', () => ({ clips: [{ src: notMedia }] }), 'error'],
  ['a folder', () => ({ clips: [{ src: dir }] }), 'error'],
  ['no clips', () => ({ clips: [] }), 'error']
]

describe('edit fuzz', () => {
  for (const [name, spec, expected] of cases) {
    it(name, async () => {
      const r = await attempt(spec())
      if (expected === 'ok') {
        expect(r.ok, r.ok ? '' : r.message).toBe(true)
        if (r.ok) {
          expect(r.info.width! % 2).toBe(0)
          expect(r.info.height! % 2).toBe(0)
          expect(r.info.durationSec).toBeGreaterThan(0.05)
        }
      } else {
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).not.toMatch(/ffmpeg failed|Invalid argument|Error (?:initializing|parsing)/)
      }
    }, 60_000)
  }
})
