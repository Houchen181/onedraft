// Editing by what is said. A transcript (words with times, from local Whisper) turns into:
//  - cuts: deleted words, filler words and long pauses taken out of a clip (EditClip.cuts, source seconds),
//  - captions: the words that survive the edit, placed on the finished video and burned in as ASS subtitles.
//
// Everything here is pure, so the edit engine, the Studio UI and the assistant's tools share one behaviour.
// Cut points are snapped to video frames (keptFrames) and the renderer cuts audio on the same grid, so sound,
// picture and captions never drift apart however many cuts there are.

import type { AutoCaptions, CaptionStyle, EditClip, Word } from './types'

const round3 = (x: number) => Math.round(x * 1000) / 1000

// ---------------------------------------------------------------- what to cut

/** Fillers that are safe to drop on their own. "like", "you know", 就是, 那个 carry meaning too often: Claude decides those. */
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mhm', 'eh', '嗯', '呃', '额', '唔'])
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

export function isFiller(w: Word): boolean {
  return FILLERS.has(bare(w.text))
}

/** CJK scripts have no spaces: their "words" are characters and join without spaces. */
export const isCjk = (s: string) => /[⺀-鿿가-힯豈-﫿＀-￯]/.test(s)

/** Join words into readable text (spaces only between non-CJK words). */
export function joinWords(words: Word[]): string {
  let out = ''
  for (const w of words) {
    const t = w.text.trim()
    if (!t) continue
    if (out && !(isCjk(t[0]) && isCjk(out[out.length - 1])) && !/^[,.!?;:%)\]}，。！？；：、）」』]/.test(t)) out += ' '
    out += t
  }
  return out
}

export interface CutPlan {
  /** Inclusive word index ranges to take out. */
  removeWords?: [number, number][]
  /** Inclusive word index ranges to keep; everything else in the clip goes (highlights). */
  keepWords?: [number, number][]
  removeFillers?: boolean
  /** Shorten every silence between kept words to this many seconds. */
  maxPauseSec?: number
}

/** Stretches to take out of the clip [clipIn, clipOut] (source seconds), merged and sorted. */
export function planCuts(words: Word[], clipIn: number, clipOut: number, plan: CutPlan): [number, number][] {
  const LEAD = 0.12 // keep a breath before a word
  const TAIL = 0.15 // and a little after it
  const inClip = words.map((w, i) => ({ w, i })).filter(({ w }) => w.end > clipIn && w.start < clipOut)
  if (!inClip.length) return []
  const keep = new Map<number, boolean>(inClip.map(({ i }) => [i, !plan.keepWords?.length]))
  for (const [a, b] of plan.keepWords ?? []) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (keep.has(i)) keep.set(i, true)
  for (const [a, b] of plan.removeWords ?? []) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (keep.has(i)) keep.set(i, false)
  if (plan.removeFillers) for (const { w, i } of inClip) if (isFiller(w)) keep.set(i, false)

  // Runs of kept words become kept stretches. The clip's own head and tail stay unless a highlight trims them.
  const firstIdx = inClip[0].i
  const lastIdx = inClip[inClip.length - 1].i
  const trimEnds = !!plan.keepWords?.length
  const kept: [number, number][] = []
  let runStart: number | undefined
  for (let k = 0; k <= inClip.length; k++) {
    const cur = inClip[k]
    const on = cur ? keep.get(cur.i) : false
    if (on && runStart === undefined) runStart = cur.i
    if (!on && runStart !== undefined) {
      const a = runStart
      const b = inClip[k - 1].i
      const start = a === firstIdx && !trimEnds ? clipIn : Math.max(clipIn, a > 0 ? Math.max(words[a - 1].end, words[a].start - LEAD) : words[a].start - LEAD)
      const end = b === lastIdx && !trimEnds ? clipOut : Math.min(clipOut, b + 1 < words.length ? Math.min(words[b + 1].start, words[b].end + TAIL) : words[b].end + TAIL)
      if (end > start) kept.push([start, end])
      runStart = undefined
    }
  }

  // Long silences between kept words shrink to maxPauseSec (half kept on each side).
  if (plan.maxPauseSec !== undefined && plan.maxPauseSec >= 0) {
    const p = plan.maxPauseSec
    const gaps: [number, number][] = []
    const keptWords = inClip.filter(({ i }) => keep.get(i)).map(({ w }) => w)
    for (let k = 0; k + 1 < keptWords.length; k++) {
      const g0 = keptWords[k].end
      const g1 = keptWords[k + 1].start
      if (g1 - g0 > p + 0.05) gaps.push([g0 + p / 2, g1 - p / 2])
    }
    if (keptWords.length) {
      const head = keptWords[0].start - clipIn
      if (!trimEnds && head > p + 0.05) gaps.push([clipIn, keptWords[0].start - Math.max(p / 2, LEAD)])
      const tail = clipOut - keptWords[keptWords.length - 1].end
      if (!trimEnds && tail > p + 0.05) gaps.push([keptWords[keptWords.length - 1].end + Math.max(p / 2, TAIL), clipOut])
    }
    return mergeCuts([...complement(kept, clipIn, clipOut), ...gaps], clipIn, clipOut)
  }
  return mergeCuts(complement(kept, clipIn, clipOut), clipIn, clipOut)
}

function complement(kept: [number, number][], a: number, b: number): [number, number][] {
  const out: [number, number][] = []
  let cursor = a
  for (const [s, e] of [...kept].sort((x, y) => x[0] - y[0])) {
    if (s > cursor) out.push([cursor, s])
    cursor = Math.max(cursor, e)
  }
  if (b > cursor) out.push([cursor, b])
  return out
}

/** Sort, clip to the clip, merge overlapping cuts and drop slivers. */
export function mergeCuts(cuts: [number, number][], clipIn = 0, clipOut = Infinity): [number, number][] {
  const sorted = cuts
    .map(([s, e]) => [Math.max(clipIn, Math.min(s, e)), Math.min(clipOut, Math.max(s, e))] as [number, number])
    .filter(([s, e]) => e - s > 0.001)
    .sort((x, y) => x[0] - y[0])
  const out: [number, number][] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c[0] <= last[1] + 0.02) last[1] = Math.max(last[1], c[1])
    else out.push([c[0], c[1]])
  }
  return out.filter(([s, e]) => e - s >= 0.04).map(([s, e]) => [round3(s), round3(e)])
}

/** Is source time t inside one of the cuts? */
export const isCut = (cuts: [number, number][] | undefined, t: number) => !!cuts?.some(([s, e]) => t >= s && t < e)

// ---------------------------------------------------------------- frames kept by an edit

/**
 * The frames of a clip that play, as half-open frame ranges counted from its in point, at `fps`.
 * The renderer selects exactly these video frames and the same stretches of sound.
 */
export function keptFrames(clipIn: number, clipOut: number, cuts: [number, number][] | undefined, fps: number): [number, number][] {
  const total = Math.max(0, Math.round((clipOut - clipIn) * fps))
  if (!cuts?.length) return total ? [[0, total]] : []
  const ranges: [number, number][] = []
  let cursor = 0
  for (const [s, e] of mergeCuts(cuts, clipIn, clipOut)) {
    const a = Math.max(cursor, Math.round((s - clipIn) * fps))
    const b = Math.min(total, Math.round((e - clipIn) * fps))
    if (a > cursor) ranges.push([cursor, a])
    cursor = Math.max(cursor, b)
  }
  if (total > cursor) ranges.push([cursor, total])
  return ranges.filter(([a, b]) => b > a)
}

/** Seconds a clip keeps after its cuts (before speed). */
export const keptSeconds = (clipIn: number, clipOut: number, cuts: [number, number][] | undefined, fps: number) =>
  keptFrames(clipIn, clipOut, cuts, fps).reduce((s, [a, b]) => s + (b - a), 0) / fps

// ---------------------------------------------------------------- words on the finished video

export interface ClipPlacement {
  clip: EditClip
  /** The clip's in/out as rendered (clamped to the file). */
  in: number
  out: number
  /** Where the clip starts on the finished video, seconds. */
  at: number
  speed: number
  /** Its transcript, if it has speech. */
  words?: Word[]
}

/** Where each surviving word lands on the finished video. Cut words and words outside in/out are dropped. */
export function placeWords(clips: ClipPlacement[], fps: number): Word[] {
  const out: Word[] = []
  for (const c of clips) {
    if (!c.words?.length || c.clip.mute) continue
    const frames = keptFrames(c.in, c.out, c.clip.cuts, fps)
    // Source time → seconds into the clip's output (before speed), or undefined if it was cut.
    const map = (t: number): number | undefined => {
      let before = 0
      for (const [a, b] of frames) {
        const s = c.in + a / fps
        const e = c.in + b / fps
        if (t >= s && t < e) return before + (t - s)
        before += (b - a) / fps
      }
      return undefined
    }
    for (const w of c.words) {
      const mid = (w.start + w.end) / 2
      const m = map(mid)
      if (m === undefined) continue
      const s = map(Math.max(w.start, c.in)) ?? m
      const e = map(Math.min(w.end, c.out) - 1e-4) ?? m
      out.push({ text: w.text, start: round3(c.at + Math.min(s, m) / c.speed), end: round3(c.at + Math.max(e, m) / c.speed) })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

// ---------------------------------------------------------------- captions

export interface CaptionLine {
  words: Word[]
  start: number
  end: number
}

const DEFAULT_WORDS: Record<CaptionStyle, number> = { clean: 7, boxed: 7, highlight: 6, pop: 3 }

/** Group words into caption lines: a few words each, breaking at sentence ends and pauses. */
export function captionLines(words: Word[], opts: AutoCaptions = {}): CaptionLine[] {
  const style = opts.style ?? 'highlight'
  const latinMax = Math.max(1, opts.maxWords ?? DEFAULT_WORDS[style])
  const lines: CaptionLine[] = []
  let cur: Word[] = []
  const flush = () => {
    if (cur.length) lines.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end })
    cur = []
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (!w.text.trim()) continue
    const cjk = isCjk(w.text)
    // A Chinese "word" is one character: allow more of them per line.
    const max = cjk ? Math.round(latinMax * (style === 'pop' ? 2.5 : 2.2)) : latinMax
    const prev = cur[cur.length - 1]
    if (prev && (cur.length >= max || w.start - prev.end > 0.7 || /[.!?。！？]$/.test(prev.text.trim()))) flush()
    cur.push(w)
  }
  flush()
  // Each line stays up a little after its last word, but never over the next line.
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1]
    lines[i].end = round3(Math.min(lines[i].end + 0.25, next ? next.start : Infinity))
  }
  return lines
}

const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor(cs / 6000) % 60
  const sec = Math.floor(cs / 100) % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}
/** Text as ASS shows it: no override braces, no stray backslashes, no line breaks. */
const assText = (s: string) => s.replace(/[{}]/g, '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim()

/** Split a line into at most two rows of similar width, so it never runs off a vertical video. */
function rows(words: Word[], maxUnits: number): Word[][] {
  const units = (w: Word) => [...w.text.trim()].reduce((s, ch) => s + (isCjk(ch) ? 1 : 0.56), 0) + (isCjk(w.text) ? 0 : 0.3)
  const total = words.reduce((s, w) => s + units(w), 0)
  if (total <= maxUnits || words.length < 2) return [words]
  let acc = 0
  let split = 1
  for (let i = 0; i < words.length; i++) {
    acc += units(words[i])
    if (acc >= total / 2) {
      split = Math.max(1, Math.min(words.length - 1, acc - units(words[i]) / 2 > total / 2 ? i : i + 1))
      break
    }
  }
  return [words.slice(0, split), words.slice(split)]
}

const HIGHLIGHT = '&H0000D4FF&' // ASS colours are &HBBGGRR&: this is #FFD400

/** The burned-in captions as an ASS subtitle file sized for a W×H video. */
export function buildAss(lines: CaptionLine[], o: AutoCaptions & { width: number; height: number; font?: string }): string {
  const style = o.style ?? 'highlight'
  const { width: W, height: H } = o
  const vertical = H > W
  const base = vertical ? W : H // size text by the short side so 9:16 and 16:9 read alike
  const size = Math.round(base * (style === 'pop' ? 0.085 : style === 'highlight' ? 0.068 : 0.058))
  const outline = Math.max(2, Math.round(size * (style === 'boxed' ? 0.28 : 0.09)))
  const position = o.position ?? 'bottom'
  const align = position === 'top' ? 8 : position === 'center' ? 5 : 2
  const marginV = Math.round(H * (position === 'center' ? 0 : vertical ? (position === 'bottom' ? 0.22 : 0.12) : 0.08))
  const marginH = Math.round(W * 0.07)
  const bold = style === 'pop' || style === 'highlight' ? -1 : 0
  const borderStyle = style === 'boxed' ? 3 : 1
  const outlineColour = style === 'boxed' ? '&H60000000' : '&H00000000'
  const backColour = style === 'boxed' ? '&H60000000' : '&H80000000'
  const font = o.font ?? 'Microsoft YaHei'
  const maxUnits = ((W - 2 * marginH) / size) * 0.95
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${font},${size},&H00FFFFFF,&H00FFFFFF,${outlineColour},${backColour},${bold},0,0,0,100,100,0,0,${borderStyle},${outline},${style === 'boxed' ? 0 : Math.round(outline / 2)},${align},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  const events: string[] = []
  const render = (line: CaptionLine, active?: number) =>
    rows(line.words, maxUnits)
      .map((row) => {
        let s = ''
        for (const w of row) {
          const i = line.words.indexOf(w)
          const t = assText(style === 'pop' ? w.text.toUpperCase() : w.text)
          if (!t) continue
          const sep = s && !(isCjk(t[0]) && isCjk(s.replace(/\{[^}]*\}/g, '').slice(-1))) && !/^[,.!?;:，。！？；：、]/.test(t) ? ' ' : ''
          s += sep + (i === active ? `{\\c${HIGHLIGHT}${style === 'pop' ? '\\fscx112\\fscy112' : ''}}${t}{\\r}` : t)
        }
        return s
      })
      .join('\\N')
  for (const line of lines) {
    if (style === 'clean' || style === 'boxed') {
      events.push(`Dialogue: 0,${assTime(line.start)},${assTime(line.end)},Cap,,0,0,0,,${render(line)}`)
      continue
    }
    // highlight / pop: one event per word, the line with that word lit, until the next word starts.
    line.words.forEach((w, i) => {
      const from = i === 0 ? line.start : w.start
      const to = i + 1 < line.words.length ? line.words[i + 1].start : line.end
      if (to - from >= 0.01) events.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Cap,,0,0,0,,${render(line, i)}`)
    })
  }
  return `${[...head, ...events].join('\n')}\n`
}
