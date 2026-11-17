// The Studio timeline (preview segments, time mapping, split at the playhead) and correcting misheard words.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { clipLength } from '../src/core/edit'
import { Speech } from '../src/core/speech'
import { runTool, type ToolEnv } from '../src/core/tools'
import { clock, editDuration, editSegments, segmentAt, splitClip, toOutput, toSource } from '../src/shared/timeline'
import type { EditSpec, MediaInfo, Transcript } from '../src/shared/types'

const video = (durationSec: number): MediaInfo => ({ path: 'v.mp4', kind: 'video', durationSec, sizeBytes: 1, hasAudio: true, width: 1920, height: 1080 })
const image: MediaInfo = { path: 'i.jpg', kind: 'image', sizeBytes: 1, width: 1080, height: 1080 }
const fileOf = (i: MediaInfo) => ({ durationSec: i.durationSec, image: i.kind === 'image' })

describe('preview segments', () => {
  const spec: EditSpec = {
    clips: [
      { src: 'a.mp4', in: 1, out: 9, cuts: [[2, 3], [5, 5.5]] },
      { src: 'pic.jpg', durationSec: 2 },
      { src: 'b.mp4', speed: 2 }
    ]
  }
  const infos = [video(10), image, video(6)]
  const segs = editSegments(spec, infos.map(fileOf))

  it('lays out kept stretches back to back, at each clip’s speed', () => {
    expect(segs.map((s) => [s.clip, s.srcStart, s.srcEnd, Math.round(s.outStart * 1000) / 1000])).toEqual([
      [0, 1, 2, 0],
      [0, 3, 5, 1],
      [0, 5.5, 9, 3],
      [1, 0, 2, 6.5],
      [2, 0, 6, 8.5]
    ])
    expect(segs[4].outEnd).toBe(11.5)
  })

  it('matches the renderer’s clip lengths exactly', () => {
    const rendered = spec.clips.reduce((s, c, i) => s + clipLength(c, infos[i], 30), 0)
    expect(editDuration(segs)).toBeCloseTo(rendered, 6)
  })

  it('maps finished-video time to source time and back, and says when a moment was cut', () => {
    expect(toSource(segs, 1.5)).toEqual({ clip: 0, src: 'a.mp4', time: 3.5 })
    expect(toSource(segs, 9.5)).toEqual({ clip: 2, src: 'b.mp4', time: 2 })
    expect(toOutput(segs, 0, 3.5)).toBe(1.5)
    expect(toOutput(segs, 0, 2.5)).toBeUndefined() // inside a cut
    expect(segmentAt(segs, 99)?.index).toBe(4)
    expect(clock(65.25)).toBe('1:05.3')
  })
})

describe('split at the playhead', () => {
  const clips = [{ src: 'a.mp4', in: 1, out: 9, cuts: [[2, 3], [5, 6]] as [number, number][] }]

  it('splits a clip in two and gives each its own cuts', () => {
    const r = splitClip(clips, 0, 5.5, 10)!
    expect(r).toEqual([
      { src: 'a.mp4', in: 1, out: 5.5, cuts: [[2, 3], [5, 5.5]] },
      { src: 'a.mp4', in: 5.5, out: 9, cuts: [[5.5, 6]] }
    ])
    const lengths = r.map((c) => clipLength(c, video(10), 30))
    expect(lengths[0] + lengths[1]).toBeCloseTo(clipLength(clips[0], video(10), 30), 6)
  })

  it('refuses to split at the very edges', () => {
    expect(splitClip(clips, 0, 1.01, 10)).toBeUndefined()
    expect(splitClip(clips, 0, 9, 10)).toBeUndefined()
    expect(splitClip(clips, 3, 4, 10)).toBeUndefined()
  })
})

describe('correcting misheard words', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onedraft-fix-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'talk.mp4')
  writeFileSync(file, 'not really a video')
  const changed: string[] = []
  const speech = new Speech({ dir: join(dir, 'w'), cacheDir: join(dir, 'tr'), media: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, fetch, onTranscript: (p) => changed.push(p) })
  const transcript: Transcript = {
    path: file,
    language: 'en',
    durationSec: 3,
    words: [
      { text: 'the', start: 0, end: 0.2 },
      { text: 'bridge', start: 0.2, end: 0.5 },
      { text: 'at', start: 0.5, end: 0.6 },
      { text: 'tofukuji.', start: 0.6, end: 1.2 }
    ],
    segments: [{ from: 0, to: 4, start: 0, end: 1.2, text: 'the bridge at tofukuji.' }],
    model: 'm',
    createdAt: ''
  }
  const seed = () => {
    mkdirSync(join(dir, 'tr'), { recursive: true })
    writeFileSync((speech as unknown as { cachePath(p: string): string }).cachePath(file), JSON.stringify(transcript))
  }

  it('keeps the fix with the transcript and rebuilds the sentence', () => {
    seed()
    const t = speech.fixWords(file, [[3, ' Tofuku-ji. ']])
    expect(t.words[3]).toEqual({ text: 'Tofuku-ji.', start: 0.6, end: 1.2 })
    expect(t.segments[0].text).toBe('the bridge at Tofuku-ji.')
    expect(speech.cached(file)?.words[3].text).toBe('Tofuku-ji.')
    expect(changed).toEqual([file])
    expect(() => speech.fixWords(file, [[9, 'x']])).toThrow(/no word 9/)
    expect(() => speech.fixWords(file, [[1, '  ']])).toThrow(/cut it instead/)
  })

  it('lets Claude fix words with fix_transcript', async () => {
    seed()
    const env = { engine: {} as never, mediaDir: '.', speech, requestApproval: async () => true, autoApprove: () => false, source: 'mcp' } satisfies ToolEnv
    const r = await runTool('fix_transcript', { path: file, words: [[3, 'Tofuku-ji.']] }, env)
    expect(r).toEqual({ ok: true, result: { fixed: 1, sentences: [{ words: '0-3', text: 'the bridge at Tofuku-ji.' }] } })
  })
})
