// Media pipeline on ffmpeg/ffprobe: probe files, and derive per-platform renditions
// (aspect fit by crop / pad / blurred background, length trim, cover frames).

import { spawn } from 'node:child_process'
import { statSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, extname, join, resolve } from 'node:path'
import type { MediaInfo, MediaKind } from '../shared/types'
import { parseAspect } from './validate'

export interface MediaTools {
  ffmpeg: string
  ffprobe: string
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'flv'])

export function kindOf(path: string): MediaKind | undefined {
  const ext = extname(path).slice(1).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return undefined
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, signal })
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => {
      stderr += d
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    p.on('error', reject)
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** True if the file (video or audio of any type ffprobe knows) has a sound track. */
export async function hasAudioStream(tools: MediaTools, path: string): Promise<boolean> {
  const r = await run(tools.ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path])
  return r.code === 0 && r.stdout.includes('audio')
}

export async function probe(tools: MediaTools, path: string): Promise<MediaInfo> {
  const kind = kindOf(path)
  if (!kind) throw new Error(`Unsupported file type: ${basename(path)}`)
  const sizeBytes = statSync(path).size
  const r = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
  if (r.code !== 0) throw new Error(`Could not read ${basename(path)}: ${r.stderr.trim().slice(0, 300)}`)
  const j = JSON.parse(r.stdout) as {
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }[]
    format?: { duration?: string }
  }
  const v = j.streams?.find((s) => s.codec_type === 'video')
  const hasAudio = !!j.streams?.some((s) => s.codec_type === 'audio')
  let width = v?.width
  let height = v?.height
  const rot = Math.abs(Number(v?.tags?.rotate ?? v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0))
  if (rot === 90 || rot === 270) [width, height] = [height, width]
  const duration = Number(j.format?.duration)
  return {
    path,
    kind,
    width,
    height,
    durationSec: kind === 'video' && Number.isFinite(duration) ? duration : undefined,
    sizeBytes,
    codec: v?.codec_name,
    hasAudio
  }
}

/** Standard output size for an aspect ratio (long side 1920 for video, 1440 for images). */
export function frameFor(aspect: string, longSide = 1920): { w: number; h: number } {
  const r = parseAspect(aspect)
  const even = (n: number) => Math.round(n / 2) * 2
  return r >= 1 ? { w: longSide, h: even(longSide / r) } : { w: even(longSide * r), h: longSide }
}

export type FitMode = 'crop' | 'pad' | 'blur'

export interface FitOptions {
  aspect: string
  mode: FitMode
  /** Trim videos to this many seconds. */
  maxSec?: number
  outDir: string
  suffix?: string
}

function filterFor(mode: FitMode, w: number, h: number): string {
  if (mode === 'crop') return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
  if (mode === 'pad') return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
  return (
    `split=2[a][b];[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:2[bg];` +
    `[b]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`
  )
}

/** Make a rendition of `path` at the given aspect. Returns the new file's info. */
export async function fit(
  tools: MediaTools,
  path: string,
  o: FitOptions,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<MediaInfo> {
  // The aspect becomes part of a file name: accept only "w:h" numbers, so it can never point outside outDir.
  const am = /^(\d{1,3}(?:\.\d{1,3})?):(\d{1,3}(?:\.\d{1,3})?)$/.exec(o.aspect.trim())
  if (!am || !(Number(am[1]) > 0 && Number(am[2]) > 0)) throw new Error(`Aspect must look like 9:16, not "${o.aspect}".`)
  const aspect = `${am[1]}:${am[2]}`
  if (!['crop', 'pad', 'blur'].includes(o.mode)) throw new Error(`Mode must be crop, pad or blur.`)
  const maxSec = o.maxSec && Number.isFinite(o.maxSec) && o.maxSec > 0 ? Math.round(o.maxSec * 10) / 10 : undefined
  const info = await probe(tools, path)
  mkdirSync(o.outDir, { recursive: true })
  const suffix = o.suffix ? `-${o.suffix.replace(/[^\w-]/g, '')}` : ''
  const tag = `${am[1]}x${am[2]}-${o.mode}${maxSec ? `-${maxSec}s` : ''}${suffix}-${sourceId(path)}`
  const stem = basename(path, extname(path))
  if (info.kind === 'image') {
    const { w, h } = frameFor(aspect, 1440)
    const out = join(o.outDir, `${stem}.${tag}.jpg`)
    const r = await run(tools.ffmpeg, ['-y', '-i', path, '-filter_complex', filterFor(o.mode, w, h), '-frames:v', '1', '-q:v', '2', out], signal)
    if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().slice(-400)}`)
    return probe(tools, out)
  }
  const { w, h } = frameFor(aspect, 1920)
  const out = join(o.outDir, `${stem}.${tag}.mp4`)
  const total = Math.min(info.durationSec ?? 0, maxSec ?? Infinity)
  const args = ['-y', '-i', path]
  if (maxSec) args.push('-t', String(maxSec))
  args.push(
    '-filter_complex', filterFor(o.mode, w, h),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out
  )
  await new Promise<void>((resolve, reject) => {
    const p = spawn(tools.ffmpeg, args, { windowsHide: true, signal })
    let err = ''
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)))
    p.stdout.on('data', (d: Buffer) => {
      const m = /out_time_ms=(\d+)/.exec(d.toString())
      if (m && total > 0) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / total))
    })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim().slice(-400)}`))))
  })
  return probe(tools, out)
}

/**
 * Short id for a source file (its full path, size and time), so renditions of two different "clip.mp4" files never
 * overwrite each other, and a re-render of an edited file doesn't replace a version a queued post still uses.
 */
function sourceId(path: string): string {
  let stamp = ''
  try {
    const st = statSync(path)
    stamp = `${st.size}:${st.mtimeMs}`
  } catch {
    /* probe reports missing files */
  }
  return createHash('sha1').update(`${resolve(path).toLowerCase()}|${stamp}`).digest('hex').slice(0, 8)
}

/** Grab one frame as a JPEG cover. */
export async function coverFrame(tools: MediaTools, video: string, atSec: number, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `${basename(video, extname(video))}.cover-${Math.round(atSec * 10)}-${sourceId(video)}.jpg`)
  const r = await run(tools.ffmpeg, ['-y', '-ss', String(atSec), '-i', video, '-frames:v', '1', '-q:v', '2', out])
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().slice(-300)}`)
  return out
}

/** Convert any image to JPEG (Instagram feed only takes JPEG). */
export async function toJpeg(tools: MediaTools, image: string, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `${basename(image, extname(image))}-${sourceId(image)}.jpg`)
  const r = await run(tools.ffmpeg, ['-y', '-i', image, '-q:v', '2', out])
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().slice(-300)}`)
  return out
}
