import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AutoCaptions, Caption, CompositionSpec, EditClip, EditProject, EditSpec, EditText, MediaInfo, SpeechStatus } from '@shared/types'
import { editSegments, splitClip, toSource } from '@shared/timeline'
import { keptSeconds, mergeCuts } from '@shared/transcript'
import { call, fileName, isVideoPath, mediaUrl, on, useData } from '../api'
import { fmtTime, Modal, useApp } from '../ui'
import { EditPreview, type PreviewControls } from './EditPreview'
import { TranscriptPanel } from './Transcript'

const CAPTION_STYLES: [AutoCaptions['style'] | '', string][] = [
  ['', 'Off'],
  ['highlight', 'Word by word (the word being said lights up)'],
  ['pop', 'Pop: big, a few words at a time (shorts)'],
  ['clean', 'Clean lines'],
  ['boxed', 'Lines on a dark band']
]

const ASPECTS = [
  ['', 'Keep original'],
  ['16:9', '16:9 landscape (YouTube, Bilibili)'],
  ['9:16', '9:16 vertical (TikTok, Reels, Shorts, Rednote)'],
  ['1:1', '1:1 square'],
  ['4:5', '4:5 portrait (Instagram feed)'],
  ['3:4', '3:4 portrait (Rednote)']
]

const TEMPLATE = `<!doctype html>
<html><head><style>
body { background: linear-gradient(160deg, #141026, #2a1458 60%, #5b1d6e); color: #fff;
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif; display: flex; flex-direction: column;
  justify-content: center; align-items: center; text-align: center; }
.t { font-size: 120px; font-weight: 800; line-height: 1.05; padding: 0 80px; opacity: 0;
  animation: up .8s cubic-bezier(.2,.8,.2,1) .3s forwards; }
.s { margin-top: 40px; font-size: 54px; color: #cbbcff; opacity: 0; animation: up .8s ease 1.1s forwards; }
.p { font-size: 64px; font-weight: 600; margin: 24px 0; opacity: 0; animation: up .6s ease forwards; }
.p:nth-child(1) { animation-delay: 2.2s } .p:nth-child(2) { animation-delay: 3.2s } .p:nth-child(3) { animation-delay: 4.2s }
.bar { position: absolute; bottom: 0; left: 0; height: 16px; background: #a594ff; animation: grow 7s linear forwards; }
@keyframes up { from { opacity: 0; transform: translateY(60px) } to { opacity: 1; transform: none } }
@keyframes grow { from { width: 0 } to { width: 100% } }
</style></head>
<body>
  <div class="t">Your headline here</div>
  <div class="s">A one-line promise</div>
  <div style="margin-top:80px"><div class="p">① First point</div><div class="p">② Second point</div><div class="p">③ Third point</div></div>
  <div class="bar"></div>
</body></html>`

function useProgress(id?: string) {
  const [p, setP] = useState<{ fraction: number; note?: string }>()
  useEffect(() => {
    setP(undefined)
    return on('progress', (e) => {
      const { scope, fraction, note } = e as { scope?: string; fraction: number; note?: string }
      if (id && scope === `project:${id}`) setP({ fraction, note })
    })
  }, [id])
  return p
}

export function Studio({ seed, onSeedTaken }: { seed?: string; onSeedTaken: () => void }) {
  const app = useApp()
  const { data: projects, reload } = useData<EditProject[]>('studio.list', [], ['projects'])
  const [openId, setOpenId] = useState<string>()
  const [generating, setGenerating] = useState(false)

  // Opened from Compose with a clip: start a new edit with it.
  useEffect(() => {
    if (!seed) return
    onSeedTaken()
    void call<EditProject>('studio.saveEdit', { name: `Edit of ${fileName(seed)}`, spec: { clips: [{ src: seed }] } }).then((p) => {
      reload()
      setOpenId(p.id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  const newEdit = async () => {
    const files = await call<string[]>('media.pickFiles', 'any', true)
    if (!files.length) return
    const p = await call<EditProject>('studio.saveEdit', { name: `Edit of ${fileName(files[0])}`, spec: { clips: files.map((src) => ({ src })) } })
    reload()
    setOpenId(p.id)
  }

  const open = projects?.find((p) => p.id === openId)

  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="grow">
          <h1>Studio</h1>
          <p className="sub" style={{ margin: 0 }}>
            Edit your own videos, or have Claude make one. Originals are never changed.
          </p>
        </div>
        <button className="btn" onClick={newEdit}>
          ✂ Edit a video
        </button>
        <button className="btn primary" onClick={() => setGenerating(true)}>
          ✨ Make a video with AI
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 220px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 10 }}>
          {!projects?.length && <div className="muted small" style={{ padding: 8 }}>No projects yet.</div>}
          <div className="stack" style={{ gap: 6 }}>
            {projects?.map((p) => (
              <button
                key={p.id}
                onClick={() => setOpenId(p.id)}
                className="btn"
                style={{ textAlign: 'left', whiteSpace: 'normal', background: p.id === openId ? 'var(--accent-soft)' : undefined, borderColor: p.id === openId ? 'var(--accent)' : undefined }}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                <div className="row small faint" style={{ gap: 6 }}>
                  <span className={`pill ${p.kind === 'generated' ? 'accent' : ''}`}>{p.kind === 'generated' ? 'AI-generated' : p.aiGenerated ? 'Edit · AI' : 'Edit'}</span>
                  {p.output ? '✓ rendered' : 'not rendered'}
                </div>
                <div className="small faint">{fmtTime(p.updatedAt)}</div>
              </button>
            ))}
          </div>
        </div>
        <div>
          {!open && (
            <div className="card empty">
              Pick a project, start an edit from one of your videos, or ask Claude to make a video.
              <div className="help" style={{ marginTop: 8 }}>
                Tip: on the Compose page, the ✂ button on a video opens it here.
              </div>
            </div>
          )}
          {open?.kind === 'edit' && <EditEditor key={open.id} project={open} onDeleted={() => setOpenId(undefined)} />}
          {open?.kind === 'generated' && <GeneratedEditor key={open.id} project={open} onDeleted={() => setOpenId(undefined)} />}
        </div>
      </div>
      {generating && (
        <GenerateDialog
          onClose={() => setGenerating(false)}
          onTemplate={async () => {
            const p = await call<EditProject>('studio.saveGenerated', { name: 'Title card (template)', composition: { html: TEMPLATE, durationSec: 7, aspect: '9:16' } })
            setGenerating(false)
            reload()
            setOpenId(p.id)
            app.toast('Template added — edit the HTML or press Render.')
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- generate

function GenerateDialog({ onClose, onTemplate }: { onClose: () => void; onTemplate: () => void }) {
  const app = useApp()
  const [prompt, setPrompt] = useState('')
  const [aspect, setAspect] = useState('9:16')
  const [dur, setDur] = useState(20)
  const [narrate, setNarrate] = useState(false)
  return (
    <Modal onClose={onClose}>
      <h2>Make a video with AI</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Claude designs the video as animated scenes and OneDraft renders it to MP4, labelled as AI-generated.
      </p>
      <div className="stack">
        <label className="field">
          <span className="lab">What should the video say or show?</span>
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. A 20-second teaser for our weekend sale: three beats, bold kinetic type, ends with 'link in bio'."
          />
        </label>
        <div className="split">
          <label className="field">
            <span className="lab">Shape</span>
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {ASPECTS.filter(([v]) => v).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">Length (seconds)</span>
            <input type="number" min={3} max={180} value={dur} onChange={(e) => setDur(Number(e.target.value))} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={narrate} onChange={(e) => setNarrate(e.target.checked)} />
          Add narration (Windows voice)
        </label>
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onTemplate} title="No AI needed: start from an editable HTML template">
          Start from a template
        </button>
        <span className="grow" />
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!prompt.trim()}
          onClick={() => {
            app.ask(
              `Make a video with generate_video. Request: "${prompt.trim()}". Shape ${aspect}, about ${dur} seconds${narrate ? ', with narration' : ', no narration'}. Then check it with view_frames, fix anything that looks off, and tell me it's ready in Studio.`
            )
            onClose()
          }}
        >
          Ask Claude
        </button>
      </div>
    </Modal>
  )
}

function GeneratedEditor({ project, onDeleted }: { project: EditProject; onDeleted: () => void }) {
  const app = useApp()
  const [name, setName] = useState(project.name)
  const [c, setC] = useState<CompositionSpec>(project.composition ?? { html: TEMPLATE, durationSec: 7, aspect: '9:16' })
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const { data: voices } = useData<{ name: string; culture: string }[]>('studio.voices', [])
  const progress = useProgress(project.id)
  // What the saved project holds, and whether it was changed here since: Claude's changes to the project load in
  // unless there are unsaved changes here, so "Render again" never quietly renders an older version.
  const saved = useRef(JSON.stringify(project.composition ?? null))
  const localEdits = useRef(false)
  const set = (patch: Partial<CompositionSpec>) => {
    localEdits.current = true
    setC((x) => ({ ...x, ...patch }))
  }
  useEffect(
    () =>
      on('changed', async (k) => {
        if (k !== 'projects') return
        const p = await call<EditProject>('studio.get', project.id).catch(() => undefined)
        const now = JSON.stringify(p?.composition ?? null)
        if (!p?.composition || now === saved.current) return
        saved.current = now
        if (localEdits.current) app.toast('Claude changed this video. Your unsaved changes here are kept; Render uses them.')
        else setC(p.composition)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project.id]
  )

  const render = async () => {
    setBusy(true)
    try {
      await call('studio.saveGenerated', { id: project.id, name, composition: c })
      saved.current = JSON.stringify(c)
      localEdits.current = false
      await call('studio.render', project.id)
      app.toast('Rendered.')
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ fontWeight: 600, fontSize: 15 }} />
          <span className="pill accent">AI-generated</span>
        </div>
        {project.prompt && <div className="note" style={{ marginTop: 10 }}>“{project.prompt}”</div>}
        <Output project={project} busy={busy} progress={progress} onRender={render} onCancel={() => call('studio.cancel', project.id)} onDelete={onDeleted} />
      </div>
      <div className="card">
        <h2>Ask Claude to change it</h2>
        <div className="row">
          <input type="text" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. slower, bigger text, add a closing card with my handle" />
          <button
            className="btn"
            disabled={!instruction.trim()}
            onClick={() => {
              app.ask(`Change the generated video in Studio project ${project.id} ("${name}"): ${instruction.trim()}. Use get_project for the current HTML, then generate_video with projectId ${project.id}, and check it with view_frames.`)
              setInstruction('')
            }}
          >
            Ask
          </button>
        </div>
      </div>
      <div className="card">
        <h2>Settings</h2>
        <div className="split">
          <label className="field">
            <span className="lab">Shape</span>
            <select value={c.aspect} onChange={(e) => set({ aspect: e.target.value })}>
              {ASPECTS.filter(([v]) => v).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">Length (seconds)</span>
            <input type="number" min={0.5} max={600} step={0.5} value={c.durationSec} onChange={(e) => set({ durationSec: Number(e.target.value) })} />
          </label>
        </div>
        <h3>Narration</h3>
        <div className="split">
          <textarea value={c.narration?.text ?? ''} onChange={(e) => set({ narration: e.target.value ? { ...c.narration, text: e.target.value } : undefined })} placeholder="Optional voice-over text" style={{ gridColumn: '1 / -1', minHeight: 60 }} />
          <select value={c.narration?.voice ?? ''} onChange={(e) => c.narration && set({ narration: { ...c.narration, voice: e.target.value || undefined } })}>
            <option value="">Voice: automatic</option>
            {voices?.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.culture})
              </option>
            ))}
          </select>
          <MusicPicker music={c.music} onChange={(music) => set({ music })} />
        </div>
        <h3>HTML (what Claude wrote — editable)</h3>
        <textarea className="mono" value={c.html} onChange={(e) => set({ html: e.target.value })} style={{ minHeight: 260, fontSize: 12 }} spellCheck={false} />
        <div className="help">CSS animations are paused and stepped frame by frame; window.onedraftSeek(t) can draw canvas frames. No network access while rendering.</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- edit

function clipLen(c: EditClip, info?: MediaInfo) {
  if (!info) return 0
  if (info.kind === 'image') return c.durationSec ?? 3
  const full = info.durationSec ?? 0
  const a = Math.max(0, Math.min(c.in ?? 0, full))
  const b = Math.max(a, Math.min(c.out ?? full, full))
  return (c.cuts?.length ? keptSeconds(a, b, c.cuts, 30) : b - a) / (c.speed ?? 1)
}

function EditEditor({ project, onDeleted }: { project: EditProject; onDeleted: () => void }) {
  const app = useApp()
  const [name, setName] = useState(project.name)
  const [spec, setSpec] = useState<EditSpec>(project.spec ?? { clips: [] })
  const [infos, setInfos] = useState<Record<string, MediaInfo>>({})
  const [sel, setSel] = useState(0)
  const [busy, setBusy] = useState<string>()
  const [instruction, setInstruction] = useState('')
  const player = useRef<HTMLVideoElement>(null)
  const preview = useRef<PreviewControls>(null)
  const [watchRender, setWatchRender] = useState(false)
  const progress = useProgress(project.id)
  const { data: speech } = useData<SpeechStatus>('speech.status', [], ['speech'])

  // ---- undo / redo: every change to the edit (yours, or Claude's) can be taken back ----
  const specRef = useRef(spec)
  specRef.current = spec
  /** The edit as last saved (by us or loaded): tells Claude's changes from our own saves. */
  const saved = useRef<EditSpec | undefined>(project.spec)
  const past = useRef<EditSpec[]>([])
  const future = useRef<EditSpec[]>([])
  const lastChange = useRef(0)
  const [, bump] = useState(0)
  const update = (next: EditSpec) => {
    const cur = specRef.current
    if (JSON.stringify(next) === JSON.stringify(cur)) return
    // Typing in a field makes many changes in a row: one undo step takes them all back.
    if (Date.now() - lastChange.current > 700) {
      past.current.push(cur)
      if (past.current.length > 200) past.current.shift()
    }
    lastChange.current = Date.now()
    future.current = []
    specRef.current = next
    setSpec(next)
  }
  const undo = () => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(specRef.current)
    lastChange.current = 0
    specRef.current = prev
    setSpec(prev)
    bump((n) => n + 1)
  }
  const redo = () => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(specRef.current)
    lastChange.current = 0
    specRef.current = next
    setSpec(next)
    bump((n) => n + 1)
  }
  // The selected clip stays one that exists (after an undo, a delete, or Claude's edit removed some).
  useEffect(() => {
    if (sel > 0 && sel >= spec.clips.length) setSel(Math.max(0, spec.clips.length - 1))
  }, [sel, spec.clips.length])
  const set = (patch: Partial<EditSpec>) => update({ ...specRef.current, ...patch })
  const setClip = (i: number, patch: Partial<EditClip>) => set({ clips: specRef.current.clips.map((c, k) => (k === i ? { ...c, ...patch } : c)) })

  /** Split the clip under the playhead in two (S). */
  const splitAtPlayhead = () => {
    const files = specRef.current.clips.map((c) => (infos[c.src] ? { durationSec: infos[c.src].durationSec, image: infos[c.src].kind === 'image' } : undefined))
    const at = toSource(editSegments(specRef.current, files), preview.current?.time() ?? 0)
    if (!at || infos[at.src]?.kind !== 'video') return app.toast('Put the playhead over a video clip to split it.')
    const clips = splitClip(specRef.current.clips, at.clip, at.time, infos[at.src]?.durationSec)
    if (!clips) return app.toast('Too close to the clip’s start or end to split there.')
    set({ clips })
    setSel(at.clip + 1)
  }

  // Keyboard, as in most editors. Typing in a field keeps its keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable="true"]')) return
      const k = e.key.toLowerCase()
      const ctrl = e.ctrlKey || e.metaKey
      const act = (fn: () => void) => {
        e.preventDefault()
        fn()
      }
      if (ctrl && k === 'z' && !e.shiftKey) act(undo)
      else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) act(redo)
      else if (ctrl || e.altKey) return
      else if (k === ' ') act(() => preview.current?.toggle())
      else if (k === 'k') act(() => preview.current?.pause())
      else if (k === 'arrowleft' || k === 'j') act(() => preview.current?.nudge(e.shiftKey || k === 'j' ? -5 : -1))
      else if (k === 'arrowright' || k === 'l') act(() => preview.current?.nudge(e.shiftKey || k === 'l' ? 5 : 1))
      else if (k === ',') act(() => preview.current?.nudge(-1 / 30))
      else if (k === '.') act(() => preview.current?.nudge(1 / 30))
      else if (k === 'home') act(() => preview.current?.seek(0))
      else if (k === 'end') act(() => preview.current?.seek(preview.current.duration()))
      else if (k === 's') act(splitAtPlayhead)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    for (const c of spec.clips)
      if (!infos[c.src])
        call<MediaInfo>('media.probe', c.src)
          .then((i) => setInfos((s) => ({ ...s, [c.src]: i })))
          .catch(() => undefined)
  }, [spec.clips, infos])

  // Reload if the assistant changed this project.
  useEffect(
    () =>
      on('changed', async (k) => {
        if (k !== 'projects') return
        const p = await call<EditProject>('studio.get', project.id).catch(() => undefined)
        // Only a change someone else saved (Claude): our own saves match what we last saved, and must not undo
        // edits made since (a render takes a while). Through update(), so Ctrl+Z takes Claude's change back too.
        if (!p?.spec || JSON.stringify(p.spec) === JSON.stringify(saved.current)) return
        saved.current = p.spec
        update(p.spec)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project.id]
  )

  const total = useMemo(() => {
    const lens = spec.clips.map((c) => clipLen(c, infos[c.src]))
    return Math.max(0, lens.reduce((s, x) => s + x, 0) - Math.max(0, lens.length - 1) * (spec.transitionSec ?? 0))
  }, [spec, infos])

  const save = () => {
    saved.current = spec
    return call<EditProject>('studio.saveEdit', { id: project.id, name, spec })
  }
  const render = async () => {
    setBusy('Rendering…')
    try {
      await save()
      await call('studio.render', project.id)
      app.toast('Rendered.')
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(undefined)
    }
  }

  const addClips = async () => {
    const files = await call<string[]>('media.pickFiles', 'any', true)
    if (files.length) set({ clips: [...spec.clips, ...files.map((src) => ({ src }))] })
  }

  const cutSilences = async () => {
    setBusy('Finding silences…')
    try {
      const next: EditClip[] = []
      let removed = 0
      for (const c of spec.clips) {
        const info = infos[c.src]
        if (!info || info.kind !== 'video' || !info.hasAudio) {
          next.push(c)
          continue
        }
        const a = await call<{ speechSegments: { in: number; out: number }[] }>('media.analyze', c.src)
        if (!a.speechSegments.length) {
          next.push(c)
          continue
        }
        // The silences become cuts on the same clip (between the speech segments).
        const full = info.durationSec ?? 0
        const lo = c.in ?? 0
        const hi = c.out ?? full
        const gaps: [number, number][] = []
        let cursor = 0
        for (const s of a.speechSegments) {
          if (s.in > cursor) gaps.push([cursor, s.in])
          cursor = Math.max(cursor, s.out)
        }
        if (full > cursor) gaps.push([cursor, full])
        const before = clipLen(c, info)
        const cut = { ...c, cuts: mergeCuts([...(c.cuts ?? []), ...gaps], lo, hi) }
        removed += before - clipLen(cut, info)
        next.push(cut.cuts.length ? cut : c)
      }
      set({ clips: next })
      app.toast(removed > 0.2 ? `Cut ${removed.toFixed(1)} s of silence.` : 'No long silences found.')
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(undefined)
    }
  }

  const importSrt = async () => {
    const [f] = await call<string[]>('media.pickFiles', 'srt')
    if (!f) return
    const cues = await call<Caption[]>('media.readSrt', f)
    set({ captions: cues })
    app.toast(`Imported ${cues.length} captions.`)
  }

  const clip = spec.clips[sel]
  const t = () => Math.round((player.current?.currentTime ?? 0) * 100) / 100

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ fontWeight: 600, fontSize: 15 }} />
          {project.aiGenerated && <span className="pill accent">contains AI video</span>}
        </div>
        <Output
          project={project}
          busy={!!busy}
          progress={progress}
          onRender={render}
          onCancel={() => call('studio.cancel', project.id)}
          onDelete={onDeleted}
          video={watchRender}
          extra={
            <>
              <button className="btn ghost sm" disabled={!past.current.length} onClick={undo} title="Undo (Ctrl+Z)">
                ↶ Undo
              </button>
              <button className="btn ghost sm" disabled={!future.current.length} onClick={redo} title="Redo (Ctrl+Y)">
                ↷ Redo
              </button>
              <span className="muted small">Length ≈ {total.toFixed(1)} s</span>
              {project.output && (
                <button className="btn ghost sm" onClick={() => setWatchRender((w) => !w)}>
                  {watchRender ? 'Hide the render' : '▶ Watch the render'}
                </button>
              )}
            </>
          }
        />
        {busy && <div className="muted small">{busy}</div>}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 className="grow" style={{ margin: 0 }}>
            Preview
          </h2>
          <span className="keys">
            <kbd>Space</kbd> play · <kbd>←</kbd>
            <kbd>→</kbd> 1 s · <kbd>J</kbd>
            <kbd>L</kbd> 5 s · <kbd>S</kbd> split · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo
          </span>
        </div>
        <EditPreview spec={spec} infos={infos} selected={sel} onSelect={setSel} controls={preview} />
        <div className="small faint" style={{ marginTop: 6 }}>
          The edit as it will come out, before rendering (crossfades only show in the render). Click the strip to jump; the selected clip is darker.
        </div>
      </div>

      <div className="card">
        <h2>Ask Claude to edit it</h2>
        <div className="row">
          <input type="text" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. cut the ums, retakes and long pauses, then a 45 s vertical highlight with word-by-word captions" />
          <button
            className="btn"
            disabled={!instruction.trim()}
            onClick={async () => {
              await save()
              app.ask(
                `Edit Studio project ${project.id} ("${name}"): ${instruction.trim()}. Use get_project for the current spec; transcribe_video to read what is said in clips with speech, view_frames/analyze_video to look at the footage; keep existing cuts unless asked. Then render with edit_video and projectId ${project.id}.`
              )
              setInstruction('')
            }}
          >
            Ask
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }} className="grow">
            Clips
          </h2>
          <button className="btn sm" onClick={cutSilences} disabled={!!busy}>
            Cut silences
          </button>
          <button className="btn sm" onClick={addClips}>
            + Add clips
          </button>
        </div>
        <div className="stack" style={{ gap: 12 }}>
          {clip && (
            <div className="media" style={{ aspectRatio: 'auto', height: 300, width: '100%' }}>
              {isVideoPath(clip.src) ? <video ref={player} src={mediaUrl(clip.src)} controls style={{ objectFit: 'contain' }} /> : <img src={mediaUrl(clip.src)} alt="" />}
            </div>
          )}
          <div className="stack" style={{ gap: 6, minWidth: 0 }}>
            {spec.clips.map((c, i) => {
              const info = infos[c.src]
              const video = info?.kind !== 'image'
              return (
                <div key={i} className="platform" style={{ padding: 10, minWidth: 0, borderColor: i === sel ? 'var(--accent)' : undefined, cursor: 'pointer' }} onClick={() => setSel(i)}>
                  <div className="row" style={{ gap: 4 }}>
                    <b className="small">{i + 1}.</b>
                    <span className="small grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {fileName(c.src)}
                    </span>
                    {!!c.cuts?.length && (
                      <span className="pill" title="Stretches taken out (edit them under What’s said)">
                        ✂ {c.cuts.length}
                      </span>
                    )}
                    <span className="faint small">{clipLen(c, info).toFixed(1)} s</span>
                    <button className="btn ghost sm" disabled={i === 0} onClick={() => set({ clips: swap(spec.clips, i, i - 1) })}>
                      ↑
                    </button>
                    <button className="btn ghost sm" disabled={i === spec.clips.length - 1} onClick={() => set({ clips: swap(spec.clips, i, i + 1) })}>
                      ↓
                    </button>
                    <button className="btn ghost sm" onClick={() => set({ clips: [...spec.clips.slice(0, i + 1), { ...c }, ...spec.clips.slice(i + 1)] })} title="Duplicate (to split a clip)">
                      ⧉
                    </button>
                    <button className="btn ghost sm danger" onClick={() => set({ clips: spec.clips.filter((_, k) => k !== i) })}>
                      ✕
                    </button>
                  </div>
                  {video ? (
                    <div className="row wrap small" style={{ marginTop: 6 }}>
                      <span className="muted">from</span>
                      <input type="number" step={0.1} min={0} style={{ width: 76 }} value={c.in ?? 0} onChange={(e) => setClip(i, { in: Number(e.target.value) })} />
                      <button className="btn sm" disabled={i !== sel} onClick={() => setClip(i, { in: t() })} title="Use the player's current time">
                        ⇤ now
                      </button>
                      <span className="muted">to</span>
                      <input type="number" step={0.1} min={0} style={{ width: 76 }} value={c.out ?? Number((info?.durationSec ?? 0).toFixed(2))} onChange={(e) => setClip(i, { out: Number(e.target.value) })} />
                      <button className="btn sm" disabled={i !== sel} onClick={() => setClip(i, { out: t() })}>
                        now ⇥
                      </button>
                      <select style={{ width: 82 }} value={c.speed ?? 1} onChange={(e) => setClip(i, { speed: Number(e.target.value) })}>
                        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                          <option key={s} value={s}>
                            {s}×
                          </option>
                        ))}
                      </select>
                      <label className="check">
                        <input type="checkbox" checked={!!c.mute} onChange={(e) => setClip(i, { mute: e.target.checked })} /> mute
                      </label>
                    </div>
                  ) : (
                    <div className="row small" style={{ marginTop: 6 }}>
                      <span className="muted">show for</span>
                      <input type="number" step={0.5} min={0.5} style={{ width: 76 }} value={c.durationSec ?? 3} onChange={(e) => setClip(i, { durationSec: Number(e.target.value) })} />
                      <span className="muted">s</span>
                    </div>
                  )}
                </div>
              )
            })}
            {!spec.clips.length && <div className="muted">No clips. Add some.</div>}
          </div>
        </div>
      </div>

      {clip && infos[clip.src]?.kind === 'video' && (
        <div className="card">
          <h2>
            What’s said <span className="faint small" style={{ fontWeight: 400 }}>· clip {sel + 1}</span>
          </h2>
          <TranscriptPanel clip={clip} info={infos[clip.src]} player={player} onCuts={(cuts) => setClip(sel, { cuts: cuts?.length ? cuts : undefined })} />
        </div>
      )}

      <div className="card">
        <h2>Look &amp; sound</h2>
        <div className="split">
          <label className="field">
            <span className="lab">Shape</span>
            <select value={spec.aspect ?? ''} onChange={(e) => set({ aspect: e.target.value || undefined })}>
              {ASPECTS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">When the shape changes</span>
            <select value={spec.fit ?? 'blur'} onChange={(e) => set({ fit: e.target.value as EditSpec['fit'] })}>
              <option value="blur">Blurred background</option>
              <option value="crop">Crop to fill</option>
              <option value="pad">Black bars</option>
            </select>
          </label>
          <label className="field">
            <span className="lab">Between clips</span>
            <select value={spec.transitionSec ?? 0} onChange={(e) => set({ transitionSec: Number(e.target.value) || undefined })}>
              <option value={0}>Hard cut</option>
              <option value={0.3}>Quick crossfade (0.3 s)</option>
              <option value={0.6}>Crossfade (0.6 s)</option>
              <option value={1}>Slow crossfade (1 s)</option>
            </select>
          </label>
          <div className="row">
            <label className="field grow">
              <span className="lab">Fade in (s)</span>
              <input type="number" step={0.1} min={0} value={spec.fadeInSec ?? 0} onChange={(e) => set({ fadeInSec: Number(e.target.value) || undefined })} />
            </label>
            <label className="field grow">
              <span className="lab">Fade out (s)</span>
              <input type="number" step={0.1} min={0} value={spec.fadeOutSec ?? 0} onChange={(e) => set({ fadeOutSec: Number(e.target.value) || undefined })} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={!!spec.normalizeAudio} onChange={(e) => set({ normalizeAudio: e.target.checked || undefined })} />
            Even out loudness (−14 LUFS, what platforms expect)
          </label>
          <MusicPicker music={spec.music} duck onChange={(music) => set({ music })} />
          <div className="row">
            <span className="small muted">Logo:</span>
            <span className="small grow">{spec.logo ? fileName(spec.logo.src) : 'none'}</span>
            {spec.logo && (
              <select style={{ width: 130 }} value={spec.logo.position ?? 'top-right'} onChange={(e) => set({ logo: { ...spec.logo!, position: e.target.value as 'top-right' } })}>
                {['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            )}
            <button
              className="btn sm"
              onClick={async () => {
                const [f] = await call<string[]>('media.pickFiles', 'image')
                if (f) set({ logo: { src: f, position: spec.logo?.position ?? 'top-right' } })
              }}
            >
              {spec.logo ? 'Change' : 'Add'}
            </button>
            {spec.logo && (
              <button className="btn ghost sm" onClick={() => set({ logo: undefined })}>
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 className="grow" style={{ margin: 0 }}>
            Text on screen
          </h2>
          <button className="btn sm" onClick={() => set({ texts: [...(spec.texts ?? []), { text: 'New text', start: 0, end: Math.min(3, total || 3), position: 'top', box: true }] })}>
            + Add text
          </button>
        </div>
        {(spec.texts ?? []).map((tx, i) => (
          <TextRow
            key={i}
            t={tx}
            onChange={(patch) => set({ texts: spec.texts!.map((x, k) => (k === i ? { ...x, ...patch } : x)) })}
            onRemove={() => set({ texts: spec.texts!.filter((_, k) => k !== i) })}
          />
        ))}
        {!spec.texts?.length && <div className="muted small">Titles, labels, calls to action. Times are on the finished video.</div>}
        <h3>Captions</h3>
        <div className="split" style={{ marginBottom: 8 }}>
          <label className="field">
            <span className="lab">From what is said</span>
            <select
              value={spec.autoCaptions?.style ?? ''}
              onChange={(e) => set({ autoCaptions: e.target.value ? { ...spec.autoCaptions, style: e.target.value as AutoCaptions['style'] } : undefined })}
            >
              {CAPTION_STYLES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {spec.autoCaptions && (
            <label className="field">
              <span className="lab">Where</span>
              <select value={spec.autoCaptions.position ?? 'bottom'} onChange={(e) => set({ autoCaptions: { ...spec.autoCaptions, position: e.target.value as AutoCaptions['position'] } })}>
                <option value="bottom">Bottom</option>
                <option value="center">Middle</option>
                <option value="top">Top</option>
              </select>
            </label>
          )}
        </div>
        {spec.autoCaptions && !speech?.installed && <div className="note small">Captions from speech need speech-to-text: set it up under “What’s said” or in Settings.</div>}
        {spec.autoCaptions && <div className="small faint">Timed to every word, after your cuts. Rendering transcribes clips that haven’t been yet.</div>}
        <div className="row" style={{ marginTop: 8 }}>
          <span className="small grow">
            {spec.captions?.length ? `${spec.captions.length} imported captions${spec.autoCaptions ? ' (not used while captions come from speech)' : ', burned in at the bottom'}` : 'Or import an .srt file'}
          </span>
          <button className="btn sm" onClick={importSrt}>
            Import .srt
          </button>
          {!!spec.captions?.length && (
            <button className="btn ghost sm" onClick={() => set({ captions: undefined })}>
              Remove
            </button>
          )}
        </div>
        {!!spec.captions?.length && (
          <div className="note small" style={{ marginTop: 8 }}>
            {spec.captions.slice(0, 3).map((c, i) => (
              <div key={i}>
                {c.start.toFixed(1)}–{c.end.toFixed(1)} s · {c.text}
              </div>
            ))}
            {spec.captions.length > 3 && <div>…</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function TextRow({ t, onChange, onRemove }: { t: EditText; onChange: (p: Partial<EditText>) => void; onRemove: () => void }) {
  return (
    <div className="row wrap" style={{ marginBottom: 6 }}>
      <input type="text" className="grow" style={{ minWidth: 200 }} value={t.text} onChange={(e) => onChange({ text: e.target.value })} />
      <input type="number" step={0.1} min={0} style={{ width: 72 }} value={t.start} onChange={(e) => onChange({ start: Number(e.target.value) })} title="Start (s)" />
      <input type="number" step={0.1} min={0} style={{ width: 72 }} value={t.end} onChange={(e) => onChange({ end: Number(e.target.value) })} title="End (s)" />
      <select style={{ width: 96 }} value={t.position ?? 'center'} onChange={(e) => onChange({ position: e.target.value as EditText['position'] })}>
        <option value="top">top</option>
        <option value="center">center</option>
        <option value="bottom">bottom</option>
      </select>
      <label className="check small">
        <input type="checkbox" checked={!!t.box} onChange={(e) => onChange({ box: e.target.checked })} /> box
      </label>
      <button className="btn ghost sm danger" onClick={onRemove}>
        ✕
      </button>
    </div>
  )
}

function MusicPicker({ music, duck, onChange }: { music?: { src: string; volume?: number; duck?: boolean }; duck?: boolean; onChange: (m?: { src: string; volume?: number; duck?: boolean }) => void }) {
  return (
    <div className="row wrap">
      <span className="small muted">Music:</span>
      <span className="small grow">{music ? fileName(music.src) : 'none'}</span>
      {music && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={music.volume ?? 0.25}
          onChange={(e) => onChange({ ...music, volume: Number(e.target.value) })}
          title={`Volume ${Math.round((music.volume ?? 0.25) * 100)}%`}
          style={{ width: 110 }}
        />
      )}
      {music && duck && (
        <label className="check small" title="Lower the music while people talk">
          <input type="checkbox" checked={music.duck !== false} onChange={(e) => onChange({ ...music, duck: e.target.checked })} /> duck
        </label>
      )}
      <button
        className="btn sm"
        onClick={async () => {
          const [f] = await call<string[]>('media.pickFiles', 'audio')
          if (f) onChange({ src: f, volume: music?.volume ?? 0.25, duck: music?.duck })
        }}
      >
        {music ? 'Change' : 'Add'}
      </button>
      {music && (
        <button className="btn ghost sm" onClick={() => onChange(undefined)}>
          Remove
        </button>
      )}
    </div>
  )
}

function Output(props: {
  project: EditProject
  busy: boolean
  progress?: { fraction: number; note?: string }
  onRender: () => void
  onCancel: () => void
  onDelete: () => void
  extra?: ReactNode
  /** Show the rendered file's player (default yes; edits show their live preview instead). */
  video?: boolean
}) {
  const app = useApp()
  const { project: p, progress } = props
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      {p.output && props.video !== false && (
        <div className="media" style={{ aspectRatio: 'auto', maxHeight: 460, background: '#000' }}>
          <video
            key={p.output + p.updatedAt}
            src={mediaUrl(p.output)}
            controls
            preload="auto"
            style={{ maxHeight: 460 }}
            // Generated videos usually fade in from black: show a frame from the middle instead.
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              if (v.currentTime === 0 && Number.isFinite(v.duration)) v.currentTime = Math.min(v.duration * 0.45, 4)
            }}
          />
        </div>
      )}
      {props.busy && progress && (
        <div>
          <div className="progress">
            <div style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
          <div className="faint small">
            {progress.note} {Math.round(progress.fraction * 100)}%
          </div>
        </div>
      )}
      <div className="row wrap">
        {props.extra}
        <span className="grow" />
        {p.output && (
          <>
            <button className="btn sm" onClick={() => call('shell.showItem', p.output)}>
              Show file
            </button>
            <button className="btn sm" onClick={() => app.newPost([p.output!])}>
              Use in a new post
            </button>
          </>
        )}
        <button
          className="btn ghost sm danger"
          onClick={async () => {
            if (!confirm('Delete this project? Rendered files stay on disk.')) return
            await call('studio.remove', p.id)
            props.onDelete()
          }}
        >
          Delete
        </button>
        {props.busy ? (
          <button className="btn sm" onClick={props.onCancel}>
            Stop
          </button>
        ) : (
          <button className="btn primary" onClick={props.onRender}>
            {p.output ? 'Render again' : 'Render'}
          </button>
        )}
      </div>
    </div>
  )
}

function swap<T>(a: T[], i: number, j: number): T[] {
  const b = [...a]
  ;[b[i], b[j]] = [b[j], b[i]]
  return b
}
