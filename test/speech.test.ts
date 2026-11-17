// Editing by what is said: reading whisper.cpp output, word timing, cuts, captions, rendering with cuts
// (picture and sound must stay in sync), and the one-time Whisper setup (download, checksum, unpack).

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEdit, captionsFor, clipLength, renderEdit } from '../src/core/edit'
import { probe } from '../src/core/media'
import { parseWhisperJson, refineStarts, Speech, WHISPER } from '../src/core/speech'
import { buildAss, captionLines, isFiller, joinWords, keptFrames, mergeCuts, placeWords, planCuts } from '../src/shared/transcript'
import type { EditSpec, Word } from '../src/shared/types'

const tools = { ffmpeg: ffmpegStatic as string, ffprobe: ffprobeStatic.path }
let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'onedraft-speech-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const W = (text: string, start: number, end: number): Word => ({ text, start, end })

/** whisper.cpp -ojf output, written the way the real binary writes it (raw UTF-8 bytes, read back as latin1). */
function whisperJson(segments: { from: number; to: number; tokens: [string | number[], number, number][] }[], language = 'en') {
  const tok = ([t, to, dtw]: [string | number[], number, number]) =>
    `{"text": "${typeof t === 'string' ? t : Buffer.from(t).toString('latin1')}", "offsets": {"from": 0, "to": ${to}}, "t_dtw": ${dtw}}`
  const json = `{"result": {"language": "${language}"}, "transcription": [${segments
    .map((s) => `{"offsets": {"from": ${s.from}, "to": ${s.to}}, "text": "", "tokens": [{"text": "[_BEG_]", "offsets": {"from": 0, "to": 0}, "t_dtw": -1}, ${s.tokens.map(tok).join(', ')}]}`)
    .join(', ')}]}`
  return Buffer.from(json, 'latin1').toString('latin1')
}

describe('reading Whisper', () => {
  it('joins sub-word tokens, keeps punctuation with its word and ends words at their DTW time', () => {
    const r = parseWhisperJson(
      whisperJson([
        {
          from: 0,
          to: 3000,
          tokens: [
            [' Um', 170, 26],
            [',', 180, 30],
            [' going', 900, 120],
            [' to', 1000, 140],
            [' Ky', 1100, 178],
            ['oto', 1300, 194],
            ['!', 1400, 196],
            [' [', 1500, 210],
            ['Music', 1600, 230],
            [']', 1700, 240]
          ]
        }
      ])
    )
    expect(r.language).toBe('en')
    expect(r.words.map((w) => w.text)).toEqual(['Um,', 'going', 'to', 'Kyoto!'])
    expect(r.words.map((w) => w.end)).toEqual([0.26, 1.2, 1.4, 1.94])
    expect(r.segments).toEqual([{ from: 0, to: 4, start: 0, end: 3, text: 'Um, going to Kyoto!' }])
  })

  it('rebuilds Chinese characters split across tokens, one word per character', () => {
    const jing = [...Buffer.from('京', 'utf8')] // 3 bytes, split 2 + 1 across tokens
    const r = parseWhisperJson(
      whisperJson(
        [
          {
            from: 0,
            to: 2000,
            tokens: [
              [[...Buffer.from(' 去', 'utf8')], 400, 40],
              [jing.slice(0, 2), 600, 60],
              [[...jing.slice(2), ...Buffer.from('都。', 'utf8')], 900, 90]
            ]
          }
        ],
        'zh'
      )
    )
    expect(r.words.map((w) => w.text)).toEqual(['去', '京', '都。'])
    expect(joinWords(r.words)).toBe('去京都。')
    expect(r.words[2].end).toBe(0.9)
  })

  it('starts each word after the silence before it', () => {
    // DTW ends: "um" 0.26, "hello" 1.00, "and" 2.26; silences 0.32–0.78 and 1.70–2.14 (from the real test clip).
    const words = refineStarts([W('um', 0.26, 0.26), W('hello', 1, 1), W('everyone', 1.58, 1.58), W('and', 2.26, 2.26)], [
      { start: 0.32, end: 0.78 },
      { start: 1.7, end: 2.14 }
    ], 20)
    expect(words).toEqual([W('um', 0, 0.26), W('hello', 0.78, 1), W('everyone', 1, 1.58), W('and', 2.14, 2.26)])
  })
})

describe('cutting by what is said', () => {
  // "Um, hello everyone. So so the bridge is red." with a long pause after "everyone".
  const words = [W('Um,', 0, 0.3), W('hello', 0.8, 1.1), W('everyone.', 1.1, 1.7), W('So', 3.4, 3.6), W('so', 3.8, 4.0), W('the', 4.1, 4.2), W('bridge', 4.2, 4.6), W('is', 4.6, 4.7), W('red.', 4.7, 5.1)]

  it('removes fillers, deleted words and long pauses without clipping the words around them', () => {
    expect(isFiller(words[0])).toBe(true)
    const cuts = planCuts(words, 0, 6, { removeFillers: true, removeWords: [[3, 3]], maxPauseSec: 0.4 })
    // Head with "Um," up to just before "hello"; the pause and the first "So" (a retake) collapse to 0.4 s.
    expect(cuts[0]).toEqual([0, 0.68])
    for (const w of [words[1], words[2], words[4], words[8]]) for (const [a, b] of cuts) expect(w.end <= a || w.start >= b).toBe(true)
    const kept = 6 - cuts.reduce((s, [a, b]) => s + b - a, 0)
    expect(kept).toBeLessThan(4.2)
  })

  it('keeps only the chosen words for a highlight, trimming the clip ends', () => {
    const cuts = planCuts(words, 0, 6, { keepWords: [[5, 8]] })
    expect(cuts[0][0]).toBe(0)
    expect(cuts[0][1]).toBeCloseTo(4.0, 2) // up to where "the" starts (just after the second "so")
    expect(cuts.at(-1)).toEqual([5.25, 6])
  })

  it('merges overlapping cuts and drops slivers', () => {
    expect(mergeCuts([[2, 3], [1, 2.5], [5, 5.01], [4, 4.5]], 0, 10)).toEqual([[1, 3], [4, 4.5]])
  })

  it('counts kept frames on the frame grid', () => {
    expect(keptFrames(1, 5, [[2, 3]], 30)).toEqual([[0, 30], [60, 120]])
    expect(keptFrames(0, 2, undefined, 30)).toEqual([[0, 60]])
  })
})

describe('captions from speech', () => {
  const clip = { src: 'a.mp4', in: 1, out: 6, cuts: [[2, 3]] as [number, number][] }
  const words = [W('one', 1.2, 1.5), W('two', 2.2, 2.6), W('three', 3.4, 3.8), W('four', 5.0, 5.4), W('five', 6.2, 6.5)]

  it('places surviving words on the finished timeline, after cuts, speed and earlier clips', () => {
    const placed = placeWords([{ clip, in: 1, out: 6, at: 10, speed: 2, words }], 30)
    expect(placed.map((w) => w.text)).toEqual(['one', 'three', 'four']) // "two" was cut, "five" is after out
    expect(placed[0].start).toBeCloseTo(10 + 0.2 / 2, 3)
    expect(placed[1].start).toBeCloseTo(10 + (1 + 0.4) / 2, 3) // 1 s kept before the cut, then 0.4 s into the rest
  })

  it('breaks lines at sentence ends and pauses, and writes word-by-word ASS', () => {
    const lines = captionLines([W('Hello', 0, 0.4), W('there.', 0.4, 0.8), W('This', 0.9, 1.1), W('is', 1.1, 1.2), W('it', 2.5, 2.7)], { style: 'highlight' })
    expect(lines.map((l) => l.words.map((w) => w.text).join(' '))).toEqual(['Hello there.', 'This is', 'it'])
    const ass = buildAss(lines, { style: 'highlight', width: 1080, height: 1920 })
    expect(ass).toContain('PlayResY: 1920')
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(5) // one event per word
    expect(ass).toContain('{\\c&H0000D4FF&}there.{\\r}')
    const clean = buildAss(lines, { style: 'clean', width: 1920, height: 1080 })
    expect(clean.match(/^Dialogue:/gm)).toHaveLength(3) // one per line
  })
})

describe('rendering with cuts', () => {
  /** A flash on screen and a beep in the sound at 0.5 s past every second, for 10 s. */
  function syncSource(): string {
    const file = join(dir, 'sync.mp4')
    const r = spawnSync(tools.ffmpeg, [
      '-y', '-f', 'lavfi', '-i', "color=c=black:s=320x240:r=30,drawbox=x=0:y=0:w=320:h=240:color=white:t=fill:enable='between(mod(t,1),0.5,0.6)'",
      '-f', 'lavfi', '-i', "aevalsrc='if(between(mod(t,1),0.5,0.6),0.8*sin(2*PI*1000*t),0)':s=48000",
      '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file
    ])
    if (r.status !== 0) throw new Error(r.stderr.toString())
    return file
  }
  const flashes = (file: string) => {
    const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-'])
    const log = r.stderr.toString()
    const times: number[] = []
    let t = 0
    let wasBright = false
    for (const line of log.split(/\r?\n/)) {
      const m = /pts_time:([\d.]+)/.exec(line)
      if (m) t = Number(m[1])
      const y = /YAVG=([\d.]+)/.exec(line)
      if (y) {
        const bright = Number(y[1]) > 128
        if (bright && !wasBright) times.push(t)
        wasBright = bright
      }
    }
    return times
  }
  /** Where each beep starts. silencedetect also reports the silence "ending" at the end of the file: not a beep. */
  const beeps = (file: string, duration: number) => {
    const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-30dB:d=0.05', '-vn', '-f', 'null', '-'])
    return [...r.stderr.toString().matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t < duration - 0.1)
  }

  it('keeps picture and sound in sync across cuts and plays only the kept frames', async () => {
    const src = syncSource()
    const spec: EditSpec = { clips: [{ src, cuts: [[1.2, 1.75], [3.05, 3.45], [6.3, 6.95]] }], longSide: 320, fps: 30 }
    const info = await probe(tools, src)
    expect(clipLength(spec.clips[0], info, 30)).toBeCloseTo(10 - 0.55 - 0.4 - 0.65, 1)
    const out = join(dir, 'cut.mp4')
    const result = await renderEdit(tools, spec, out, join(dir, 'work-cut'))
    expect(result.durationSec).toBeCloseTo(8.4, 1)
    const f = flashes(out)
    const b = beeps(out, result.durationSec ?? 0)
    // Flashes at 1.5 and 6.5 were cut; the others moved earlier by what was cut before them.
    expect(f.map((x) => Math.round(x * 10) / 10)).toEqual([0.5, 1.9, 2.5, 3.5, 4.5, 5.9, 6.9, 7.9])
    expect(b).toHaveLength(f.length)
    for (let i = 0; i < f.length; i++) expect(Math.abs(f[i] - b[i])).toBeLessThan(0.045)
  })

  it('burns in captions from speech with libass', async () => {
    const src = syncSource()
    const spec: EditSpec = { clips: [{ src, cuts: [[1.2, 1.75]] }], longSide: 320, autoCaptions: { style: 'pop' } }
    const transcript = [W('one', 0.5, 0.6), W('two', 1.5, 1.6), W('three', 2.5, 2.6)]
    const info = await probe(tools, src)
    const { ass, words } = await captionsFor(spec, [info], async () => transcript)
    expect(words.map((w) => w.text)).toEqual(['one', 'three'])
    expect(buildEdit(spec, [info], { out: 'x.mp4', fontRef: 'f.ttf', ass }).graph).toContain('ass=filename=captions.ass:fontsdir=fonts')
    const out = join(dir, 'captions.mp4')
    const r = await renderEdit(tools, spec, out, join(dir, 'work-captions'), undefined, undefined, { transcriptOf: async () => transcript })
    expect(r.durationSec).toBeCloseTo(9.45, 1)
    await expect(renderEdit(tools, spec, join(dir, 'x.mp4'), join(dir, 'work-x'))).rejects.toThrow(/speech-to-text/)
  })
})

describe('setting up Whisper', () => {
  let server: Server
  let base: string
  const files: Record<string, Buffer> = {}
  beforeAll(async () => {
    // A tiny stand-in for the release zip (made with Windows' own tar, as the app unpacks with it) and model.
    const src = join(dir, 'zipsrc')
    mkdirSync(join(src, 'Release'), { recursive: true })
    writeFileSync(join(src, 'Release', 'whisper-cli.exe'), 'not really whisper')
    const zip = join(dir, 'w.zip')
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'zip'
    const made = process.platform === 'win32' ? spawnSync(tar, ['-a', '-c', '-f', zip, '-C', src, 'Release']) : spawnSync('zip', ['-r', zip, 'Release'], { cwd: src })
    if (made.status !== 0) throw new Error(made.stderr.toString())
    files['/w.zip'] = readFileSync(zip)
    files['/model.bin'] = Buffer.from('model weights '.repeat(1000))
    server = createServer((req, res) => {
      const body = files[req.url ?? '']
      if (!body) return void res.writeHead(404).end()
      res.writeHead(200, { 'content-length': body.length }).end(body)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => server.close())
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  const builds = (modelSha?: string): typeof WHISPER => ({
    gpu: { name: 'w-gpu.zip', url: `${base}/w.zip`, sha256: sha(files['/w.zip']), bytes: files['/w.zip'].length },
    cpu: { name: 'w-cpu.zip', url: `${base}/w.zip`, sha256: sha(files['/w.zip']), bytes: files['/w.zip'].length },
    model: { name: 'm.bin', url: `${base}/model.bin`, sha256: modelSha ?? sha(files['/model.bin']), bytes: files['/model.bin'].length, dtw: 'large.v3.turbo' }
  })

  it('downloads, checks and unpacks once, picking the CUDA build when there is an NVIDIA GPU', async () => {
    const speechDir = join(dir, 'whisper-ok')
    const changes: number[] = []
    const speech = new Speech({ dir: speechDir, cacheDir: join(dir, 'tr'), media: tools, fetch, hasNvidia: () => true, builds: builds(), onChange: () => changes.push(1) })
    expect(speech.status()).toMatchObject({ installed: false, downloads: [{ name: 'w-gpu.zip' }, { name: 'm.bin' }] })
    const [a, b] = await Promise.all([speech.install(), speech.install()])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ installed: true, gpu: true, model: 'm.bin', downloads: [] })
    expect(existsSync(join(speechDir, 'cuda', 'Release', 'whisper-cli.exe'))).toBe(true)
    expect(existsSync(join(speechDir, 'w-gpu.zip'))).toBe(false)
    expect(changes.length).toBeGreaterThan(0)
    await expect(speech.transcribe(join(dir, 'missing.mp4'))).rejects.toThrow()
  })

  it('deletes a download whose checksum does not match and reports it', async () => {
    const speech = new Speech({ dir: join(dir, 'whisper-bad'), cacheDir: join(dir, 'tr'), media: tools, fetch, hasNvidia: () => false, builds: builds('0'.repeat(64)) })
    await expect(speech.install()).rejects.toThrow(/checksum/)
    expect(speech.status()).toMatchObject({ installed: false, error: expect.stringMatching(/checksum/) })
    expect(existsSync(join(dir, 'whisper-bad', 'models', 'm.bin'))).toBe(false)
    expect(existsSync(join(dir, 'whisper-bad', 'models', 'm.bin.part'))).toBe(false)
  })

  it('refuses to transcribe before it is set up', async () => {
    const speech = new Speech({ dir: join(dir, 'whisper-none'), cacheDir: join(dir, 'tr'), media: tools, fetch, builds: builds() })
    await expect(speech.transcribe(syncFile())).rejects.toThrow(/not set up/)
  })
  const syncFile = () => join(dir, 'sync.mp4')
})

// With a real whisper.cpp (ONEDRAFT_WHISPER_DIR = a folder set up by the app), transcribe for real.
const realDir = process.env.ONEDRAFT_WHISPER_DIR
describe.skipIf(!realDir)('real Whisper', () => {
  it('transcribes speech with word times', async () => {
    const speech = new Speech({ dir: realDir!, cacheDir: join(dir, 'real-tr'), media: tools, fetch })
    const clip = process.env.ONEDRAFT_SPEECH_CLIP!
    const t = await speech.transcribe(clip)
    expect(t.words.length).toBeGreaterThan(10)
    expect(joinWords(t.words).toLowerCase()).toContain('kyoto')
    for (let i = 1; i < t.words.length; i++) expect(t.words[i].start).toBeGreaterThanOrEqual(t.words[i - 1].end - 1e-6)
  }, 120_000)
})
