// Video editing on ffmpeg. An EditSpec (clips + text + captions + music + logo + fades) is turned into
// one filter graph and rendered in a single pass. The same spec is produced by the Studio UI and by
// the assistant, so any edit can be reopened, tweaked by hand, and rendered again.
//
// Also: analysis helpers (silences, scene changes, frames for Claude to look at) and SRT parsing.

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join, relative, isAbsolute, parse as parsePath } from 'node:path'
import type { Caption, EditSpec, MediaInfo } from '../shared/types'
import { frameFor, hasAudioStream, probe, type MediaTools } from './media'
import { nameAspect, parseAspect } from './validate'

export const FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyh.ttc', // Microsoft YaHei: Latin + Simplified Chinese
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
]
export const defaultFont = () => FONT_CANDIDATES.find((f) => existsSync(f))

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const num = (x: number) => (Math.round(x * 1000) / 1000).toString()

/** Length a clip occupies on the output timeline. */
export function clipLength(c: EditSpec['clips'][number], info: MediaInfo): number {
  if (info.kind === 'image') return Math.max(0.1, c.durationSec ?? 3)
  const speed = clamp(c.speed ?? 1, 0.25, 4)
  const full = info.durationSec ?? 0
  const start = clamp(c.in ?? 0, 0, full)
  const end = clamp(c.out ?? full, start, full)
  return (end - start) / speed
}

export function checkSpec(spec: EditSpec, infos: MediaInfo[]): string[] {
  const problems: string[] = []
  if (!spec.clips?.length) problems.push('Add at least one clip.')
  spec.clips?.forEach((c, i) => {
    const info = infos[i]
    if (!info) return
    if (info.kind === 'video') {
      const full = info.durationSec ?? 0
      if ((c.in ?? 0) >= (c.out ?? full)) problems.push(`Clip ${i + 1}: start must be before end.`)
      if ((c.in ?? 0) > full) problems.push(`Clip ${i + 1}: starts after the video ends (${full.toFixed(1)} s).`)
    }
    if (c.speed !== undefined && (c.speed < 0.25 || c.speed > 4)) problems.push(`Clip ${i + 1}: speed must be 0.25–4.`)
  })
  for (const t of spec.texts ?? []) if (!(t.end > t.start)) problems.push(`Text "${t.text.slice(0, 20)}": end must be after start.`)
  return problems
}

/** Wrap text so each line fits ~88% of the frame width (CJK counts 1 em, Latin ~0.55 em). */
export function wrapText(text: string, frameWidth: number, fontPx: number): string {
  const maxUnits = (frameWidth * 0.88) / fontPx
  const unit = (ch: string) => ((ch.codePointAt(0) ?? 0) > 0x2e80 ? 1 : 0.56)
  const out: string[] = []
  for (const para of text.split(/\r?\n/)) {
    let line = ''
    let width = 0
    // Tokens: runs of Latin word characters stay together; CJK characters break anywhere.
    for (const tok of para.match(/[\u2e80-\uffff]|[^\s\u2e80-\uffff]+|\s+/g) ?? []) {
      const w = [...tok].reduce((s, ch) => s + unit(ch), 0)
      if (width + w > maxUnits && line.trim()) {
        out.push(line.trimEnd())
        line = tok.trimStart()
        width = [...line].reduce((s, ch) => s + unit(ch), 0)
      } else {
        line += tok
        width += w
      }
    }
    out.push(line.trimEnd())
  }
  return out.join('\n')
}

function atempo(speed: number): string {
  // atempo takes 0.5–100 per instance; chain for slower speeds.
  const parts: string[] = []
  let s = speed
  while (s < 0.5) {
    parts.push('atempo=0.5')
    s /= 0.5
  }
  if (Math.abs(s - 1) > 1e-3) parts.push(`atempo=${num(s)}`)
  return parts.length ? `${parts.join(',')},` : ''
}

const COLOR_NAMES = new Set(
  'white black red green blue yellow orange purple pink cyan magenta gray grey silver gold navy teal lime maroon olive brown violet indigo coral salmon beige ivory'.split(' ')
)
/** A color drawtext understands: #rrggbb, #rgb or a common name; anything else falls back. */
export const hexColor = (c?: string, fallback = 'white') => {
  if (!c) return fallback
  const v = c.trim().toLowerCase()
  const six = /^#?([0-9a-f]{6})$/.exec(v)
  if (six) return `0x${six[1]}`
  const three = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v)
  if (three) return `0x${three[1]}${three[1]}${three[2]}${three[2]}${three[3]}${three[3]}`
  return COLOR_NAMES.has(v) ? v : fallback
}

const finite = (x: number | undefined, fallback: number) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback)

/** Clamp a spec to values ffmpeg can render, whoever wrote it (the Studio UI, the assistant, a hand-edited project). */
export function saneSpec(spec: EditSpec): EditSpec {
  const fps = finite(spec.fps, 30)
  const ratio = spec.aspect ? parseAspect(spec.aspect) : NaN
  return {
    ...spec,
    fps: fps >= 1 ? Math.min(fps, 120) : 30,
    longSide: Math.round(clamp(finite(spec.longSide, 1920), 64, 4096)),
    aspect: Number.isFinite(ratio) && ratio >= 0.2 && ratio <= 5 ? spec.aspect : undefined,
    transitionSec: Math.max(0, finite(spec.transitionSec, 0)),
    fadeInSec: Math.max(0, finite(spec.fadeInSec, 0)),
    fadeOutSec: Math.max(0, finite(spec.fadeOutSec, 0)),
    clips: spec.clips.map((c) => ({
      ...c,
      in: c.in === undefined ? undefined : Math.max(0, finite(c.in, 0)),
      durationSec: c.durationSec === undefined ? undefined : clamp(finite(c.durationSec, 3), 0.1, 3600),
      volume: c.volume === undefined ? undefined : clamp(finite(c.volume, 1), 0, 10)
    })),
    texts: spec.texts?.map((t) => ({ ...t, size: t.size === undefined ? undefined : clamp(finite(t.size, 0.045), 0.01, 0.3) })),
    music: spec.music && { ...spec.music, volume: spec.music.volume === undefined ? undefined : clamp(finite(spec.music.volume, 0.25), 0, 4) }
  }
}

export interface BuiltEdit {
  args: string[]
  graph: string
  /** Text files the graph reads (drawtext textfile=…), relative to the work dir. */
  files: Record<string, string>
  durationSec: number
  width: number
  height: number
}

/**
 * Build the ffmpeg command for an edit. `infos` are probes of spec.clips (same order).
 * `fontRef` is the font path as ffmpeg should see it (relative to the work dir, to avoid escaping drive colons).
 */
export function buildEdit(
  rawSpec: EditSpec,
  infos: MediaInfo[],
  o: { out: string; fontRef: string; graphFile?: string }
): BuiltEdit {
  const spec = saneSpec(rawSpec)
  const fps = spec.fps ?? 30
  const first = infos.find((i) => i.width && i.height)
  const aspect = spec.aspect ?? (first ? nameAspect(first.width! / first.height!) : '16:9')
  const ratio = parseAspect(aspect) || (first ? first.width! / first.height! : 16 / 9)
  const longSide = spec.longSide ?? 1920
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  const W = ratio >= 1 ? longSide : even(longSide * ratio)
  const H = ratio >= 1 ? even(longSide / ratio) : longSide
  const fit = spec.fit ?? 'blur'

  const args: string[] = ['-hide_banner', '-y']
  const graph: string[] = []
  const files: Record<string, string> = {}
  const lengths = spec.clips.map((c, i) => clipLength(c, infos[i]))

  // ---- inputs ----
  spec.clips.forEach((c, i) => {
    const info = infos[i]
    if (info.kind === 'image') {
      args.push('-loop', '1', '-framerate', String(fps), '-t', num(lengths[i]), '-i', c.src)
    } else {
      const start = clamp(c.in ?? 0, 0, info.durationSec ?? 0)
      const end = clamp(c.out ?? info.durationSec ?? 0, start, info.durationSec ?? 0)
      if (start > 0) args.push('-ss', num(start))
      args.push('-t', num(end - start), '-i', c.src)
    }
  })
  let musicIdx = -1
  if (spec.music?.src) {
    musicIdx = spec.clips.length
    args.push('-stream_loop', '-1', '-i', spec.music.src)
  }
  let logoIdx = -1
  if (spec.logo?.src) {
    logoIdx = spec.clips.length + (musicIdx >= 0 ? 1 : 0)
    args.push('-i', spec.logo.src)
  }

  // ---- per clip ----
  spec.clips.forEach((c, i) => {
    const info = infos[i]
    const d = lengths[i]
    const speed = clamp(c.speed ?? 1, 0.25, 4)
    const sameAspect = info.width && info.height ? Math.abs(info.width / info.height - W / H) / (W / H) < 0.01 : false
    const pre = `[${i}:v]setpts=(PTS-STARTPTS)/${num(info.kind === 'image' ? 1 : speed)},fps=${fps}`
    const post = `setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=duration=${num(d)},setpts=PTS-STARTPTS[v${i}]`
    if (sameAspect || fit === 'crop') {
      graph.push(`${pre},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${post}`)
    } else if (fit === 'pad') {
      graph.push(`${pre},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,${post}`)
    } else {
      graph.push(
        `${pre},split=2[c${i}a][c${i}b]`,
        `[c${i}a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2[c${i}bg]`,
        `[c${i}b]scale=${W}:${H}:force_original_aspect_ratio=decrease[c${i}fg]`,
        `[c${i}bg][c${i}fg]overlay=(W-w)/2:(H-h)/2,${post}`
      )
    }
    const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo'
    if (info.kind === 'video' && info.hasAudio && !c.mute) {
      graph.push(`[${i}:a]asetpts=PTS-STARTPTS,${atempo(speed)}volume=${num(c.volume ?? 1)},${fmt},apad,atrim=duration=${num(d)}[a${i}]`)
    } else {
      graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${num(d)},${fmt}[a${i}]`)
    }
  })

  // ---- join ----
  const n = spec.clips.length
  let total: number
  if (n === 1) {
    graph.push('[v0]null[vj]', '[a0]anull[aj]')
    total = lengths[0]
  } else if ((spec.transitionSec ?? 0) > 0) {
    const T = Math.min(spec.transitionSec!, Math.min(...lengths) / 2)
    let len = lengths[0]
    let pv = 'v0'
    let pa = 'a0'
    for (let k = 1; k < n; k++) {
      const outV = k === n - 1 ? 'vj' : `vx${k}`
      const outA = k === n - 1 ? 'aj' : `ax${k}`
      graph.push(`[${pv}][v${k}]xfade=transition=fade:duration=${num(T)}:offset=${num(len - T)}[${outV}]`)
      graph.push(`[${pa}][a${k}]acrossfade=d=${num(T)}:c1=tri:c2=tri[${outA}]`)
      len = len + lengths[k] - T
      pv = outV
      pa = outA
    }
    total = len
  } else {
    graph.push(`${spec.clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[vj][aj]`)
    total = lengths.reduce((s, x) => s + x, 0)
  }

  // ---- video overlays ----
  let v = 'vj'
  if (logoIdx >= 0 && spec.logo) {
    const lw = even(W * clamp(spec.logo.widthFraction ?? 0.14, 0.03, 0.6))
    const m = Math.round(Math.min(W, H) * 0.035)
    const pos = spec.logo.position ?? 'top-right'
    const x = pos.endsWith('left') ? `${m}` : `main_w-overlay_w-${m}`
    const y = pos.startsWith('top') ? `${m}` : `main_h-overlay_h-${m}`
    graph.push(`[${logoIdx}:v]scale=${lw}:-1,format=rgba,colorchannelmixer=aa=${num(clamp(spec.logo.opacity ?? 0.9, 0, 1))}[lg]`)
    graph.push(`[${v}][lg]overlay=${x}:${y}:format=auto[vl]`)
    v = 'vl'
  }
  const overlays: string[] = []
  const vertical = H > W
  const addText = (text: string, start: number, end: number, pos: 'top' | 'center' | 'bottom', size: number, color: string | undefined, box: boolean, key: string) => {
    const px = Math.round(H * size)
    files[`${key}.txt`] = wrapText(text, W, px)
    const y =
      pos === 'top' ? `${Math.round(H * 0.08)}` : pos === 'center' ? '(h-text_h)/2' : `h-text_h-${Math.round(H * (vertical ? 0.2 : 0.08))}`
    overlays.push(
      `drawtext=fontfile='${o.fontRef}':textfile='${key}.txt':expansion=none:fontsize=${px}:fontcolor=${hexColor(color)}` +
        `:line_spacing=${Math.round(px * 0.25)}:borderw=${Math.max(2, Math.round(px * 0.06))}:bordercolor=black@0.65` +
        (box ? `:box=1:boxcolor=black@0.45:boxborderw=${Math.round(px * 0.35)}` : '') +
        `:x=(w-text_w)/2:y=${y}:enable='between(t,${num(start)},${num(end)})'`
    )
  }
  ;(spec.texts ?? []).forEach((t, k) => addText(t.text, t.start, t.end, t.position ?? 'center', t.size ?? 0.045, t.color, t.box ?? false, `t${k}`))
  ;(spec.captions ?? []).forEach((c, k) => addText(c.text, c.start, c.end, 'bottom', vertical ? 0.032 : 0.042, 'white', true, `cap${k}`))
  if ((spec.fadeInSec ?? 0) > 0) overlays.push(`fade=t=in:st=0:d=${num(spec.fadeInSec!)}`)
  if ((spec.fadeOutSec ?? 0) > 0) overlays.push(`fade=t=out:st=${num(Math.max(0, total - spec.fadeOutSec!))}:d=${num(spec.fadeOutSec!)}`)
  graph.push(`[${v}]${overlays.length ? overlays.join(',') : 'null'}[vout]`)

  // ---- audio ----
  let a = 'aj'
  if (musicIdx >= 0 && spec.music) {
    graph.push(
      `[${musicIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${num(spec.music.volume ?? 0.25)},atrim=duration=${num(total)}[mus]`
    )
    if (spec.music.duck !== false) {
      graph.push('[aj]asplit=2[aj1][aj2]')
      graph.push('[mus][aj2]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[mduck]')
      graph.push('[aj1][mduck]amix=inputs=2:duration=first:normalize=0[am]')
    } else {
      graph.push('[aj][mus]amix=inputs=2:duration=first:normalize=0[am]')
    }
    a = 'am'
  }
  const afx: string[] = []
  if (spec.normalizeAudio) afx.push('loudnorm=I=-14:TP=-1.5:LRA=11')
  if ((spec.fadeInSec ?? 0) > 0) afx.push(`afade=t=in:st=0:d=${num(spec.fadeInSec!)}`)
  if ((spec.fadeOutSec ?? 0) > 0) afx.push(`afade=t=out:st=${num(Math.max(0, total - spec.fadeOutSec!))}:d=${num(spec.fadeOutSec!)}`)
  graph.push(`[${a}]${afx.length ? afx.join(',') : 'anull'},aresample=48000[aout]`)

  const graphText = graph.join(';\n')
  args.push(
    '-filter_complex_script', o.graphFile ?? 'graph.txt',
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', '-t', num(total), '-progress', 'pipe:1', '-nostats', o.out
  )
  return { args, graph: graphText, files, durationSec: total, width: W, height: H }
}

/** Font path as seen from `workDir`: relative when on the same drive (no "C:" to escape), else a copy. */
export function fontRefFor(workDir: string, font: string): string {
  const rel = relative(workDir, font)
  if (!isAbsolute(rel) && !/^[a-z]:/i.test(rel)) return rel.replace(/\\/g, '/')
  const copy = join(workDir, `font${extname(font)}`)
  if (!existsSync(copy)) copyFileSync(font, copy)
  return basename(copy)
}

/** Render an edit. Returns the output's media info. */
export async function renderEdit(
  tools: MediaTools,
  spec: EditSpec,
  out: string,
  workDir: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<MediaInfo> {
  mkdirSync(workDir, { recursive: true })
  mkdirSync(parsePath(out).dir, { recursive: true })
  const infos: MediaInfo[] = []
  for (const c of spec.clips) infos.push(await probe(tools, c.src))
  const problems = checkSpec(spec, infos)
  if (problems.length) throw new Error(problems.join(' '))
  if (spec.music?.src) {
    if (!existsSync(spec.music.src)) throw new Error(`Music file not found: ${spec.music.src}`)
    if (!(await hasAudioStream(tools, spec.music.src))) throw new Error(`The music file has no sound: ${basename(spec.music.src)}`)
  }
  if (spec.logo?.src && !existsSync(spec.logo.src)) throw new Error(`Logo file not found: ${spec.logo.src}`)
  const font = defaultFont()
  const needsFont = (spec.texts?.length ?? 0) + (spec.captions?.length ?? 0) > 0
  if (needsFont && !font) throw new Error('No font found for text overlays.')
  const built = buildEdit(spec, infos, { out, fontRef: font ? fontRefFor(workDir, font) : '' })
  writeFileSync(join(workDir, 'graph.txt'), built.graph)
  for (const [name, text] of Object.entries(built.files)) writeFileSync(join(workDir, name), text)

  await new Promise<void>((resolve, reject) => {
    const p = spawn(tools.ffmpeg, built.args, { cwd: workDir, windowsHide: true, signal })
    let err = ''
    p.stderr.on('data', (d) => (err = (err + d).slice(-6000)))
    p.stdout.on('data', (d: Buffer) => {
      const m = /out_time_ms=(\d+)/.exec(d.toString())
      if (m) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / built.durationSec))
    })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim().split('\n').slice(-6).join('\n')}`))))
  })
  onProgress?.(1)
  return probe(tools, out)
}

// ---------- analysis ----------

function runCollect(tools: MediaTools, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(tools.ffmpeg, args, { windowsHide: true, signal })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg failed: ${err.slice(-500)}`))))
  })
}

export interface Span {
  start: number
  end: number
}

export async function detectSilences(tools: MediaTools, path: string, noiseDb = -35, minSec = 0.5, signal?: AbortSignal): Promise<Span[]> {
  const log = await runCollect(tools, ['-hide_banner', '-nostats', '-i', path, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-'], signal)
  const out: Span[] = []
  let start: number | undefined
  for (const line of log.split(/\r?\n/)) {
    const s = /silence_start: (-?[\d.]+)/.exec(line)
    if (s) start = Math.max(0, Number(s[1]))
    const e = /silence_end: ([\d.]+)/.exec(line)
    if (e && start !== undefined) {
      out.push({ start, end: Number(e[1]) })
      start = undefined
    }
  }
  if (start !== undefined) out.push({ start, end: Infinity })
  return out
}

/** The parts to keep when cutting out silences (with a little padding so words aren't clipped). */
export function speechSegments(duration: number, silences: Span[], pad = 0.15, minKeep = 0.3): { in: number; out: number }[] {
  const keep: { in: number; out: number }[] = []
  let cursor = 0
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    const end = Math.min(s.start + pad, duration)
    if (end - cursor >= minKeep) keep.push({ in: cursor, out: end })
    cursor = Math.max(cursor, Math.min(duration, s.end) - pad)
  }
  if (duration - cursor >= minKeep) keep.push({ in: cursor, out: duration })
  return keep.map((k) => ({ in: Number(num(k.in)), out: Number(num(k.out)) }))
}

export async function detectScenes(tools: MediaTools, path: string, threshold = 0.3, signal?: AbortSignal): Promise<number[]> {
  const log = await runCollect(
    tools,
    ['-hide_banner', '-nostats', '-i', path, '-an', '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'],
    signal
  )
  const times: number[] = []
  for (const m of log.matchAll(/Parsed_showinfo.*?pts_time:([\d.]+)/g)) times.push(Number(num(Number(m[1]))))
  return times
}

/** Save small JPEG frames at the given times (for previews and for Claude to look at). */
export async function extractFrames(tools: MediaTools, path: string, times: number[], outDir: string, width = 512): Promise<{ t: number; path: string }[]> {
  mkdirSync(outDir, { recursive: true })
  const stem = basename(path, extname(path)).replace(/[^\w.-]+/g, '_')
  const out: { t: number; path: string }[] = []
  for (const t of times) {
    const file = join(outDir, `${stem}-${Math.round(t * 1000)}ms.jpg`)
    await runCollect(tools, ['-hide_banner', '-y', '-ss', num(t), '-i', path, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', file])
    out.push({ t, path: file })
  }
  return out
}

export const evenTimes = (duration: number, count: number) =>
  Array.from({ length: count }, (_, i) => Number(num(((i + 0.5) * duration) / count)))

// ---------- captions ----------

const ts = (s: string) => {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s)
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000 : NaN
}

export function parseSrt(text: string): Caption[] {
  const cues: Caption[] = []
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n')
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    if (timeIdx < 0) continue
    const [a, b] = lines[timeIdx].split('-->')
    const start = ts(a)
    const end = ts(b)
    const body = lines.slice(timeIdx + 1).join('\n').replace(/<[^>]+>/g, '').trim()
    if (Number.isFinite(start) && Number.isFinite(end) && body) cues.push({ start, end, text: body })
  }
  return cues
}

export function toSrt(cues: Caption[]): string {
  const f = (s: number) => {
    const ms = Math.round(s * 1000)
    const p = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
  }
  return cues.map((c, i) => `${i + 1}\n${f(c.start)} --> ${f(c.end)}\n${c.text}\n`).join('\n')
}
