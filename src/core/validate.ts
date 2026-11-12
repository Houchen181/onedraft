// Merge master + variant into what a connector receives, and check it against the platform's rules
// before anything is queued. The same checks feed the UI, the agent and the publisher.

import type { Constraints, Issue, MediaInfo, PlatformManifest, Post, ResolvedContent, Target } from '../shared/types'

export function resolveContent(post: Post, target: Target): ResolvedContent {
  const v = target.variant
  return {
    title: v.title ?? post.title,
    caption: v.caption ?? post.body,
    tags: v.tags ?? post.tags,
    media: v.media ?? post.media,
    cover: v.cover,
    options: v.options ?? {},
    aiGenerated: post.aiGenerated
  }
}

/** Fill in option defaults declared by the platform (unset options take their default). */
export function withOptionDefaults(manifest: PlatformManifest, c: ResolvedContent): ResolvedContent {
  const defaults: Record<string, unknown> = {}
  for (const f of manifest.options) if (f.default !== undefined) defaults[f.key] = f.default
  const set = Object.fromEntries(Object.entries(c.options).filter(([, v]) => v !== undefined && v !== ''))
  return { ...c, options: { ...defaults, ...set } }
}

/** Tags written as hashtags at the end of the caption, skipping ones already in the text. */
export function captionWithHashtags(caption: string, tags: string[]): string {
  const missing = tags
    .map((t) => t.trim().replace(/^#/, '').replace(/\s+/g, ''))
    .filter(Boolean)
    .filter((t) => !caption.toLowerCase().includes(`#${t.toLowerCase()}`))
  if (!missing.length) return caption
  const sep = caption.trim() ? '\n\n' : ''
  return `${caption.trim()}${sep}${missing.map((t) => `#${t}`).join(' ')}`
}

/** X counts URLs as 23 and CJK/emoji as 2. */
export function weightedLength(text: string): number {
  let n = 0
  const urlRe = /https?:\/\/\S+/g
  const withoutUrls = text.replace(urlRe, () => {
    n += 23
    return ''
  })
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) ?? 0
    const light =
      (cp >= 0x0000 && cp <= 0x10ff) ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037)
    n += light ? 1 : 2
  }
  return n
}

export function parseAspect(a: string): number {
  const [w, h] = a.split(':').map(Number)
  return w && h ? w / h : NaN
}

export function aspectOf(m: MediaInfo): number | undefined {
  return m.width && m.height ? m.width / m.height : undefined
}

/** Closest named aspect for display, e.g. 0.5625 -> '9:16'. */
export function nameAspect(ratio: number): string {
  const named = ['9:16', '3:4', '4:5', '1:1', '4:3', '16:9', '1.91:1', '21:9']
  let best = named[0]
  for (const a of named) if (Math.abs(parseAspect(a) - ratio) < Math.abs(parseAspect(best) - ratio)) best = a
  return Math.abs(parseAspect(best) - ratio) / ratio < 0.03 ? best : ratio.toFixed(2)
}

function aspectOk(ratio: number, allowed: string[]): boolean {
  return allowed.some((a) => {
    if (a.includes('-')) {
      // range like '4:5-1.91:1'
      const [lo, hi] = a.split('-').map(parseAspect)
      return ratio >= Math.min(lo, hi) * 0.99 && ratio <= Math.max(lo, hi) * 1.01
    }
    return Math.abs(parseAspect(a) - ratio) / parseAspect(a) < 0.02
  })
}

const len = (s: string, unit: 'chars' | 'bytes' | 'weighted' = 'chars') =>
  unit === 'bytes' ? Buffer.byteLength(s, 'utf8') : unit === 'weighted' ? weightedLength(s) : [...s].length

export function validateContent(manifest: PlatformManifest, c: ResolvedContent, media: MediaInfo[]): Issue[] {
  const k: Constraints = manifest.constraints
  const caps = manifest.capabilities
  const issues: Issue[] = []
  const err = (field: string, message: string) => issues.push({ level: 'error', field, message })
  const warn = (field: string, message: string) => issues.push({ level: 'warning', field, message })

  if (k.title) {
    if (k.title.required && !c.title.trim()) err('title', `${manifest.name} needs a title.`)
    if (len(c.title) > k.title.max) err('title', `Title is ${len(c.title)} characters; ${manifest.name} allows ${k.title.max}.`)
  }

  const caption = k.tags?.style === 'hashtags' ? captionWithHashtags(c.caption, c.tags) : c.caption
  if (k.caption) {
    const n = len(caption, k.caption.unit)
    if (n > k.caption.max && k.caption.overflow === 'thread' && c.options.thread !== false)
      warn('caption', `Text is ${n} characters, over ${manifest.name}'s ${k.caption.max}; it will go out as a thread of ${Math.ceil(n / (k.caption.max - 6))}.`)
    else if (n > k.caption.max)
      err('caption', `Caption is ${n} ${k.caption.unit ?? 'characters'} (with hashtags); ${manifest.name} allows ${k.caption.max}.`)
    if (k.caption.required && !caption.trim()) err('caption', `${manifest.name} needs text.`)
  }

  if (k.tags) {
    if (k.tags.required && !c.tags.length) err('tags', `${manifest.name} needs at least one tag.`)
    if (k.tags.max !== undefined && c.tags.length > k.tags.max) err('tags', `${c.tags.length} tags; ${manifest.name} allows ${k.tags.max}.`)
    if (k.tags.maxEach) for (const t of c.tags) if (len(t) > k.tags.maxEach) err('tags', `Tag "${t}" is longer than ${k.tags.maxEach} characters.`)
    if (k.tags.maxTotalChars) {
      const total = c.tags.reduce((s, t) => s + len(t) + (t.includes(' ') ? 2 : 0), 0) + Math.max(0, c.tags.length - 1)
      if (total > k.tags.maxTotalChars) err('tags', `Tags add up to ${total} characters; ${manifest.name} allows ${k.tags.maxTotalChars}.`)
    }
  }

  const videos = media.filter((m) => m.kind === 'video')
  const images = media.filter((m) => m.kind === 'image')
  if (!media.length) {
    if (k.media?.required || !caps.text) err('media', `${manifest.name} needs a video or image.`)
  }
  if (videos.length && !caps.video) err('media', `${manifest.name} connector cannot post video.`)
  if (images.length && !caps.image) err('media', `${manifest.name} connector cannot post images.`)
  if (videos.length && images.length && !k.media?.mixed) err('media', `${manifest.name} does not mix video and images in one post.`)
  if (k.media?.maxVideos !== undefined && videos.length > k.media.maxVideos)
    err('media', `${videos.length} videos; ${manifest.name} takes ${k.media.maxVideos} per post.`)

  for (const v of videos) {
    const name = v.path.split(/[\\/]/).pop()
    const kv = k.video
    if (!kv) continue
    if (kv.maxSec && v.durationSec && v.durationSec > kv.maxSec)
      err('media', `${name} is ${Math.round(v.durationSec)} s; ${manifest.name} allows ${kv.maxSec} s.`)
    if (kv.minSec && v.durationSec && v.durationSec < kv.minSec)
      err('media', `${name} is ${v.durationSec.toFixed(1)} s; ${manifest.name} needs at least ${kv.minSec} s.`)
    if (kv.maxBytes && v.sizeBytes > kv.maxBytes)
      err('media', `${name} is ${(v.sizeBytes / 1e6).toFixed(0)} MB; ${manifest.name} allows ${(kv.maxBytes / 1e6).toFixed(0)} MB.`)
    const r = aspectOf(v)
    if (r && kv.aspects?.length && !aspectOk(r, kv.aspects))
      err('media', `${name} is ${nameAspect(r)}; ${manifest.name} accepts ${kv.aspects.join(', ')}. Use "Fit media" to convert.`)
    else if (r && kv.preferredAspect && !aspectOk(r, [kv.preferredAspect]))
      warn('media', `${name} is ${nameAspect(r)}; ${manifest.name} looks best at ${kv.preferredAspect}.`)
    const ext = v.path.split('.').pop()?.toLowerCase()
    if (kv.formats?.length && ext && !kv.formats.includes(ext)) err('media', `${name}: ${manifest.name} takes ${kv.formats.join(', ')}.`)
  }

  if (images.length && k.image) {
    if (images.length > k.image.maxCount) err('media', `${images.length} images; ${manifest.name} allows ${k.image.maxCount}.`)
    for (const im of images) {
      const name = im.path.split(/[\\/]/).pop()
      if (k.image.maxBytes && im.sizeBytes > k.image.maxBytes)
        err('media', `${name} is ${(im.sizeBytes / 1e6).toFixed(1)} MB; ${manifest.name} allows ${(k.image.maxBytes / 1e6).toFixed(0)} MB.`)
      const ext = im.path.split('.').pop()?.toLowerCase()
      if (k.image.formats?.length && ext && !k.image.formats.includes(ext))
        err('media', `${name}: ${manifest.name} takes ${k.image.formats.join(', ')}.`)
      const r = aspectOf(im)
      if (r && k.image.preferredAspect && !aspectOk(r, [k.image.preferredAspect]))
        warn('media', `${name} is ${nameAspect(r)}; ${manifest.name} looks best at ${k.image.preferredAspect}.`)
    }
  }

  return issues
}
