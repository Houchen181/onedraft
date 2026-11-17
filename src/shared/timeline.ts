// The finished video as a sequence of plain stretches of source files, worked out from an EditSpec.
// The Studio preview plays these back to back (skipping cuts, at each clip's speed), the timeline strip
// draws them, and "split at the playhead" uses them to find the clip and source time under the playhead.
// Crossfades are left out here: the preview shows hard cuts; the render does the fades.

import { keptFrames } from './transcript'
import type { EditClip, EditSpec } from './types'

export interface Segment {
  clip: number
  src: string
  /** Source seconds played (video) — for images, 0..durationSec. */
  srcStart: number
  srcEnd: number
  /** Where it sits on the finished video, seconds. */
  outStart: number
  outEnd: number
  speed: number
  image: boolean
}

/** What the timeline needs to know about a clip's file. */
export interface ClipFile {
  durationSec?: number
  image?: boolean
}

const clampSpeed = (s: number | undefined) => Math.min(4, Math.max(0.25, s ?? 1))

/** The stretches of source that make up the edit, in playing order. `files[i]` describes spec.clips[i]. */
export function editSegments(spec: EditSpec, files: (ClipFile | undefined)[], fps = spec.fps ?? 30): Segment[] {
  const out: Segment[] = []
  let at = 0
  spec.clips.forEach((c, i) => {
    const f = files[i]
    if (!f) return
    if (f.image) {
      const d = Math.max(0.1, c.durationSec ?? 3)
      out.push({ clip: i, src: c.src, srcStart: 0, srcEnd: d, outStart: at, outEnd: at + d, speed: 1, image: true })
      at += d
      return
    }
    const full = f.durationSec ?? 0
    const lo = Math.min(Math.max(0, c.in ?? 0), full)
    const hi = Math.min(Math.max(lo, c.out ?? full), full)
    const speed = clampSpeed(c.speed)
    const ranges = c.cuts?.length ? keptFrames(lo, hi, c.cuts, fps).map(([a, b]) => [lo + a / fps, lo + b / fps]) : hi > lo ? [[lo, hi]] : []
    for (const [s, e] of ranges) {
      const len = (e - s) / speed
      out.push({ clip: i, src: c.src, srcStart: s, srcEnd: e, outStart: at, outEnd: at + len, speed, image: false })
      at += len
    }
  })
  return out
}

export const editDuration = (segments: Segment[]) => segments.at(-1)?.outEnd ?? 0

/** The segment playing at finished-video time t (the last one at the very end). */
export function segmentAt(segments: Segment[], t: number): { segment: Segment; index: number } | undefined {
  if (!segments.length) return undefined
  const index = segments.findIndex((s) => t >= s.outStart && t < s.outEnd)
  const i = index >= 0 ? index : t < 0 ? 0 : segments.length - 1
  return { segment: segments[i], index: i }
}

/** Finished-video time → the clip and source time showing then. */
export function toSource(segments: Segment[], t: number): { clip: number; src: string; time: number } | undefined {
  const hit = segmentAt(segments, t)
  if (!hit) return undefined
  const s = hit.segment
  const into = Math.min(Math.max(0, t - s.outStart), s.outEnd - s.outStart)
  return { clip: s.clip, src: s.src, time: s.srcStart + into * s.speed }
}

/** A clip's source time → finished-video time (undefined if that moment was cut). */
export function toOutput(segments: Segment[], clip: number, time: number): number | undefined {
  const s = segments.find((x) => x.clip === clip && time >= x.srcStart && time < x.srcEnd)
  return s ? s.outStart + (time - s.srcStart) / s.speed : undefined
}

/**
 * Split clip `index` into two at source time `time` (its cuts go to the side they're on). Returns the new clip
 * list, or undefined when the time isn't strictly inside the clip.
 */
export function splitClip(clips: EditClip[], index: number, time: number, durationSec?: number): EditClip[] | undefined {
  const c = clips[index]
  if (!c) return undefined
  const lo = c.in ?? 0
  const hi = c.out ?? durationSec ?? Infinity
  if (!(time > lo + 0.05 && time < hi - 0.05)) return undefined
  const left: EditClip = { ...c, out: Math.round(time * 1000) / 1000 }
  const right: EditClip = { ...c, in: Math.round(time * 1000) / 1000 }
  const cutsL = (c.cuts ?? []).filter(([s]) => s < time).map(([s, e]): [number, number] => [s, Math.min(e, time)])
  const cutsR = (c.cuts ?? []).filter(([, e]) => e > time).map(([s, e]): [number, number] => [Math.max(s, time), e])
  left.cuts = cutsL.length ? cutsL : undefined
  right.cuts = cutsR.length ? cutsR : undefined
  return [...clips.slice(0, index), left, right, ...clips.slice(index + 1)]
}

/** "1:05.3" */
export function clock(t: number): string {
  const s = Math.max(0, t)
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}
