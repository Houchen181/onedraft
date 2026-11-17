// Local speech-to-text with whisper.cpp: a one-time setup (download, check, unpack) and transcription of
// any video or audio file into words with times, cached next to the media.
//
// Timing: whisper.cpp's token offsets run early, so each word ends at its DTW time (-dtw, which needs flash
// attention off) and starts where the previous word ended, moved past any silence ffmpeg hears in between.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import type { SpeechStatus, Transcript, Word } from '../shared/types'
import { detectSilences, type Span } from './edit'
import { probe, type MediaTools } from './media'
import { isCjk, joinWords } from '../shared/transcript'

// ---------------------------------------------------------------- what gets installed

export interface Download {
  name: string
  url: string
  sha256: string
  bytes: number
}

/** whisper.cpp v1.9.5 (release build b5454) and the large-v3-turbo model, pinned with their checksums. */
export const WHISPER: { gpu: Download; cpu: Download; model: Download & { dtw: string } } = {
  gpu: {
    name: 'whisper-bin-win-cuda-12.4.0-x64.zip',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip',
    sha256: 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a',
    bytes: 684913404
  },
  cpu: {
    name: 'whisper-bin-x64.zip',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
    bytes: 8928640
  },
  model: {
    name: 'ggml-large-v3-turbo-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    bytes: 574041195,
    dtw: 'large.v3.turbo'
  }
}

// ---------------------------------------------------------------- reading whisper.cpp's output

interface WhisperToken {
  text: string
  offsets: { from: number; to: number }
  t_dtw?: number
}
interface WhisperJson {
  result?: { language?: string }
  transcription?: { offsets: { from: number; to: number }; text: string; tokens?: WhisperToken[] }[]
}

/** Is this the end of a whole UTF-8 character (not cut inside a multi-byte one)? */
function completeUtf8(b: Uint8Array): boolean {
  for (let back = 1; back <= Math.min(4, b.length); back++) {
    const c = b[b.length - back]
    if ((c & 0xc0) === 0x80) continue // continuation byte: keep looking for the lead byte
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1
    return back >= need
  }
  return true
}

/** "[Music]", "(laughs)", "♪": sounds Whisper writes down that nobody said. */
const NOT_SPEECH = /^[[(（【♪*].*[\])）】♪*]$|^♪+$/

/**
 * Words and sentences from whisper.cpp's full JSON (-ojf). `raw` is the file read as latin1: whisper.cpp
 * writes token bytes as they are, and a Chinese character can be split across two tokens, so bytes are joined
 * before decoding. Times: each word ends at its DTW time (offsets.to without -dtw); starts follow in refineStarts.
 */
export function parseWhisperJson(raw: string): { language: string; words: Word[]; segments: Transcript['segments'] } {
  const d = JSON.parse(raw) as WhisperJson
  const words: Word[] = []
  const segments: Transcript['segments'] = []
  const time = (t: WhisperToken) => ((t.t_dtw ?? -1) >= 0 ? t.t_dtw! / 100 : t.offsets.to / 1000)
  for (const seg of d.transcription ?? []) {
    const from = words.length
    let pending: number[] = []
    const add = (text: string, end: number) => {
      const prev = words.length > from ? words[words.length - 1] : undefined
      const startOfWord = /^\s/.test(text) || !prev
      for (const part of text.trim() ? [text] : []) {
        const t = part.trim()
        if (isCjk(t)) {
          // Each CJK character is its own word; punctuation sticks to the character before it.
          const chars = [...t]
          const startT = prev?.end ?? seg.offsets.from / 1000
          const isPunct = (ch: string) => /^[\p{P}\p{S}]$/u.test(ch)
          const spoken = chars.filter((ch) => !isPunct(ch)).length
          let k = 0
          for (const ch of chars) {
            const last = words.length > from ? words[words.length - 1] : undefined
            if (isPunct(ch) && last) {
              last.text += ch
              continue
            }
            // The token's time is shared between the characters actually spoken in it.
            const at = startT + ((end - startT) * ++k) / Math.max(1, spoken)
            words.push({ text: ch, start: at, end: at })
          }
        } else if (startOfWord) {
          words.push({ text: t, start: end, end })
        } else if (/[\p{L}\p{N}]/u.test(t)) {
          prev!.text += t
          prev!.end = end
        } else {
          prev!.text += t // punctuation: same word, same time
        }
      }
    }
    for (const tok of seg.tokens ?? []) {
      if (tok.text.startsWith('[_')) continue // [_BEG_], [_TT_150]: timing tokens, not text
      pending.push(...Buffer.from(tok.text, 'latin1'))
      const bytes = Uint8Array.from(pending)
      if (!completeUtf8(bytes)) continue
      pending = []
      add(Buffer.from(bytes).toString('utf8'), time(tok))
    }
    // Drop sounds that aren't speech; keep the sentence's words in order.
    for (let i = words.length - 1; i >= from; i--) if (NOT_SPEECH.test(words[i].text)) words.splice(i, 1)
    if (words.length > from) segments.push({ from, to: words.length, start: seg.offsets.from / 1000, end: seg.offsets.to / 1000, text: joinWords(words.slice(from)) })
  }
  return { language: d.result?.language ?? 'unknown', words, segments }
}

/**
 * Give each word a start: where the previous word ended, moved past any silence in between. Ends stay
 * (they come from DTW) but never run backwards. `silences` come from ffmpeg's silencedetect.
 */
export function refineStarts(words: Word[], silences: Span[], duration: number): Word[] {
  const out: Word[] = []
  let prevEnd = 0
  for (const w of words) {
    let end = Math.min(duration || Infinity, Math.max(w.end, prevEnd))
    let start = prevEnd
    for (const s of silences) {
      if (s.start >= start - 0.05 && s.start < end && s.end > start) {
        if (s.end <= end - 0.04) start = Math.max(start, s.end) // a pause before the word
        else end = Math.max(start + 0.04, Math.min(end, s.start)) // the word stops where the silence begins
      }
    }
    if (end - start < 0.04) end = Math.min(start + 0.12, duration || Infinity)
    out.push({ text: w.text, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 })
    prevEnd = end
  }
  return out
}

// ---------------------------------------------------------------- the service

export interface SpeechOptions {
  /** Where whisper.cpp and the model live (<data>/tools/whisper). */
  dir: string
  /** Where transcripts are cached. */
  cacheDir: string
  media: MediaTools
  fetch: typeof fetch
  /** Is there an NVIDIA GPU with a CUDA driver? Picks the CUDA build. */
  hasNvidia?: () => boolean
  /** Unpack a zip into a folder (Windows: its own tar.exe). */
  unzip?: (zip: string, dir: string) => Promise<void>
  builds?: typeof WHISPER
  onChange?: () => void
  /** A transcript was made or corrected. */
  onTranscript?: (path: string) => void
}

interface Installed {
  gpu: boolean
  exe: string
  model: string
  dtw: string
}

const defaultUnzip = (zip: string, dir: string) =>
  new Promise<void>((resolve, reject) => {
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'unzip'
    const args = process.platform === 'win32' ? ['-xf', zip, '-C', dir] : ['-q', '-o', zip, '-d', dir]
    const p = spawn(tar, args, { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking ${zip} failed: ${err.slice(-300)}`))))
  })

const defaultHasNvidia = () => process.platform === 'win32' && existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvcuda.dll'))

export class Speech {
  private installing?: Promise<SpeechStatus>
  private progress?: { fraction: number; note: string }
  private lastError?: string
  private running = new Map<string, Promise<Transcript>>()
  private builds: typeof WHISPER

  constructor(private o: SpeechOptions) {
    this.builds = o.builds ?? WHISPER
  }

  private get marker() {
    return join(this.o.dir, 'installed.json')
  }

  private installed(): Installed | undefined {
    try {
      const i = JSON.parse(readFileSync(this.marker, 'utf8')) as Installed
      return existsSync(i.exe) && existsSync(i.model) ? i : undefined
    } catch {
      return undefined
    }
  }

  status(): SpeechStatus {
    const i = this.installed()
    const gpu = (this.o.hasNvidia ?? defaultHasNvidia)()
    const build = gpu ? this.builds.gpu : this.builds.cpu
    return {
      installed: !!i,
      gpu: i?.gpu,
      model: i ? this.builds.model.name : undefined,
      installing: this.installing ? this.progress : undefined,
      error: this.lastError,
      downloads: i ? [] : [build, this.builds.model].map((d) => ({ name: d.name, mb: Math.round(d.bytes / 1e6) }))
    }
  }

  /** Download, check and unpack whisper.cpp and the model. Safe to call twice: the second call waits for the first. */
  install(signal?: AbortSignal): Promise<SpeechStatus> {
    if (this.installed()) return Promise.resolve(this.status())
    this.installing ??= this.doInstall(signal).finally(() => {
      this.installing = undefined
      this.progress = undefined
      this.o.onChange?.()
    })
    return this.installing
  }

  private async doInstall(signal?: AbortSignal): Promise<SpeechStatus> {
    this.lastError = undefined
    const gpu = (this.o.hasNvidia ?? defaultHasNvidia)()
    const build = gpu ? this.builds.gpu : this.builds.cpu
    const model = this.builds.model
    const total = build.bytes + model.bytes
    mkdirSync(this.o.dir, { recursive: true })
    try {
      const zip = join(this.o.dir, build.name)
      await this.download(build, zip, 0, total, signal)
      const modelPath = join(this.o.dir, 'models', model.name)
      if (!(existsSync(modelPath) && statSync(modelPath).size === model.bytes)) await this.download(model, modelPath, build.bytes, total, signal)
      this.setProgress(1, 'Unpacking')
      const binDir = join(this.o.dir, gpu ? 'cuda' : 'cpu')
      rmSync(binDir, { recursive: true, force: true })
      mkdirSync(binDir, { recursive: true })
      await (this.o.unzip ?? defaultUnzip)(zip, binDir)
      rmSync(zip, { force: true })
      const exe = [join(binDir, 'Release', 'whisper-cli.exe'), join(binDir, 'whisper-cli.exe'), join(binDir, 'Release', 'whisper-cli'), join(binDir, 'whisper-cli')].find((p) => existsSync(p))
      if (!exe) throw new Error('The download did not contain whisper-cli.')
      writeFileSync(this.marker, JSON.stringify({ gpu, exe, model: modelPath, dtw: model.dtw } satisfies Installed, null, 1))
      return this.status()
    } catch (e) {
      this.lastError = (e as Error).message
      throw e
    }
  }

  private setProgress(fraction: number, note: string) {
    this.progress = { fraction, note }
    this.o.onChange?.()
  }

  /** Stream a file to disk, checking its SHA-256 on the way; a mismatch deletes it. */
  private async download(d: Download, to: string, doneBefore: number, total: number, signal?: AbortSignal) {
    mkdirSync(dirname(to), { recursive: true })
    const part = `${to}.part`
    const res = await this.o.fetch(d.url, { signal, headers: { 'user-agent': 'OneDraft' } })
    if (!res.ok || !res.body) throw new Error(`Downloading ${d.name} failed: HTTP ${res.status}`)
    const hash = createHash('sha256')
    const file = createWriteStream(part)
    let got = 0
    let lastTick = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk)
        got += chunk.length
        if (!file.write(chunk)) await new Promise<void>((r) => file.once('drain', () => r()))
        if (Date.now() - lastTick > 250) {
          lastTick = Date.now()
          this.setProgress((doneBefore + got) / total, `Downloading ${d.name}`)
        }
      }
      await new Promise<void>((resolve, reject) => file.end((e?: Error | null) => (e ? reject(e) : resolve())))
    } catch (e) {
      file.destroy()
      rmSync(part, { force: true })
      throw e
    }
    const sum = hash.digest('hex')
    if (sum !== d.sha256) {
      rmSync(part, { force: true })
      throw new Error(`${d.name} did not match its published checksum, so it was deleted. Try again later.`)
    }
    renameSync(part, to)
  }

  private cachePath(path: string): string {
    const st = statSync(path)
    const key = createHash('sha1').update(`${path}|${st.size}|${st.mtimeMs}|${this.builds.model.name}`).digest('hex').slice(0, 20)
    return join(this.o.cacheDir, `${key}.json`)
  }

  /** A transcript made earlier for this exact file, if any (no work done). */
  cached(path: string): Transcript | undefined {
    try {
      return JSON.parse(readFileSync(this.cachePath(path), 'utf8')) as Transcript
    } catch {
      return undefined
    }
  }

  /**
   * Correct words Whisper misheard (names, places, brands): [word number, new text]. Times stay; the fix is kept
   * with the file's transcript, so captions, the Studio panel and the assistant all use it.
   */
  fixWords(path: string, fixes: [number, string][]): Transcript {
    const t = this.cached(path)
    if (!t) throw new Error('Transcribe this file first.')
    for (const [i, text] of fixes) {
      if (!Number.isInteger(i) || i < 0 || i >= t.words.length) throw new Error(`There is no word ${i} (the transcript has ${t.words.length}).`)
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
      if (!clean) throw new Error('A word needs some text. To drop it from the video, cut it instead.')
      t.words[i] = { ...t.words[i], text: clean }
    }
    t.segments = t.segments.map((s) => ({ ...s, text: joinWords(t.words.slice(s.from, s.to)) }))
    writeFileSync(this.cachePath(path), JSON.stringify(t))
    this.o.onTranscript?.(path)
    return t
  }

  /** What is said in a video or audio file. Cached per file version; one run per file at a time. */
  transcribe(path: string, opts: { language?: string; signal?: AbortSignal; onProgress?: (f: number) => void } = {}): Promise<Transcript> {
    const hit = this.cached(path)
    if (hit && (!opts.language || hit.language === opts.language)) return Promise.resolve(hit)
    const key = `${path}|${opts.language ?? ''}`
    const running = this.running.get(key)
    if (running) return running
    const job = this.run(path, opts).finally(() => this.running.delete(key))
    this.running.set(key, job)
    return job
  }

  private async run(path: string, opts: { language?: string; signal?: AbortSignal; onProgress?: (f: number) => void }): Promise<Transcript> {
    const inst = this.installed()
    if (!inst) throw new Error('Speech-to-text is not set up yet. Set it up in Settings → Speech-to-text (a one-time download).')
    const info = await probe(this.o.media, path)
    if (!info.hasAudio) throw new Error('This file has no sound to transcribe.')
    const work = join(this.o.cacheDir, `.work-${createHash('sha1').update(path + Date.now()).digest('hex').slice(0, 10)}`)
    mkdirSync(work, { recursive: true })
    try {
      const wav = join(work, 'audio.wav')
      await exec(this.o.media.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal: opts.signal })
      const args = ['-m', inst.model, '-f', wav, '-l', opts.language || 'auto', '-ojf', '-of', join(work, 'out'), '-pp', '-t', String(Math.max(2, Math.min(8, availableParallelism())))]
      // DTW token times are what make word timing usable; whisper.cpp only computes them without flash attention.
      args.push('-nfa', '-dtw', inst.dtw)
      await exec(inst.exe, args, {
        cwd: dirname(inst.exe),
        signal: opts.signal,
        onStderr: (s) => {
          const m = /progress =\s*(\d+)%/.exec(s)
          if (m) opts.onProgress?.(Number(m[1]) / 100)
        }
      })
      const parsed = parseWhisperJson(readFileSync(join(work, 'out.json'), 'latin1'))
      const duration = info.durationSec ?? parsed.words.at(-1)?.end ?? 0
      const silences = await detectSilences(this.o.media, wav, -35, 0.12, opts.signal).catch(() => [])
      const words = refineStarts(parsed.words, silences, duration)
      const transcript: Transcript = {
        path,
        language: parsed.language,
        durationSec: duration,
        words,
        segments: parsed.segments.map((s) => ({ ...s, start: words[s.from]?.start ?? s.start, end: words[s.to - 1]?.end ?? s.end })),
        model: this.builds.model.name,
        createdAt: new Date().toISOString()
      }
      mkdirSync(this.o.cacheDir, { recursive: true })
      writeFileSync(this.cachePath(path), JSON.stringify(transcript))
      opts.onProgress?.(1)
      this.o.onTranscript?.(path)
      return transcript
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}

function exec(cmd: string, args: string[], o: { cwd?: string; signal?: AbortSignal; onStderr?: (s: string) => void } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: o.cwd, windowsHide: true, signal: o.signal })
    let err = ''
    p.stdout.on('data', () => undefined)
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      err = (err + s).slice(-4000)
      o.onStderr?.(s)
    })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd.split(/[\\/]/).pop()} failed (${code}): ${err.trim().split('\n').slice(-4).join(' ')}`))))
  })
}
