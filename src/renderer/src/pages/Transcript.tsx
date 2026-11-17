// Edit a clip by what is said: its transcript, word by word. Delete words (drag to select, then Delete),
// drop filler words, shorten pauses. The cuts land on the clip (EditClip.cuts) like any other edit, so the
// render, Claude and this panel all agree. The player skips cut stretches so you hear the edit.

import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { EditClip, MediaInfo, SpeechStatus, Transcript } from '@shared/types'
import { isCjk, isCut, isFiller, mergeCuts, planCuts, type CutPlan } from '@shared/transcript'
import { call, on, useData } from '../api'
import { useApp } from '../ui'

/** Take [s, e] back out of the cuts (restore what was said there). */
function uncut(cuts: [number, number][], s: number, e: number): [number, number][] {
  return cuts.flatMap(([a, b]): [number, number][] => {
    if (b <= s || a >= e) return [[a, b]]
    return [...(a < s ? [[a, s] as [number, number]] : []), ...(b > e ? [[e, b] as [number, number]] : [])]
  })
}

export function TranscriptPanel({ clip, info, player, onCuts }: { clip: EditClip; info?: MediaInfo; player: RefObject<HTMLVideoElement | null>; onCuts: (cuts?: [number, number][]) => void }) {
  const app = useApp()
  const { data: speech } = useData<SpeechStatus>('speech.status', [], ['speech'])
  const [t, setT] = useState<Transcript>()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number>()
  const [sel, setSel] = useState<[number, number]>()
  const [now, setNow] = useState<number>()
  const [pause, setPause] = useState(0.4)
  const [skip, setSkip] = useState(true)
  /** A word being corrected (Whisper misheard it). */
  const [editing, setEditing] = useState<{ i: number; text: string }>()
  const drag = useRef<number | undefined>(undefined)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setT(undefined)
    setSel(undefined)
    setEditing(undefined)
    const load = () => void call<Transcript | undefined>('speech.cached', clip.src).then((x) => x && setT(x))
    load()
    // Claude may transcribe or correct this clip meanwhile.
    return on('changed', (k) => k === 'transcripts' && load())
  }, [clip.src])
  useEffect(
    () =>
      on('progress', (p) => {
        const x = p as { scope?: string; fraction: number }
        if (x.scope === `transcribe:${clip.src}`) setProgress(x.fraction)
      }),
    [clip.src]
  )
  useEffect(() => {
    const up = () => (drag.current = undefined)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const cuts = useMemo(() => clip.cuts ?? [], [clip.cuts])
  const clipIn = clip.in ?? 0
  const clipOut = clip.out ?? info?.durationSec ?? Infinity

  // Follow the player: light the word being said, and jump over cut stretches while it plays.
  useEffect(() => {
    const v = player.current
    if (!v || !t) return
    let raf = 0
    const tick = () => {
      const time = v.currentTime
      if (skip && !v.paused) {
        const c = cuts.find(([a, b]) => time >= a && time < b - 0.02)
        if (c) v.currentTime = c[1]
      }
      const i = t.words.findIndex((w) => time >= w.start && time < w.end + 0.05)
      setNow(i >= 0 ? i : undefined)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [player, t, cuts, skip])

  if (!info || info.kind !== 'video') return null
  if (!info.hasAudio) return <div className="muted small">This clip has no sound, so there is nothing to transcribe.</div>

  const transcribe = async () => {
    setBusy(true)
    try {
      setT(await call<Transcript>('speech.transcribe', clip.src))
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(false)
      setProgress(undefined)
    }
  }
  const install = async () => {
    try {
      await call('speech.install')
      app.toast('Speech-to-text is ready.')
    } catch (e) {
      app.toast((e as Error).message, true)
    }
  }

  if (!t) {
    if (!speech?.installed) {
      const mb = speech?.downloads.reduce((s, d) => s + d.mb, 0) ?? 0
      return (
        <div className="stack" style={{ gap: 8 }}>
          <p className="muted small" style={{ margin: 0 }}>
            Edit by what is said: delete words, drop “um”s and long pauses, add word-by-word captions. It needs Whisper, which runs on this PC (nothing is uploaded).
          </p>
          {speech?.installing ? (
            <div>
              <div className="progress">
                <div style={{ width: `${Math.round(speech.installing.fraction * 100)}%` }} />
              </div>
              <div className="small faint">{speech.installing.note}</div>
            </div>
          ) : (
            <div className="row">
              <button className="btn primary sm" onClick={() => void install()}>
                Set up speech-to-text
              </button>
              <span className="small faint">One-time download, about {mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`}.</span>
            </div>
          )}
          {speech?.error && <div className="issue error">{speech.error}</div>}
        </div>
      )
    }
    return (
      <div className="row">
        <button className="btn primary sm" disabled={busy} onClick={() => void transcribe()}>
          {busy ? 'Listening…' : 'Transcribe this clip'}
        </button>
        {busy && progress !== undefined && <span className="small faint">{Math.round(progress * 100)}%</span>}
        <span className="small faint">Whisper writes down every word with its time; then you can edit the text.</span>
      </div>
    )
  }

  const words = t.words
  const inRange = (i: number) => words[i].end > clipIn && words[i].start < clipOut
  const removed = (i: number) => !inRange(i) || isCut(cuts, (words[i].start + words[i].end) / 2)
  const apply = (plan: CutPlan) => onCuts(mergeCuts([...cuts, ...planCuts(words, clipIn, clipOut, plan)], clipIn, clipOut))
  const restore = (a: number, b: number) => {
    const next = mergeCuts(uncut(cuts, words[a].start - 0.15, words[b].end + 0.15), clipIn, clipOut)
    onCuts(next.length ? next : undefined)
  }
  const fillers = words.filter((w, i) => isFiller(w) && !removed(i)).length
  const lo = sel ? Math.min(...sel) : -1
  const hi = sel ? Math.max(...sel) : -1
  const selCut = sel ? words.slice(lo, hi + 1).some((_, k) => removed(lo + k)) : false
  const cutSec = cuts.reduce((s, [a, b]) => s + b - a, 0)
  const del = () => {
    if (!sel) return
    if (selCut) restore(lo, hi)
    else apply({ removeWords: [[lo, hi]] })
    setSel(undefined)
  }
  const startFix = () => sel && lo === hi && setEditing({ i: lo, text: words[lo].text })
  const saveFix = async () => {
    const e = editing
    setEditing(undefined)
    if (!e || !e.text.trim() || e.text.trim() === words[e.i].text) return
    try {
      setT(await call<Transcript>('speech.fixWords', clip.src, [[e.i, e.text]]))
    } catch (err) {
      app.toast((err as Error).message, true)
    }
    box.current?.focus()
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="tx-bar">
        <button className="btn sm" disabled={!sel} onClick={del} title="Delete or Backspace">
          {selCut ? 'Restore selected' : 'Delete selected'}
        </button>
        <button className="btn sm" disabled={!sel || lo !== hi} onClick={startFix} title="Correct a word Whisper misheard (Enter or F2)">
          Fix word
        </button>
        <button className="btn sm" disabled={!fillers} onClick={() => apply({ removeFillers: true })}>
          Remove fillers{fillers ? ` (${fillers})` : ''}
        </button>
        <span className="row" style={{ gap: 4 }}>
          <button className="btn sm" onClick={() => apply({ maxPauseSec: pause })}>
            Shorten pauses to
          </button>
          <select className="inline" value={pause} onChange={(e) => setPause(Number(e.target.value))}>
            {[0.2, 0.3, 0.4, 0.6, 0.8].map((p) => (
              <option key={p} value={p}>
                {p} s
              </option>
            ))}
          </select>
        </span>
        {cuts.length > 0 && (
          <button className="btn ghost sm" onClick={() => onCuts(undefined)}>
            Restore all
          </button>
        )}
        <span className="grow" />
        <label className="check small muted">
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> skip cuts while playing
        </label>
      </div>
      <div
        className="tx"
        ref={box}
        tabIndex={0}
        onKeyDown={(e) => {
          if (editing) return
          // Keys the transcript uses stay here; the rest (Space, Ctrl+Z…) reach the editor's shortcuts.
          if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
            e.preventDefault()
            e.stopPropagation()
            del()
          } else if ((e.key === 'Enter' || e.key === 'F2') && sel && lo === hi) {
            e.preventDefault()
            e.stopPropagation()
            startFix()
          } else if (e.key === 'Escape' && sel) {
            e.stopPropagation()
            setSel(undefined)
          }
        }}
      >
        {t.segments.map((s, si) => (
          <p key={si}>
            {words.slice(s.from, s.to).map((w, k) => {
              const i = s.from + k
              const gap = i > 0 ? w.start - words[i - 1].end : 0
              const gapCut = gap >= 0.8 && isCut(cuts, words[i - 1].end + gap / 2)
              const cls = ['w', removed(i) ? 'cut' : '', isFiller(w) ? 'filler' : '', i >= lo && i <= hi ? 'sel' : '', i === now ? 'now' : ''].filter(Boolean).join(' ')
              return (
                <Fragment key={i}>
                  {gap >= 0.8 && (
                    <span
                      className={`gap ${gapCut ? 'cut' : ''}`}
                      title={gapCut ? 'Put this pause back' : 'Cut this pause down'}
                      onClick={() =>
                        gapCut
                          ? onCuts(mergeCuts(uncut(cuts, words[i - 1].end, w.start), clipIn, clipOut))
                          : onCuts(mergeCuts([...cuts, [words[i - 1].end + 0.15, w.start - 0.15]], clipIn, clipOut))
                      }
                    >
                      ⏸ {gap.toFixed(1)} s
                    </span>
                  )}
                  {k > 0 && !(isCjk(w.text) && isCjk(words[i - 1].text)) && ' '}
                  {editing?.i === i ? (
                    <input
                      className="tx-edit"
                      autoFocus
                      value={editing.text}
                      size={Math.max(3, editing.text.length + 1)}
                      onChange={(e) => setEditing({ i, text: e.target.value })}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') void saveFix()
                        if (e.key === 'Escape') {
                          setEditing(undefined)
                          box.current?.focus()
                        }
                      }}
                      onBlur={() => void saveFix()}
                    />
                  ) : (
                  <span
                    className={cls}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      box.current?.focus()
                      drag.current = i
                      setSel(e.shiftKey && sel ? [sel[0], i] : [i, i])
                    }}
                    onMouseEnter={() => drag.current !== undefined && setSel([drag.current, i])}
                    onDoubleClick={() => {
                      if (player.current) player.current.currentTime = w.start
                    }}
                    title={`${w.start.toFixed(2)}–${w.end.toFixed(2)} s · double-click to play from here`}
                  >
                    {w.text}
                  </span>
                  )}
                </Fragment>
              )
            })}
          </p>
        ))}
      </div>
      <div className="small faint">
        {cuts.length ? `${cuts.length} cut${cuts.length === 1 ? '' : 's'}, ${cutSec.toFixed(1)} s taken out. ` : ''}
        Drag across words to select them, then Delete. Enter fixes a misheard word. Double-click a word to play from there.{' '}
        {t.language !== 'unknown' ? `Language: ${t.language}.` : ''}
      </div>
    </div>
  )
}
