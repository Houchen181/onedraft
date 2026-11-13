import { useEffect, useMemo, useRef, useState } from 'react'
import type { Account, Issue, MediaInfo, Post, PostDraft, Variant } from '@shared/types'
import { call, fileName, isVideoPath, on, useData } from '../api'
import { Counter, Field, MediaTile, PlatformDot, Status, TagsInput, useApp } from '../ui'

interface Master {
  title: string
  body: string
  tags: string[]
  media: string[]
  aiGenerated: boolean
  scheduledAt: string // datetime-local value, '' = now
}

const EMPTY: Master = { title: '', body: '', tags: [], media: [], aiGenerated: false, scheduledAt: '' }

const toLocalInput = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function describeMedia(i?: MediaInfo) {
  if (!i) return undefined
  const parts = []
  if (i.width && i.height) parts.push(`${i.width}×${i.height}`)
  if (i.durationSec) parts.push(`${Math.floor(i.durationSec / 60)}:${String(Math.round(i.durationSec % 60)).padStart(2, '0')}`)
  parts.push(`${(i.sizeBytes / 1e6).toFixed(1)} MB`)
  return parts.join(' · ')
}

export function Compose({ postId: initialId, seedMedia, onSaved }: { postId?: string; seedMedia?: string[]; onSaved: (id: string | undefined) => void }) {
  const app = useApp()
  const { data: accounts } = useData<Account[]>('accounts.list', [], ['accounts'])
  const [postId, setPostId] = useState<string | undefined>(initialId)
  const [m, setM] = useState<Master>(EMPTY)
  const [variants, setVariants] = useState<Record<string, Variant>>({}) // accountId -> variant
  const [post, setPost] = useState<Post>()
  const [issues, setIssues] = useState<Record<string, Issue[]>>({}) // accountId -> issues
  const [tab, setTab] = useState<string>('master')
  const [infos, setInfos] = useState<Record<string, MediaInfo>>({})
  const [busy, setBusy] = useState<string>()
  const dirty = useRef(false)
  const lastSaved = useRef<string | undefined>(undefined)

  // ---------- load ----------
  const loadPost = async (id: string) => {
    const p = await call<Post | undefined>('posts.get', id)
    if (!p) return
    setPost(p)
    setPostId(p.id)
    lastSaved.current = p.updatedAt
    setM({ title: p.title, body: p.body, tags: p.tags, media: p.media, aiGenerated: p.aiGenerated, scheduledAt: toLocalInput(p.scheduledAt) })
    setVariants(Object.fromEntries(p.targets.map((t) => [t.accountId, t.variant])))
    await validate(p)
  }
  useEffect(() => {
    if (initialId) void loadPost(initialId)
    else {
      setPostId(undefined)
      setPost(undefined)
      setVariants({})
      setIssues({})
      setTab('master')
      if (seedMedia?.length) {
        // Started from Studio: AI-generated renders come pre-labelled.
        void Promise.all(seedMedia.map((p) => call<boolean>('media.isAi', p))).then((ai) => setM({ ...EMPTY, media: seedMedia, aiGenerated: ai.some(Boolean) }))
      } else setM(EMPTY)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId])

  // Pick up edits made by the assistant while this page is open.
  useEffect(
    () =>
      on('changed', async (k) => {
        if (k !== 'posts' || !postId || dirty.current) return
        const p = await call<Post | undefined>('posts.get', postId)
        if (p && p.updatedAt !== lastSaved.current) void loadPost(postId)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [postId]
  )

  // Probe media for sizes/durations.
  const allMedia = useMemo(() => [...new Set([...m.media, ...Object.values(variants).flatMap((v) => v.media ?? [])])], [m.media, variants])
  useEffect(() => {
    for (const p of allMedia) {
      if (infos[p]) continue
      call<MediaInfo>('media.probe', p)
        .then((i) => setInfos((s) => ({ ...s, [p]: i })))
        .catch(() => undefined)
    }
  }, [allMedia, infos])

  // ---------- save + validate ----------
  async function validate(p: Post) {
    const byTarget = await call<Record<string, Issue[]>>('posts.validate', p.id)
    const byAccount: Record<string, Issue[]> = {}
    for (const t of p.targets) byAccount[t.accountId] = byTarget[t.id] ?? []
    if (byTarget._) byAccount._ = byTarget._
    setIssues(byAccount)
  }

  const save = async (master = m, vars = variants): Promise<Post | undefined> => {
    if (!master.title && !master.body && !master.media.length && !Object.keys(vars).length) return undefined
    const draft: PostDraft = {
      id: postId,
      title: master.title,
      body: master.body,
      tags: master.tags,
      media: master.media,
      aiGenerated: master.aiGenerated,
      scheduledAt: master.scheduledAt ? new Date(master.scheduledAt).toISOString() : undefined,
      targets: Object.entries(vars).map(([accountId, variant]) => ({ accountId, variant }))
    }
    const p = await call<Post>('posts.save', draft)
    lastSaved.current = p.updatedAt
    dirty.current = false
    setPost(p)
    if (!postId) {
      setPostId(p.id)
      onSaved(p.id)
    }
    await validate(p)
    return p
  }

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const schedule = (master: Master, vars: Record<string, Variant>) => {
    dirty.current = true
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(master, vars).catch((e: Error) => app.toast(e.message, true)), 600)
  }
  const setMaster = (patch: Partial<Master>) => {
    const next = { ...m, ...patch }
    setM(next)
    schedule(next, variants)
  }
  const setVariant = (accountId: string, patch: Partial<Variant> | undefined) => {
    const next = { ...variants }
    if (patch === undefined) delete next[accountId]
    else next[accountId] = { ...(next[accountId] ?? {}), ...patch }
    setVariants(next)
    schedule(m, next)
  }

  // ---------- actions ----------
  const pickMedia = async () => {
    const files = await call<string[]>('media.pick')
    if (files.length) setMaster({ media: [...m.media, ...files.filter((f) => !m.media.includes(f))] })
  }

  const toggleAccount = (a: Account) => {
    const target = post?.targets.find((t) => t.accountId === a.id)
    if (target && target.status !== 'draft' && target.status !== 'canceled') return
    if (variants[a.id]) {
      setVariant(a.id, undefined)
      if (tab === a.id) setTab('master')
    } else {
      // Pre-fill option defaults so required choices are visible.
      setVariant(a.id, { options: {} })
    }
  }

  const fitFor = async (accountId: string, aspect: string, mode: 'blur' | 'crop' | 'pad') => {
    const source = m.media
    if (!source.length) return
    setBusy(`Converting to ${aspect}…`)
    try {
      const out: string[] = []
      for (const p of source) out.push((await call<MediaInfo>('media.fit', p, aspect, mode)).path)
      setVariant(accountId, { media: out })
      app.toast(`Made ${out.length} ${aspect} file(s) for this account.`)
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(undefined)
    }
  }

  const approve = async () => {
    clearTimeout(timer.current)
    setBusy('Checking…')
    try {
      const p = await save()
      if (!p) return
      const when = m.scheduledAt ? new Date(m.scheduledAt).toISOString() : undefined
      await call('posts.approve', p.id, when)
      app.toast(when ? 'Scheduled.' : 'Publishing now — follow it on the Posts page.')
      app.go('posts')
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(undefined)
    }
  }

  const connected = (accounts ?? []).filter((a) => app.platform(a.platform))
  const selected = connected.filter((a) => variants[a.id])
  const errorCount = Object.values(issues).flat().filter((i) => i.level === 'error').length
  const targetOf = (accountId: string) => post?.targets.find((t) => t.accountId === accountId)

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 18 }}>
        <div className="grow">
          <h1>{postId ? 'Edit post' : 'New post'}</h1>
          <p className="sub" style={{ margin: 0 }}>
            Write it once, then fine-tune for each account. Drafts save automatically.
          </p>
        </div>
        {postId && (
          <button
            className="btn"
            onClick={() =>
              app.ask(
                `Tailor draft post ${postId} for each of its accounts: read each platform's rules, write a platform-specific title, caption and tags, and make media renditions where the platform prefers another aspect ratio. Don't publish.`
              )
            }
          >
            ✨ Tailor with AI
          </button>
        )}
        <button className="btn ghost" onClick={() => app.go('compose')}>
          New
        </button>
      </div>

      <div className="card">
        <h2>Accounts</h2>
        {connected.length ? (
          <div className="row wrap">
            {connected.map((a) => {
              const t = targetOf(a.id)
              const locked = t && t.status !== 'draft' && t.status !== 'canceled'
              return (
                <button key={a.id} className={`chip ${variants[a.id] ? 'on' : ''}`} onClick={() => toggleAccount(a)} title={locked ? `Already ${t?.status}` : a.platform}>
                  <span className="dot" style={{ background: app.platform(a.platform)?.color }} />
                  {a.name}
                  <span className="faint small">{app.platform(a.platform)?.name}</span>
                  {locked && <Status s={t!.status} />}
                </button>
              )
            })}
          </div>
        ) : (
          <div className="muted">
            No accounts yet.{' '}
            <a href="#" onClick={() => app.go('accounts')}>
              Connect one
            </a>
            .
          </div>
        )}
      </div>

      <div className="card">
        <div className="tabs">
          <button className={tab === 'master' ? 'active' : ''} onClick={() => setTab('master')}>
            Master
          </button>
          {selected.map((a) => {
            const errs = (issues[a.id] ?? []).filter((i) => i.level === 'error').length
            return (
              <button key={a.id} className={tab === a.id ? 'active' : ''} onClick={() => setTab(a.id)}>
                <PlatformDot color={app.platform(a.platform)?.color} />
                {a.name}
                {errs > 0 && <span className="pill err">{errs}</span>}
              </button>
            )
          })}
        </div>

        {tab === 'master' ? (
          <div className="stack">
            <label className="field">
              <span className="lab">
                <span>Title</span>
                <Counter n={[...m.title].length} />
              </span>
              <input type="text" value={m.title} onChange={(e) => setMaster({ title: e.target.value })} placeholder="Used where the platform has titles (YouTube, Bilibili, Rednote)" />
            </label>
            <label className="field">
              <span className="lab">
                <span>Text</span>
                <Counter n={[...m.body].length} />
              </span>
              <textarea value={m.body} onChange={(e) => setMaster({ body: e.target.value })} placeholder="Caption / description" style={{ minHeight: 130 }} />
            </label>
            <label className="field">
              <span className="lab">Tags</span>
              <TagsInput value={m.tags} onChange={(tags) => setMaster({ tags })} />
            </label>
            <div>
              <div className="lab small muted" style={{ marginBottom: 6 }}>
                Media
              </div>
              <div className="media-grid">
                {m.media.map((p) => (
                  <MediaTile
                    key={p}
                    path={p}
                    info={describeMedia(infos[p])}
                    onRemove={() => setMaster({ media: m.media.filter((x) => x !== p) })}
                    onEdit={isVideoPath(p) ? () => app.openStudio(p) : undefined}
                  />
                ))}
                <div className="media add" onClick={pickMedia}>
                  + Add video or images
                </div>
              </div>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={m.aiGenerated || !!post?.aiGenerated}
                disabled={!!post?.aiGenerated && !m.aiGenerated}
                onChange={(e) => setMaster({ aiGenerated: e.target.checked })}
              />
              <span>Made or substantially altered with AI</span>
              <span className="faint small">
                {post?.aiGenerated && !m.aiGenerated ? 'required: this post uses a video Claude generated' : 'sets each platform’s AI-content label'}
              </span>
            </label>
          </div>
        ) : (
          (() => {
            const a = selected.find((x) => x.id === tab)
            if (!a) return null
            return (
              <TargetEditor
                account={a}
                master={m}
                variant={variants[a.id] ?? {}}
                issues={issues[a.id] ?? []}
                infos={infos}
                status={targetOf(a.id)?.status}
                onChange={(patch) => setVariant(a.id, patch)}
                onFit={(aspect, mode) => fitFor(a.id, aspect, mode)}
              />
            )
          })()
        )}
      </div>

      <div className="card">
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ width: 260 }}>
            <span className="lab">Publish time</span>
            <input type="datetime-local" value={m.scheduledAt} onChange={(e) => setMaster({ scheduledAt: e.target.value })} />
          </label>
          {m.scheduledAt && (
            <button className="btn ghost sm" onClick={() => setMaster({ scheduledAt: '' })}>
              Clear (publish now)
            </button>
          )}
          <div className="grow" />
          {busy && <span className="muted small">{busy}</span>}
          {errorCount > 0 && <span className="pill err">{errorCount} to fix</span>}
          <button className="btn primary" disabled={!selected.length || errorCount > 0 || !!busy} onClick={approve}>
            {m.scheduledAt ? 'Approve & schedule' : 'Approve & publish'}
          </button>
        </div>
        {(issues._ ?? []).map((i, k) => (
          <div key={k} className={`issue ${i.level}`} style={{ marginTop: 10 }}>
            {i.message}
          </div>
        ))}
        {selected.length > 0 && Object.entries(issues).some(([k, v]) => k !== '_' && v.length) && (
          <div className="issues">
            {selected.flatMap((a) =>
              (issues[a.id] ?? []).map((i, k) => (
                <div key={`${a.id}${k}`} className={`issue ${i.level}`}>
                  <PlatformDot color={app.platform(a.platform)?.color} />
                  <span>
                    <b>{a.name}:</b> {i.message}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TargetEditor(props: {
  account: Account
  master: Master
  variant: Variant
  issues: Issue[]
  infos: Record<string, MediaInfo>
  status?: string
  onChange: (patch: Partial<Variant>) => void
  onFit: (aspect: string, mode: 'blur' | 'crop' | 'pad') => void
}) {
  const app = useApp()
  const { account, master, variant: v, onChange } = props
  const pm = app.platform(account.platform)!
  const k = pm.constraints
  const media = v.media ?? master.media
  const hasVideo = media.some(isVideoPath)
  const preferred = hasVideo ? k.video?.preferredAspect : k.image?.preferredAspect
  const [mode, setMode] = useState<'blur' | 'crop' | 'pad'>('blur')
  const locked = props.status && props.status !== 'draft' && props.status !== 'canceled'
  const title = v.title ?? master.title
  const caption = v.caption ?? master.body

  return (
    <fieldset disabled={!!locked} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
      {pm.notes.length > 0 && (
        <div className="note">
          {pm.notes.map((n) => (
            <div key={n}>• {n}</div>
          ))}
        </div>
      )}
      {k.title && (
        <label className="field">
          <span className="lab">
            <span>Title {v.title === undefined && <span className="faint">(from master)</span>}</span>
            <Counter n={[...title].length} max={k.title.max} />
          </span>
          <input type="text" value={title} onChange={(e) => onChange({ title: e.target.value })} />
        </label>
      )}
      <label className="field">
        <span className="lab">
          <span>
            {k.title ? 'Description' : 'Caption'} {v.caption === undefined && <span className="faint">(from master)</span>}
          </span>
          <Counter n={[...caption].length} max={k.caption?.max} />
        </span>
        <textarea value={caption} onChange={(e) => onChange({ caption: e.target.value })} style={{ minHeight: 120 }} />
      </label>
      <label className="field">
        <span className="lab">
          <span>
            Tags {v.tags === undefined && <span className="faint">(from master)</span>}
            {k.tags?.style === 'hashtags' && <span className="faint"> — added to the caption as #hashtags</span>}
          </span>
          {k.tags?.max && <Counter n={(v.tags ?? master.tags).length} max={k.tags.max} />}
        </span>
        <TagsInput value={v.tags ?? master.tags} onChange={(tags) => onChange({ tags })} />
      </label>

      <div>
        <div className="row" style={{ marginBottom: 6 }}>
          <span className="small muted grow">Media {v.media === undefined ? <span className="faint">(from master)</span> : <span className="pill accent">custom for this account</span>}</span>
          {preferred && master.media.length > 0 && (
            <>
              <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} style={{ width: 150 }}>
                <option value="blur">Blurred fill</option>
                <option value="crop">Crop to fill</option>
                <option value="pad">Black bars</option>
              </select>
              <button className="btn sm" onClick={() => props.onFit(preferred, mode)}>
                Make {preferred} version
              </button>
            </>
          )}
          {v.media !== undefined && (
            <button className="btn ghost sm" onClick={() => onChange({ media: undefined })}>
              Use master media
            </button>
          )}
        </div>
        <div className="media-grid">
          {media.map((p) => (
            <MediaTile key={p} path={p} info={describeMedia(props.infos[p])} />
          ))}
        </div>
      </div>

      {hasVideo && (pm.id === 'youtube' || pm.id === 'bilibili') && (
        <div className="row">
          <span className="small muted">Cover:</span>
          <span className="small">{v.cover ? fileName(v.cover) : 'automatic'}</span>
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
            Use frame at 1 s
          </button>
          {v.cover && (
            <button className="btn ghost sm" onClick={() => onChange({ cover: undefined })}>
              Clear
            </button>
          )}
        </div>
      )}

      {pm.options.length > 0 && (
        <>
          <h3>{pm.name} options</h3>
          <div className="split">
            {pm.options.map((o) => (
              <Field key={o.key} spec={o} value={v.options?.[o.key]} onChange={(val) => onChange({ options: { ...(v.options ?? {}), [o.key]: val } })} />
            ))}
          </div>
        </>
      )}

      {props.issues.length > 0 && (
        <div className="issues">
          {props.issues.map((i, n) => (
            <div key={n} className={`issue ${i.level}`}>
              {i.level === 'error' ? '✕' : '!'} {i.message}
            </div>
          ))}
        </div>
      )}
    </fieldset>
  )
}
