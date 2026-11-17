// Plays the whole edit the way it will come out, without rendering: clips in order with their cuts skipped and at
// their speed, framed to the output shape, with on-screen text, word-timed captions, music, logo and fades drawn on
// top. A timeline strip below shows the kept stretches; click it to seek. (Crossfades only appear in the render.)

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { EditSpec, MediaInfo, Transcript, Word } from '@shared/types'
import { clock, editDuration, editSegments, segmentAt, type Segment } from '@shared/timeline'
import { captionLines, placeWords, type CaptionLine } from '@shared/transcript'
import { call, fileName, mediaUrl, on } from '../api'

export interface PreviewControls {
  toggle(): void
  pause(): void
  seek(t: number): void
  nudge(dt: number): void
  time(): number
  duration(): number
}

const RATIOS: Record<string, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4 }
const CLIP_COLORS = ['#2f6b57', '#5b5bf6', '#a8620f', '#2f6fbd', '#c0392b', '#7a4fb3']

export function EditPreview(props: {
  spec: EditSpec
  infos: Record<string, MediaInfo>
  selected?: number
  onSelect?: (clip: number) => void
  controls: RefObject<PreviewControls | null>
}) {
  const { spec, infos } = props
  const files = spec.clips.map((c) => (infos[c.src] ? { durationSec: infos[c.src].durationSec, image: infos[c.src].kind === 'image' } : undefined))
  const segments = useMemo(() => editSegments(spec, files), [JSON.stringify(spec.clips), JSON.stringify(files), spec.fps]) // eslint-disable-line react-hooks/exhaustive-deps
  const total = editDuration(segments)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [shown, setShown] = useState<Segment>()
  const tRef = useRef(0)
  const playingRef = useRef(false)
  const segRef = useRef<Segment | undefined>(undefined)
  const video = useRef<HTMLVideoElement>(null)
  const music = useRef<HTMLAudioElement>(null)
  const blur = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 640, h: 400 })

  // ---- output shape: the largest frame of that shape that fits the stage ----
  const first = spec.clips.map((c) => infos[c.src]).find((i) => i?.width && i?.height)
  const ratio = (spec.aspect && RATIOS[spec.aspect]) || (first ? first.width! / first.height! : 16 / 9)
  const fit = spec.fit ?? 'blur'
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const frameH = Math.max(40, Math.min(box.h, box.w / ratio))

  // ---- captions from speech: the cached transcripts, placed like the render places them ----
  const [transcripts, setTranscripts] = useState<Record<string, Word[]>>({})
  const sources = [...new Set(spec.clips.filter((c) => infos[c.src]?.kind === 'video' && infos[c.src]?.hasAudio).map((c) => c.src))]
  useEffect(() => {
    if (!spec.autoCaptions) return
    const load = () =>
      void Promise.all(sources.map((s) => call<Transcript | undefined>('speech.cached', s).then((x) => [s, x?.words] as const))).then((pairs) =>
        setTranscripts(Object.fromEntries(pairs.filter(([, w]) => w)) as Record<string, Word[]>)
      )
    load()
    return on('changed', (k) => k === 'transcripts' && load())
  }, [!!spec.autoCaptions, sources.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  const lines: CaptionLine[] = useMemo(() => {
    if (!spec.autoCaptions) return []
    const placements = spec.clips.flatMap((c, i) => {
      const s = segments.find((x) => x.clip === i)
      const info = infos[c.src]
      if (!s || !info || info.kind !== 'video' || !transcripts[c.src]) return []
      const full = info.durationSec ?? 0
      const lo = Math.min(Math.max(0, c.in ?? 0), full)
      return [{ clip: c, in: lo, out: Math.min(Math.max(lo, c.out ?? full), full), at: s.outStart, speed: s.speed, words: transcripts[c.src] }]
    })
    return captionLines(placeWords(placements, spec.fps ?? 30), spec.autoCaptions)
  }, [segments, transcripts, spec.autoCaptions, spec.fps]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- playback ----
  const show = (s: Segment | undefined, at: number) => {
    segRef.current = s
    setShown(s)
    const v = video.current
    if (!s || s.image || !v) return
    const url = mediaUrl(s.src)
    const target = s.srcStart + (at - s.outStart) * s.speed
    const clip = spec.clips[s.clip]
    v.muted = !!clip?.mute
    v.volume = Math.min(1, Math.max(0, clip?.volume ?? 1))
    v.playbackRate = s.speed
    if (v.dataset.src !== url) {
      v.dataset.src = url
      v.src = url
      v.addEventListener(
        'loadedmetadata',
        () => {
          v.currentTime = target
          v.playbackRate = s.speed
          if (playingRef.current) void v.play().catch(() => undefined)
        },
        { once: true }
      )
    } else {
      if (Math.abs(v.currentTime - target) > 0.04) v.currentTime = target
      if (playingRef.current) void v.play().catch(() => undefined)
    }
  }
  const seek = (to: number) => {
    const x = Math.min(Math.max(0, to), Math.max(0, total - 0.001))
    tRef.current = x
    setT(x)
    show(segmentAt(segments, x)?.segment, x)
    const m = music.current
    if (m && Number.isFinite(m.duration) && m.duration > 0) m.currentTime = x % m.duration
  }
  const pause = () => {
    playingRef.current = false
    setPlaying(false)
    video.current?.pause()
    music.current?.pause()
  }
  const play = () => {
    if (!segments.length) return
    if (tRef.current >= total - 0.05) seek(0)
    playingRef.current = true
    setPlaying(true)
    show(segmentAt(segments, tRef.current)?.segment, tRef.current)
    if (music.current) void music.current.play().catch(() => undefined)
  }
  useImperativeHandle(props.controls, () => ({
    toggle: () => (playingRef.current ? pause() : play()),
    pause,
    seek,
    nudge: (dt) => seek(tRef.current + dt),
    time: () => tRef.current,
    duration: () => total
  }))

  // The clock: video time while a video plays, wall time for images; move on at the end of each stretch.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const s = segRef.current
      if (playingRef.current && s) {
        const v = video.current
        let next = tRef.current
        if (s.image) next += dt
        else if (v && !v.seeking && v.readyState >= 2) next = s.outStart + (v.currentTime - s.srcStart) / s.speed
        if (next >= s.outEnd - 0.012) {
          const i = segments.indexOf(s)
          const after = segments[i + 1]
          if (after) {
            tRef.current = after.outStart
            show(after, after.outStart)
          } else {
            tRef.current = total
            pause()
          }
        } else tRef.current = Math.max(s.outStart, next)
        setT(tRef.current)
      }
      // Blurred background: the current frame, small and blurred by CSS.
      const c = blur.current
      const v = video.current
      if (fit === 'blur' && c && v && v.readyState >= 2) c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [segments, total, fit]) // eslint-disable-line react-hooks/exhaustive-deps

  // A new edit (Claude changed it, a cut was made): stay at the same time.
  useEffect(() => {
    seek(Math.min(tRef.current, total))
  }, [segments]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- overlays ----
  const H = frameH
  const W = H * ratio
  const short = Math.min(W, H)
  const vertical = H > W
  const line = lines.find((l) => t >= l.start && t < l.end)
  const style = spec.autoCaptions?.style ?? 'highlight'
  const capSize = short * (style === 'pop' ? 0.085 : style === 'highlight' ? 0.068 : 0.058)
  const capPos: CSSProperties =
    (spec.autoCaptions?.position ?? 'bottom') === 'top'
      ? { top: H * (vertical ? 0.12 : 0.08) }
      : spec.autoCaptions?.position === 'center'
        ? { top: '50%', transform: 'translateY(-50%)' }
        : { bottom: H * (vertical ? 0.22 : 0.08) }
  const srt = !spec.autoCaptions ? spec.captions?.find((c) => t >= c.start && t < c.end) : undefined
  const fade = Math.max(spec.fadeInSec && t < spec.fadeInSec ? 1 - t / spec.fadeInSec : 0, spec.fadeOutSec && t > total - spec.fadeOutSec ? (t - (total - spec.fadeOutSec)) / spec.fadeOutSec : 0)
  const objectFit = fit === 'crop' ? 'cover' : 'contain'

  return (
    <div className="ep">
      <div className="ep-stage" ref={stage}>
        <div className="ep-frame" style={{ width: frameH * ratio, height: frameH }} onClick={() => (playingRef.current ? pause() : play())}>
          {fit === 'blur' && <canvas ref={blur} width={48} height={27} className="ep-blur" />}
          <video ref={video} className="ep-video" style={{ objectFit, display: shown?.image ? 'none' : 'block' }} playsInline />
          {shown?.image && <img className="ep-video" style={{ objectFit }} src={mediaUrl(shown.src)} alt="" />}
          {spec.logo && (
            <img
              src={mediaUrl(spec.logo.src)}
              alt=""
              className="ep-logo"
              style={{
                width: W * (spec.logo.widthFraction ?? 0.14),
                opacity: spec.logo.opacity ?? 0.9,
                [spec.logo.position?.startsWith('bottom') ? 'bottom' : 'top']: short * 0.035,
                [spec.logo.position?.endsWith('left') ? 'left' : 'right']: short * 0.035
              }}
            />
          )}
          {(spec.texts ?? [])
            .filter((x) => t >= x.start && t < x.end)
            .map((x, i) => (
              <div
                key={i}
                className="ep-text"
                style={{
                  fontSize: H * (x.size ?? 0.045),
                  color: x.color ?? '#fff',
                  ...(x.position === 'top' ? { top: H * 0.08 } : x.position === 'bottom' ? { bottom: H * (vertical ? 0.2 : 0.08) } : { top: '50%', transform: 'translateY(-50%)' })
                }}
              >
                <span className={x.box ? 'box' : ''}>{x.text}</span>
              </div>
            ))}
          {line && (
            <div className={`ep-cap ${style}`} style={{ fontSize: capSize, ...capPos }}>
              {line.words.map((w, i) => {
                const active = (style === 'highlight' || style === 'pop') && t >= w.start && (i + 1 < line.words.length ? t < line.words[i + 1].start : true)
                return (
                  <span key={i} className={active ? 'on' : ''}>
                    {style === 'pop' ? w.text.toUpperCase() : w.text}
                    {i + 1 < line.words.length && !/^[⺀-鿿]/.test(line.words[i + 1].text) ? ' ' : ''}
                  </span>
                )
              })}
            </div>
          )}
          {srt && (
            <div className="ep-cap boxed" style={{ fontSize: H * (vertical ? 0.032 : 0.042), bottom: H * 0.06 }}>
              {srt.text}
            </div>
          )}
          {fade > 0 && <div className="ep-fade" style={{ opacity: Math.min(1, fade) }} />}
          {!segments.length && <div className="ep-empty">Add clips to see the edit here.</div>}
        </div>
      </div>
      {spec.music?.src && <audio ref={music} src={mediaUrl(spec.music.src)} loop style={{ display: 'none' }} onLoadedMetadata={(e) => (e.currentTarget.volume = Math.min(1, spec.music?.volume ?? 0.25))} />}
      <div className="row ep-controls">
        <button className="btn sm" onClick={() => (playing ? pause() : play())} disabled={!segments.length} title="Space">
          {playing ? '❚❚ Pause' : '▶ Play the edit'}
        </button>
        <span className="mono small">
          {clock(t)} / {clock(total)}
        </span>
        <input type="range" className="grow" min={0} max={Math.max(0.01, total)} step={0.01} value={Math.min(t, total)} onChange={(e) => seek(Number(e.target.value))} />
      </div>
      <div
        className="ep-strip"
        onMouseDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const to = ((e.clientX - r.left) / r.width) * total
          seek(to)
          const hit = segmentAt(segments, to)
          if (hit) props.onSelect?.(hit.segment.clip)
        }}
      >
        {segments.map((s, i) => (
          <div
            key={i}
            className={`ep-seg ${s.clip === props.selected ? 'on' : ''}`}
            title={`${fileName(s.src)} · ${clock(s.srcStart)}–${clock(s.srcEnd)} of the file`}
            style={{ left: `${(s.outStart / (total || 1)) * 100}%`, width: `${((s.outEnd - s.outStart) / (total || 1)) * 100}%`, background: CLIP_COLORS[s.clip % CLIP_COLORS.length] }}
          />
        ))}
        {lines.map((l, i) => (
          <div key={`c${i}`} className="ep-capmark" style={{ left: `${(l.start / (total || 1)) * 100}%`, width: `${((l.end - l.start) / (total || 1)) * 100}%` }} />
        ))}
        <div className="ep-head" style={{ left: `${(t / (total || 1)) * 100}%` }} />
      </div>
    </div>
  )
}
