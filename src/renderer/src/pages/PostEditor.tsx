// The post editor: a main post shared by every platform, plus one panel per platform you switch between.
// Fields a platform hasn't changed follow the main post ("from main"); editing one makes it "custom"
// for that platform only, and "use main" puts it back.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Account, Issue, MediaInfo, PlatformManifest, Post, PostDraft, Target, TargetStats, Variant } from '@shared/types'
import { call, fileName, isVideoPath, mediaUrl, on } from '../api'
import { canHaveStats, isLive, TargetStatsStrip, useStats } from '../stats'
import { ConnectDialog, Counter, Field, MediaTile, PlatformIcon, Status, TagsInput, Toggle, useApp } from '../ui'

interface Main {
  title: string
  body: string
  tags: string[]
  media: string[]
  aiGenerated: boolean
  scheduledAt: string // datetime-local, '' = publish on approval
}
const EMPTY: Main = { title: '', body: '', tags: [], media: [], aiGenerated: false, scheduledAt: '' }
const CONTENT_KEYS = ['title', 'caption', 'tags', 'media', 'cover'] as const

const BAND: Record<string, string> = {
  youtube: 'linear-gradient(120deg,#d90429,#ff3d57)',
  rednote: 'linear-gradient(120deg,#ff2442,#ff6b81)',
  bilibili: 'linear-gradient(120deg,#0091c2,#36bdf0)',
  instagram: 'linear-gradient(120deg,#8a3ab9,#e1306c 55%,#fcaf45)',
  tiktok: 'linear-gradient(120deg,#111,#2a2a2a 70%,#0f8f8a)',
  x: 'linear-gradient(120deg,#111,#3a3a3a)'
}
const CAPTION_LABEL: Record<string, string> = { youtube: 'Description', bilibili: 'Description', x: 'Post' }
const TAGS_LABEL: Record<string, string> = { rednote: 'Topics' }
const LOCKED = (t?: Target) => !!t && t.status !== 'draft' && t.status !== 'canceled'

const toLocalInput = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const len = (s: string) => [...s].length
/** Rednote-style length: English letters, digits and spaces count half. */
const halfAscii = (s: string) => Math.ceil([...s].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) < 128 ? 0.5 : 1), 0))
const customCount = (v?: Variant) => (v ? CONTENT_KEYS.filter((k) => v[k] !== undefined).length : 0)
const describe = (i?: MediaInfo) =>
  i
    ? [i.width && i.height ? `${i.width}×${i.height}` : '', i.durationSec ? `${Math.floor(i.durationSec / 60)}:${String(Math.round(i.durationSec % 60)).padStart(2, '0')}` : '']
        .filter(Boolean)
        .join(' · ')
    : undefined

export function PostEditor({ postId: initialId, seedMedia, onCreated }: { postId?: string; seedMedia?: string[]; onCreated: (id: string) => void }) {
  const app = useApp()
  const [postId, setPostId] = useState(initialId)
  const [post, setPost] = useState<Post>()
  const [m, setM] = useState<Main>(EMPTY)
  const [variants, setVariants] = useState<Record<string, Variant>>({})
  const [issues, setIssues] = useState<Record<string, Issue[]>>({})
  const [sel, setSel] = useState('main')
  const [infos, setInfos] = useState<Record<string, MediaInfo>>({})
  const [busy, setBusy] = useState<string>()
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [connectP, setConnectP] = useState<PlatformManifest>()
  const [progress, setProgress] = useState<{ fraction: number; note?: string }>()
  const { stats } = useStats()
  const dirty = useRef(false)
  const lastSaved = useRef<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Latest values for async work (saves, conversions, file pickers) so it never acts on an old render's copy.
  const idRef = useRef<string | undefined>(initialId)
  const mRef = useRef<Main>(EMPTY)
  const varsRef = useRef<Record<string, Variant>>({})
  /** Bumped on every edit here; a save only marks the editor clean if nothing changed while it ran. */
  const edits = useRef(0)
  /** What was edited here since the last save, so changes Claude made meanwhile to the rest are kept. */
  const touched = useRef<{ main: boolean; accounts: Set<string> }>({ main: false, accounts: new Set() })
  const saveChain = useRef<Promise<Post | undefined>>(Promise.resolve(undefined))
  const deleted = useRef(false)
  const setMainState = (next: Main) => {
    mRef.current = next
    setM(next)
  }
  const setVarsState = (next: Record<string, Variant>) => {
    varsRef.current = next
    setVariants(next)
  }
  const mainOf = (p: Post): Main => ({ title: p.title, body: p.body, tags: p.tags, media: p.media, aiGenerated: p.aiGenerated, scheduledAt: toLocalInput(p.scheduledAt) })
  const varsOf = (p: Post) => Object.fromEntries(p.targets.filter((t) => t.status !== 'canceled').map((t) => [t.accountId, t.variant]))

  // ---------- load ----------
  const applyPost = (p: Post) => {
    setPost(p)
    lastSaved.current = p.updatedAt
    setMainState(mainOf(p))
    setVarsState(varsOf(p))
  }
  async function validate(p: Post) {
    const byTarget = await call<Record<string, Issue[]>>('posts.validate', p.id)
    const out: Record<string, Issue[]> = {}
    for (const t of p.targets) out[t.accountId] = byTarget[t.id] ?? []
    if (byTarget._) out._ = byTarget._
    setIssues(out)
  }
  const load = async (id: string) => {
    const p = await call<Post | undefined>('posts.get', id)
    if (!p) return
    applyPost(p)
    await validate(p)
  }
  useEffect(() => {
    if (initialId) void load(initialId)
    else {
      // A new post goes to every connected platform by default.
      setVarsState(Object.fromEntries(app.accounts.filter((a) => a.status !== 'error').map((a) => [a.id, {}])))
      if (seedMedia?.length)
        void Promise.all(seedMedia.map((p) => call<boolean>('media.isAi', p))).then((ai) =>
          setMainState({ ...mRef.current, media: [...new Set([...seedMedia, ...mRef.current.media])], aiGenerated: mRef.current.aiGenerated || ai.some(Boolean) })
        )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId])

  // Pick up changes Claude makes while this is open.
  useEffect(
    () =>
      on('changed', async (k) => {
        const id = idRef.current
        if (k !== 'posts' || !id || dirty.current || deleted.current) return
        const p = await call<Post | undefined>('posts.get', id)
        if (p && p.updatedAt !== lastSaved.current && !dirty.current) {
          applyPost(p)
          await validate(p)
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [postId]
  )
  useEffect(
    () =>
      on('progress', (e) => {
        const ev = e as { scope?: string; fraction: number; note?: string }
        if (postId && ev.scope === postId) setProgress(ev)
      }),
    [postId]
  )

  const allMedia = [...new Set([...m.media, ...Object.values(variants).flatMap((v) => v.media ?? []), ...Object.values(variants).flatMap((v) => (v.cover ? [v.cover] : []))])]
  useEffect(() => {
    for (const p of allMedia)
      if (!infos[p])
        call<MediaInfo>('media.probe', p)
          .then((i) => setInfos((s) => ({ ...s, [p]: i })))
          .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allMedia.join('|')])

  // ---------- save ----------
  const saveNow = async (): Promise<Post | undefined> => {
    if (deleted.current) return undefined
    const seq = edits.current
    const id = idRef.current
    const t = touched.current
    touched.current = { main: false, accounts: new Set() }
    let main = mRef.current
    let vars = varsRef.current
    try {
      // Claude (or another window) may have changed the post since it was loaded here: keep their changes for
      // everything not edited here, instead of writing this editor's older copy over them.
      if (id) {
        const server = await call<Post | undefined>('posts.get', id)
        if (server && server.updatedAt !== lastSaved.current) {
          if (!t.main) main = mainOf(server)
          const merged: Record<string, Variant> = varsOf(server)
          for (const a of t.accounts) {
            if (a in vars) merged[a] = vars[a]
            else delete merged[a]
          }
          vars = merged
        }
      }
      const draft: PostDraft = {
        id,
        title: main.title,
        body: main.body,
        tags: main.tags,
        media: main.media,
        aiGenerated: main.aiGenerated,
        scheduledAt: main.scheduledAt ? new Date(main.scheduledAt).toISOString() : undefined,
        targets: Object.entries(vars).map(([accountId, variant]) => ({ accountId, variant }))
      }
      setSaving('saving')
      const p = await call<Post>('posts.save', draft)
      lastSaved.current = p.updatedAt
      if (!idRef.current) {
        idRef.current = p.id
        setPostId(p.id)
        onCreated(p.id)
      }
      setPost(p)
      // Nothing typed while saving: show the saved post (including anything merged in from Claude).
      if (edits.current === seq) {
        dirty.current = false
        applyPost(p)
      }
      setSaving('saved')
      await validate(p)
      return p
    } catch (e) {
      // Not saved: remember what was edited so the next try still sends it.
      touched.current.main ||= t.main
      for (const a of t.accounts) touched.current.accounts.add(a)
      setSaving('idle')
      throw e
    }
  }
  /** Saves run one at a time, in order, each with the latest values. */
  const save = (): Promise<Post | undefined> => {
    const next = saveChain.current.catch(() => undefined).then(saveNow)
    saveChain.current = next
    return next
  }
  const schedule = () => {
    dirty.current = true
    edits.current++
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = undefined
      void save().catch((e: Error) => app.toast(e.message, true))
    }, 600)
  }
  // Leaving the editor with a save still waiting: send it now rather than lose the last edits.
  useEffect(
    () => () => {
      if (timer.current && !deleted.current) {
        clearTimeout(timer.current)
        void save().catch(() => undefined)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const setMain = (patch: Partial<Main> | ((cur: Main) => Partial<Main>)) => {
    const cur = mRef.current
    setMainState({ ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) })
    touched.current.main = true
    schedule()
  }
  const setVariant = (accountId: string, patch: Partial<Variant> | undefined) => {
    const next = { ...varsRef.current }
    if (patch === undefined) delete next[accountId]
    else next[accountId] = { ...(next[accountId] ?? {}), ...patch }
    setVarsState(next)
    touched.current.accounts.add(accountId)
    schedule()
  }
  const ensureSaved = async () => {
    clearTimeout(timer.current)
    timer.current = undefined
    return save()
  }

  // ---------- actions ----------
  const askClaude = async (text: (id: string) => string) => {
    const p = await ensureSaved()
    if (p) app.ask(text(p.id), { background: true })
  }
  const approve = async () => {
    setBusy('Checking…')
    try {
      const p = await ensureSaved()
      if (!p) return
      const when = mRef.current.scheduledAt ? new Date(mRef.current.scheduledAt).toISOString() : undefined
      await call('posts.approve', p.id, when)
      app.toast(when ? 'Scheduled.' : 'Publishing now.')
      await load(p.id)
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(undefined)
    }
  }
  const remove = async () => {
    const id = idRef.current
    if (!confirm('Delete this post from OneDraft? Anything already published stays on the platforms.')) return
    // Stop any waiting save first, or it would bring the post back right after it is deleted.
    clearTimeout(timer.current)
    timer.current = undefined
    deleted.current = true
    await saveChain.current.catch(() => undefined)
    const saved = idRef.current ?? id
    if (!saved) return app.go('posts')
    try {
      await call('posts.remove', saved)
      app.go('posts')
    } catch (e) {
      deleted.current = false
      app.toast((e as Error).message, true)
    }
  }
  const fitFor = async (accountId: string, aspect: string, mode: string) => {
    const source = varsRef.current[accountId]?.media ?? mRef.current.media
    if (!source.length) return
    setBusy(`Making a ${aspect} version…`)
    try {
      const out: string[] = []
      for (const p of source) out.push((await call<MediaInfo>('media.fit', p, aspect, mode)).path)
      setVariant(accountId, { media: out })
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(undefined)
    }
  }
  const targetAction = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn()
      if (ok) app.toast(ok)
      if (postId) await load(postId)
    } catch (e) {
      app.toast((e as Error).message, true)
    }
  }

  // ---------- derived ----------
  const rows = app.platforms.map((p) => {
    const account = app.accountFor(p.id)
    const target = account ? post?.targets.find((t) => t.accountId === account.id) : undefined
    const included = !!account && variants[account.id] !== undefined
    return { p, account, target, included, locked: LOCKED(target) }
  })
  const posting = rows.filter((r) => r.included)
  const errorCount = posting.reduce((n, r) => n + (issues[r.account!.id] ?? []).filter((i) => i.level === 'error').length, 0)
  const drafts = posting.filter((r) => !r.locked)
  const current = rows.find((r) => r.p.id === sel)
  const toggle = (r: (typeof rows)[number], on: boolean) => {
    if (!r.account) return
    if (!on && customCount(variants[r.account.id]) && !confirm(`Remove ${r.p.name} from this post? Its custom version will be discarded.`)) return
    setVariant(r.account.id, on ? {} : undefined)
  }
  const badge = (r: (typeof rows)[number]) => {
    if (r.locked) {
      const s = r.target!.status
      const cls = s === 'published' ? 'done' : s === 'failed' ? 'bad' : s === 'unconfirmed' || s === 'handoff' ? 'fix' : 'custom'
      const labels: Record<string, string> = { published: 'posted', scheduled: 'scheduled', queued: 'queued', publishing: 'posting', failed: 'failed', unconfirmed: 'check', handoff: 'your turn' }
      const label = labels[s] ?? s
      return <span className={`badge ${cls}`}>{label}</span>
    }
    const errs = (issues[r.account!.id] ?? []).filter((i) => i.level === 'error').length
    if (errs) return <span className="badge fix">{errs} to fix</span>
    const n = customCount(variants[r.account!.id])
    return n ? <span className="badge custom">{n} custom</span> : <span className="badge main">main</span>
  }

  return (
    <div className="pe">
      <div className="pe-top">
        <button className="back" onClick={() => app.go('posts')}>
          ‹ Posts
        </button>
        <h1>{m.title || (m.body ? m.body.split('\n')[0].slice(0, 60) : postId ? 'Untitled post' : 'New post')}</h1>
        {post && post.status !== 'draft' && <Status s={post.status} />}
        <span className="grow" />
        <span className="small faint">{busy ?? (saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : '')}</span>
        {drafts.length > 0 && (
          <>
            <input type="datetime-local" value={m.scheduledAt} onChange={(e) => setMain({ scheduledAt: e.target.value })} title="Publish time (empty = right away)" />
            <button className="btn primary" disabled={!!busy || errorCount > 0 || !drafts.length} onClick={approve} title={errorCount ? 'Fix the issues first' : ''}>
              {m.scheduledAt ? 'Approve & schedule' : 'Approve & publish'}
            </button>
          </>
        )}
        <button className="btn ghost sm danger" onClick={remove}>
          Delete
        </button>
      </div>

      <div className="pe-body">
        <nav className="pe-list">
          <button className={`pe-item ${sel === 'main' ? 'on' : ''}`} onClick={() => setSel('main')}>
            <span className="picon" style={{ background: 'var(--ink)', color: 'var(--bg)' }}>
              ◎
            </span>
            <span className="t">
              <b>Main post</b>
              <small>shared by all</small>
            </span>
          </button>
          <div className="pe-grp">Posting to</div>
          {!posting.length && <div className="small faint" style={{ padding: '4px 10px' }}>Switch on a platform below.</div>}
          {posting.map((r) => (
            // A div, not a button: it holds the on/off switch, and a button can't hold another one.
            <div
              key={r.p.id}
              role="button"
              tabIndex={0}
              className={`pe-item ${sel === r.p.id ? 'on' : ''}`}
              onClick={() => setSel(r.p.id)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  setSel(r.p.id)
                }
              }}
            >
              <PlatformIcon p={r.p} />
              <span className="t">
                <b>
                  {r.p.name} {badge(r)}
                </b>
                <small>{r.account!.name}</small>
              </span>
              {!r.locked && <Toggle on onChange={() => toggle(r, false)} title={`Remove ${r.p.name} from this post`} />}
            </div>
          ))}
          {rows.some((r) => !r.included) && <div className="pe-grp">Not in this post</div>}
          {rows
            .filter((r) => !r.included)
            .map((r) => (
              <div
                key={r.p.id}
                role="button"
                tabIndex={0}
                className={`pe-item off ${sel === r.p.id ? 'on' : ''}`}
                onClick={() => setSel(r.p.id)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    setSel(r.p.id)
                  }
                }}
              >
                <PlatformIcon p={r.p} />
                <span className="t">
                  <b>{r.p.name}</b>
                  <small>{r.account ? r.account.name : 'not connected'}</small>
                </span>
                {r.account ? (
                  <Toggle on={false} onChange={() => toggle(r, true)} title={`Add ${r.p.name} to this post`} />
                ) : (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConnectP(r.p)
                    }}
                  >
                    Connect
                  </button>
                )}
              </div>
            ))}
        </nav>

        <section className="pe-panel">
          {sel === 'main' || !current ? (
            <MainPanel
              m={m}
              setMain={setMain}
              infos={infos}
              posting={posting.length}
              aiForced={!!post?.aiGenerated && !m.aiGenerated}
              general={issues._ ?? []}
              onAsk={askClaude}
            />
          ) : (
            <PlatformPanel
              row={current}
              m={m}
              variant={current.account ? (variants[current.account.id] ?? {}) : {}}
              issues={current.account ? (issues[current.account.id] ?? []) : []}
              infos={infos}
              progress={current.target?.status === 'publishing' ? progress : undefined}
              stats={current.target ? stats.get(current.target.id) : undefined}
              onChange={(patch) => current.account && setVariant(current.account.id, patch)}
              onInclude={() => toggle(current, true)}
              onConnect={() => setConnectP(current.p)}
              onFit={(aspect, mode) => current.account && fitFor(current.account.id, aspect, mode)}
              onAsk={askClaude}
              onTarget={targetAction}
            />
          )}
        </section>

        <aside className="pe-prev">
          {sel === 'main' || !current ? (
            <>
              <div className="hd">Where it’s going</div>
              <div className="stack" style={{ padding: 14, gap: 6 }}>
                {posting.map((r) => (
                  <button key={r.p.id} className="pe-item" onClick={() => setSel(r.p.id)}>
                    <PlatformIcon p={r.p} size={26} />
                    <span className="t">
                      <b>{r.p.name}</b>
                      <small>{r.account!.name}</small>
                    </span>
                    {badge(r)}
                  </button>
                ))}
              </div>
              <div className="hint">Pick a platform on the left to edit its version and see how it will look there.</div>
            </>
          ) : (
            <>
              <div className="hd">
                <PlatformIcon p={current.p} size={22} /> Preview · {current.p.name}
              </div>
              <Preview p={current.p} account={current.account} m={m} v={current.account ? variants[current.account.id] : undefined} />
              <div className="hint">An approximation of how {current.p.name} shows it. Changes here apply to {current.p.name} only.</div>
            </>
          )}
        </aside>
      </div>
      {connectP && <ConnectDialog platform={connectP} onClose={() => setConnectP(undefined)} />}
    </div>
  )
}

// ---------------------------------------------------------------- panels

function FieldHead({ label, counter, custom, onReset }: { label: string; counter?: ReactNode; custom?: boolean; onReset?: () => void }) {
  return (
    <div className="fh">
      {label} {counter}
      <span className="grow" />
      {custom === undefined ? null : custom ? (
        <>
          <span className="mark custom">● custom</span>
          <button className="reset" onClick={onReset}>
            ↺ use main
          </button>
        </>
      ) : (
        <span className="mark follow">↳ from main</span>
      )}
    </div>
  )
}

function MediaGrid({ paths, infos, onRemove, onEdit, onAdd }: { paths: string[]; infos: Record<string, MediaInfo>; onRemove?: (p: string) => void; onEdit?: (p: string) => void; onAdd?: () => void }) {
  return (
    <div className="media-grid">
      {paths.map((p) => (
        <MediaTile key={p} path={p} info={describe(infos[p])} onRemove={onRemove ? () => onRemove(p) : undefined} onEdit={onEdit && isVideoPath(p) ? () => onEdit(p) : undefined} />
      ))}
      {onAdd && (
        <div className="media add" onClick={onAdd}>
          + Add video or images
        </div>
      )}
    </div>
  )
}

function MainPanel(props: {
  m: Main
  setMain: (p: Partial<Main> | ((cur: Main) => Partial<Main>)) => void
  infos: Record<string, MediaInfo>
  posting: number
  aiForced: boolean
  general: Issue[]
  onAsk: (text: (id: string) => string) => void
}) {
  const app = useApp()
  const { m, setMain } = props
  return (
    <>
      <div className="band main">
        <span className="bico">◎</span>
        <div>
          <b>Main post</b>
          <small className="muted">Shared by every platform unless a platform changes it</small>
        </div>
        <span className="stat">
          {props.posting} platform{props.posting === 1 ? '' : 's'}
        </span>
      </div>
      <div className="fields">
        <div>
          <FieldHead label="Title" counter={<span className="counter faint">{len(m.title)}</span>} />
          <input type="text" value={m.title} placeholder="Used where the platform has titles (YouTube, Bilibili, Rednote)" onChange={(e) => setMain({ title: e.target.value })} />
        </div>
        <div>
          <FieldHead label="Text" counter={<span className="counter faint">{len(m.body)}</span>} />
          <textarea value={m.body} style={{ minHeight: 150 }} placeholder="What do you want to say?" onChange={(e) => setMain({ body: e.target.value })} />
        </div>
        <div>
          <FieldHead label="Tags" />
          <TagsInput value={m.tags} onChange={(tags) => setMain({ tags })} />
        </div>
        <div>
          <FieldHead label="Media" />
          <MediaGrid
            paths={m.media}
            infos={props.infos}
            onRemove={(p) => setMain((cur) => ({ media: cur.media.filter((x) => x !== p) }))}
            onEdit={(p) => app.openStudio(p)}
            onAdd={async () => {
              const files = await call<string[]>('media.pick')
              if (files.length) setMain((cur) => ({ media: [...cur.media, ...files.filter((f) => !cur.media.includes(f))] }))
            }}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={m.aiGenerated || props.aiForced} disabled={props.aiForced} onChange={(e) => setMain({ aiGenerated: e.target.checked })} />
          <span>Made or substantially changed with AI</span>
          <span className="small faint">{props.aiForced ? 'required: this post uses a video Claude made' : 'adds each platform’s AI label'}</span>
        </label>
        {props.general.map((i, k) => (
          <div key={k} className={`issue ${i.level}`}>
            {i.message}
          </div>
        ))}
        <div className="ai-row">
          <button
            className="btn ai"
            onClick={() =>
              props.onAsk(
                (id) =>
                  `Write the platform versions for post ${id}: for each platform it's going to, read get_platform_rules and set a tailored title, text and tags with update_variant (and a resized video where the platform prefers another shape). Use the language of the main post. Don't publish.`
              )
            }
          >
            ✨ Write every platform’s version
          </button>
          <button className="btn ai" onClick={() => props.onAsk((id) => `Improve the main text of post ${id}: clearer and more engaging, same meaning and language. Use update_post. Don't publish.`)}>
            ✨ Improve the text
          </button>
        </div>
      </div>
    </>
  )
}

interface Row {
  p: PlatformManifest
  account?: Account
  target?: Target
  included: boolean
  locked: boolean
}

function PlatformPanel(props: {
  row: Row
  m: Main
  variant: Variant
  issues: Issue[]
  infos: Record<string, MediaInfo>
  progress?: { fraction: number; note?: string }
  stats?: TargetStats
  onChange: (patch: Partial<Variant>) => void
  onInclude: () => void
  onConnect: () => void
  onFit: (aspect: string, mode: string) => void
  onAsk: (text: (id: string) => string) => void
  onTarget: (fn: () => Promise<unknown>, ok?: string) => void
}) {
  const app = useApp()
  const { row, m, variant: v, onChange } = props
  const { p, account, target } = row
  const k = p.constraints
  // An account signed in on the website posts through the site's page: only the options that way uses, and its notes.
  const viaWeb = account?.meta.method === 'web' && !!p.web
  const options = viaWeb
    ? p.options
        .filter((o) => p.web?.options?.includes(o.key))
        // Required by the API, a reminder on the website: the person sets it on the site's own page.
        .map((o) => (o.required ? { ...o, required: false, help: `Optional here: you choose this on ${p.name}’s own page, and OneDraft reminds you of what you pick.` } : o))
    : p.options
  const notes = viaWeb ? (p.web?.notes ?? []) : p.notes
  const [mode, setMode] = useState('blur')
  const n = customCount(v)
  const band = (
    <div className="band" style={{ background: BAND[p.id] ?? `linear-gradient(120deg, ${p.color}, ${p.color}cc)` }}>
      <span className="bico">
        <PlatformIcon p={p} size={30} />
      </span>
      <div style={{ minWidth: 0 }}>
        <b>{p.name} version</b>
        <small>{account ? `${account.name}${account.handle ? ` · ${account.handle}` : ''}` : 'Not connected'}</small>
      </div>
      <span className="stat">
        {row.locked ? target!.status : !row.included ? 'Not in this post' : n ? `${n} changed for ${p.name} · rest follows main` : 'Everything follows the main post'}
      </span>
    </div>
  )

  if (!account || !row.included) {
    return (
      <>
        {band}
        <div className="fields">
          <div className="empty" style={{ padding: 30 }}>
            {account ? (
              <>
                <p>{p.name} isn’t part of this post.</p>
                <button className="btn primary" onClick={props.onInclude}>
                  Add {p.name} to this post
                </button>
              </>
            ) : (
              <>
                <p>Connect your {p.name} account to post there.</p>
                <button className="btn primary" onClick={props.onConnect}>
                  Connect {p.name}
                </button>
              </>
            )}
          </div>
          {notes.length > 0 && (
            <div className="note">
              {notes.map((x) => (
                <div key={x}>• {x}</div>
              ))}
            </div>
          )}
        </div>
      </>
    )
  }

  const title = v.title ?? m.title
  const caption = v.caption ?? m.body
  const tags = v.tags ?? m.tags
  const media = v.media ?? m.media
  const hasVideo = media.some(isVideoPath)
  const preferred = hasVideo ? k.video?.preferredAspect : k.image?.preferredAspect
  const t = target

  return (
    <>
      {band}
      {t && row.locked && (
        <div className="status-bar">
          <Status s={t.status} />
          {t.url && (
            <a href="#" onClick={() => call('shell.open', t.url)}>
              Open on {p.name} ↗
            </a>
          )}
          {p.capabilities.comments && isLive(t) && !viaWeb && (
            <a href="#" onClick={() => app.go('inbox', t.postId)}>
              Comments
            </a>
          )}
          <span className="grow small muted">{t.error}</span>
          {t.status === 'failed' && (
            <button className="btn sm" onClick={() => props.onTarget(() => call('targets.retry', t.id), 'Retrying.')}>
              Retry
            </button>
          )}
          {(t.status === 'unconfirmed' || t.status === 'handoff') && (
            <>
              <button className="btn sm" onClick={() => props.onTarget(() => call('targets.markDone', t.id), 'Marked as posted.')}>
                It’s live
              </button>
              <button
                className="btn sm"
                onClick={() => confirm('Post it again? Check the platform first, or it may appear twice.') && props.onTarget(() => call('targets.retry', t.id, true), 'Posting again.')}
              >
                Post again
              </button>
            </>
          )}
          {t.status === 'queued' && (
            <button className="btn sm" onClick={() => props.onTarget(() => call('posts.cancel', t.postId), 'Canceled.')}>
              Cancel
            </button>
          )}
          {props.progress && (
            <div style={{ flexBasis: '100%' }}>
              <div className="progress">
                <div style={{ width: `${Math.round(props.progress.fraction * 100)}%` }} />
              </div>
              <div className="small faint">{props.progress.note}</div>
            </div>
          )}
          {canHaveStats(t, p, account) && <TargetStatsStrip target={t} platform={p} stats={props.stats} />}
        </div>
      )}
      <fieldset disabled={row.locked} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="fields">
          {k.title && (
            <div>
              <FieldHead
                label={k.title.unit === 'halfAscii' ? 'Title (English letters count half)' : 'Title'}
                counter={<Counter n={k.title.unit === 'halfAscii' ? halfAscii(title) : len(title)} max={k.title.max} />}
                custom={v.title !== undefined}
                onReset={() => onChange({ title: undefined })}
              />
              <input type="text" className={v.title !== undefined ? 'custom-in' : 'follow-in'} value={title} onChange={(e) => onChange({ title: e.target.value })} />
            </div>
          )}
          <div>
            <FieldHead
              label={CAPTION_LABEL[p.id] ?? 'Text'}
              counter={k.caption ? <Counter n={len(caption)} max={k.caption.max} /> : undefined}
              custom={v.caption !== undefined}
              onReset={() => onChange({ caption: undefined })}
            />
            <textarea className={v.caption !== undefined ? 'custom-in' : 'follow-in'} value={caption} style={{ minHeight: 130 }} onChange={(e) => onChange({ caption: e.target.value })} />
          </div>
          <div>
            <FieldHead
              label={TAGS_LABEL[p.id] ?? (k.tags?.style === 'hashtags' ? 'Hashtags' : 'Tags')}
              counter={k.tags?.max ? <Counter n={tags.length} max={k.tags.max} /> : undefined}
              custom={v.tags !== undefined}
              onReset={() => onChange({ tags: undefined })}
            />
            <TagsInput className={v.tags !== undefined ? 'custom' : 'follow'} value={tags} onChange={(x) => onChange({ tags: x })} />
            {k.tags?.style === 'hashtags' && <div className="help">Added to the end of the text as #hashtags.</div>}
          </div>
          <div>
            <FieldHead label="Media" custom={v.media !== undefined} onReset={() => onChange({ media: undefined })} />
            <MediaGrid paths={media} infos={props.infos} onEdit={(x) => app.openStudio(x)} />
            <div className="row wrap" style={{ marginTop: 8 }}>
              {preferred && m.media.length > 0 && (
                <>
                  <select style={{ width: 150 }} value={mode} onChange={(e) => setMode(e.target.value)}>
                    <option value="blur">Blurred fill</option>
                    <option value="crop">Crop to fill</option>
                    <option value="pad">Bars</option>
                  </select>
                  <button className="btn sm" onClick={() => props.onFit(preferred, mode)}>
                    Make a {preferred} version
                  </button>
                </>
              )}
              <button
                className="btn sm"
                onClick={async () => {
                  const files = await call<string[]>('media.pick')
                  if (files.length) onChange({ media: files })
                }}
              >
                Use different files
              </button>
            </div>
          </div>
          {hasVideo && (p.id === 'youtube' || p.id === 'bilibili') && (
            <div>
              <FieldHead label="Cover" />
              <div className="row">
                <span className="small grow">{v.cover ? fileName(v.cover) : 'Chosen automatically'}</span>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const f = await call<string | undefined>('media.pickOne', 'image')
                    if (f) onChange({ cover: f })
                  }}
                >
                  Choose image
                </button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const src = media.find(isVideoPath)
                    if (src) onChange({ cover: await call<string>('media.cover', src, 1) })
                  }}
                >
                  Frame at 1 s
                </button>
                {v.cover && (
                  <button className="btn ghost sm" onClick={() => onChange({ cover: undefined })}>
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}
          {options.length > 0 && (
            <div>
              <FieldHead label={`${p.name} options`} />
              <div className="opts">
                {options.map((o) => (
                  <Field key={o.key} spec={o} value={v.options?.[o.key]} onChange={(val) => onChange({ options: { ...(v.options ?? {}), [o.key]: val } })} />
                ))}
              </div>
            </div>
          )}
          {props.issues.length > 0 && (
            <div className="issues">
              {props.issues.map((i, n2) => (
                <div key={n2} className={`issue ${i.level}`}>
                  {i.level === 'error' ? '✕' : '!'} {i.message}
                </div>
              ))}
            </div>
          )}
          <div className="ai-row">
            <button
              className="btn ai"
              onClick={() =>
                props.onAsk(
                  (id) =>
                    `Rewrite the ${p.name} version of post ${id} so it suits ${p.name}: read get_platform_rules for ${p.id}, then change only that platform with update_variant. Keep the language of the main post. Don't publish.`
                )
              }
            >
              ✨ Rewrite for {p.name}
            </button>
            {k.caption && k.caption.max <= 300 && (
              <button className="btn ai" onClick={() => props.onAsk((id) => `Shorten the ${p.name} text of post ${id} to fit ${k.caption!.max} characters with update_variant. Don't publish.`)}>
                ✨ Shorten
              </button>
            )}
            <button className="btn ai" onClick={() => props.onAsk((id) => `Suggest better ${TAGS_LABEL[p.id]?.toLowerCase() ?? 'tags'} for the ${p.name} version of post ${id} and set them with update_variant. Don't publish.`)}>
              ✨ Suggest {TAGS_LABEL[p.id]?.toLowerCase() ?? 'tags'}
            </button>
          </div>
          {notes.length > 0 && (
            <div className="note">
              {notes.map((x) => (
                <div key={x}>• {x}</div>
              ))}
            </div>
          )}
        </div>
      </fieldset>
    </>
  )
}

// ---------------------------------------------------------------- preview

function MediaEl({ path }: { path?: string }) {
  if (!path) return null
  return isVideoPath(path) ? <video src={`${mediaUrl(path)}#t=1`} muted preload="metadata" /> : <img src={mediaUrl(path)} alt="" />
}

function Preview({ p, account, m, v }: { p: PlatformManifest; account?: Account; m: Main; v?: Variant }) {
  const title = v?.title ?? m.title
  const caption = v?.caption ?? m.body
  const tags = (v?.tags ?? m.tags).map((t) => `#${t.replace(/^#/, '')}`)
  const media = v?.media ?? m.media
  const name = account?.name ?? p.name
  const handle = account?.handle ?? ''
  const hasVideo = media.some(isVideoPath)

  if (p.id === 'rednote') {
    return (
      <div className="phone">
        <div className="scr">
          <div className="cover">
            <MediaEl path={media[0]} />
            {title && <div className="ctitle">{title}</div>}
          </div>
          <div className="nb">
            <b>{title}</b>
            {caption.slice(0, 160)}
          </div>
          <div className="nb tags">{tags.join(' ')}</div>
        </div>
      </div>
    )
  }
  if (p.id === 'tiktok' || (p.id === 'instagram' && hasVideo)) {
    return (
      <div className="phone">
        <div className="scr" style={{ background: '#000' }}>
          <div className="cover full">
            <MediaEl path={media[0]} />
          </div>
          <div className="rail">
            <span>♡</span>
            <span>💬</span>
            <span>↗</span>
          </div>
          <div className="overlay">
            <b>{handle || name}</b>
            {'\n'}
            {caption.slice(0, 140)} {tags.join(' ')}
          </div>
        </div>
      </div>
    )
  }
  if (p.id === 'instagram') {
    return (
      <div className="phone">
        <div className="scr">
          <div className="nb" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="avatar" style={{ width: 22, height: 22, fontSize: 10, background: '#e1306c' }}>
              {name.slice(0, 1)}
            </span>
            <b style={{ margin: 0 }}>{handle || name}</b>
          </div>
          <div className="cover" style={{ height: 290 }}>
            <MediaEl path={media[0]} />
          </div>
          <div className="nb">
            <b style={{ display: 'inline' }}>{handle || name}</b> {caption.slice(0, 140)} <span className="tags">{tags.join(' ')}</span>
          </div>
        </div>
      </div>
    )
  }
  if (p.id === 'x') {
    return (
      <div className="wcard">
        <div className="tweet">
          <div className="who">
            <span className="avatar" style={{ width: 30, height: 30, fontSize: 12, background: '#111' }}>
              {name.slice(0, 1)}
            </span>
            <span>
              <b>{name}</b> <span style={{ color: '#666' }}>{handle}</span>
            </span>
          </div>
          {caption}
          {tags.length ? `\n\n${tags.join(' ')}` : ''}
          {media[0] && (
            <div className="tm">
              <MediaEl path={media[0]} />
            </div>
          )}
        </div>
      </div>
    )
  }
  // YouTube, Bilibili and anything else: a video page card.
  return (
    <div className="wcard">
      <div className="m16">
        <MediaEl path={media[0]} />
      </div>
      <div className="body">
        <b>{title || '(no title)'}</b>
        <div className="meta">
          {p.id === 'bilibili' ? 'UP ' : ''}
          {name}
        </div>
        <div className="desc">
          {caption}
          {p.constraints.tags?.style !== 'hashtags' && tags.length ? `\n\n${tags.join(' ')}` : ''}
        </div>
      </div>
    </div>
  )
}
