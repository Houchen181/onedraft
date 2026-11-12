// Helpers shared by connectors.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { extname } from 'node:path'

export const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif'
}

export const mimeOf = (path: string) => MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream'
export const isVideo = (path: string) => mimeOf(path).startsWith('video/')
export const isImage = (path: string) => mimeOf(path).startsWith('image/')
export const fileSize = (path: string) => statSync(path).size

/** Read [start, start+length) of a file. */
export function readChunk(path: string, start: number, length: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, start)
    return n === length ? buf : buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/** Fetch body from a Buffer slice, typed for fetch's BodyInit. */
export const body = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)

export function requireSetting(get: (k: string) => string | undefined, key: string, what: string): string {
  const v = get(key)?.trim()
  if (!v) throw new Error(`Set ${what} in Settings first.`)
  return v
}

/** Split long text into numbered chunks that each fit `max` (by the given length function). */
export function splitThread(text: string, max: number, measure: (s: string) => number): string[] {
  if (measure(text) <= max) return [text]
  const parts: string[] = []
  const reserve = 6 // room for " 1/9"
  let current = ''
  const pieces = text.split(/(?<=[.!?。！？\n])\s*/)
  for (const piece of pieces) {
    const candidate = current ? `${current} ${piece}` : piece
    if (measure(candidate) <= max - reserve) {
      current = candidate
      continue
    }
    if (current) parts.push(current)
    if (measure(piece) <= max - reserve) {
      current = piece
      continue
    }
    // a single piece longer than a post: hard-wrap by characters
    let rest = piece
    while (measure(rest) > max - reserve) {
      let cut = rest.length
      while (cut > 0 && measure(rest.slice(0, cut)) > max - reserve) cut = Math.floor(cut * 0.9)
      parts.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    current = rest
  }
  if (current) parts.push(current)
  return parts.map((p, i) => `${p} ${i + 1}/${parts.length}`)
}
