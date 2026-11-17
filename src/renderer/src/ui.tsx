// Small shared UI pieces.

import { createContext, useContext, useState, type ReactNode } from 'react'
import type { Account, FieldSpec, PlatformManifest, SettingsView, TargetStatus } from '@shared/types'
import { call, fileName, isVideoPath, mediaUrl, useData } from './api'

export interface AppCtx {
  toast(text: string, error?: boolean): void
  /** Open a page. `postId` opens that post (page 'post') or shows only its comments (page 'inbox'). */
  go(page: Page, postId?: string): void
  /** Send a request to the assistant. With `background`, stay on the current page. */
  ask(text: string, opts?: { background?: boolean }): void
  /** Start a new post, optionally with these files. */
  newPost(media?: string[]): void
  /** Open Studio with a new edit of this clip. */
  openStudio(path?: string): void
  platforms: PlatformManifest[]
  platform(id: string): PlatformManifest | undefined
  /** One account per platform. */
  accounts: Account[]
  accountFor(platform: string): Account | undefined
  assistantBusy: boolean
}
export type Page = 'chat' | 'posts' | 'post' | 'inbox' | 'calendar' | 'studio' | 'settings'
export const Ctx = createContext<AppCtx>(null as unknown as AppCtx)
export const useApp = () => useContext(Ctx)

/** Short mark shown in a platform's colour square. */
const MARK: Record<string, string> = { youtube: '▶', rednote: 'R', bilibili: 'B', instagram: 'IG', tiktok: 'T', x: 'X' }
const DARK_TEXT = new Set(['tiktok'])

export function PlatformIcon({ p, size = 30 }: { p?: PlatformManifest; size?: number }) {
  const id = p?.id ?? '?'
  return (
    <span
      className="picon"
      style={{
        background: id === 'tiktok' ? '#25f4ee' : id === 'x' ? '#111' : (p?.color ?? '#888'),
        color: DARK_TEXT.has(id) ? '#111' : '#fff',
        width: size,
        height: size,
        fontSize: size * 0.38
      }}
    >
      {MARK[id] ?? (p?.name ?? '?').slice(0, 1).toUpperCase()}
    </span>
  )
}

export function Toggle({ on, onChange, disabled, title }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      className={`toggle ${on ? 'on' : ''}`}
      disabled={disabled}
      title={title}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!on)
      }}
    />
  )
}

/** What pressing Connect does, for connectors that don't say. */
const HOW: Record<string, string> = {
  api: 'Your browser opens the platform’s sign-in page. Approve access, then come back here.',
  browser: 'A browser window opens on the platform. Sign in there; OneDraft keeps that login in its own browser profile.',
  cli: 'A console window opens. Choose the QR-code login and scan it with the phone app.',
  mcp: 'OneDraft checks that the MCP server is reachable and logged in.',
  plugin: 'The plugin handles login.'
}

/** Platforms that need a one-time setup on their developer site before the first Connect. */
export const needsSetup = (p: PlatformManifest) => !!p.guide

/** "Press **Create**" → Press <b>Create</b>; {key} → `fill(key)`. */
function rich(text: string, fill: (key: string) => string): ReactNode[] {
  return text
    .replace(/\{(\w+)\}/g, (_, k: string) => fill(k))
    .split(/\*\*(.+?)\*\*/g)
    .map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))
}

/** A pasted value that looks like the wrong thing (e.g. an API key where the client ID goes). */
function mismatch(spec: FieldSpec | undefined, v: unknown): string | undefined {
  const s = String(v ?? '').trim()
  if (!spec?.pattern || !s) return undefined
  try {
    return new RegExp(spec.pattern).test(s) ? undefined : (spec.mismatch ?? 'This doesn’t look like the right value. Check you copied the whole thing.')
  } catch {
    return undefined
  }
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const app = useApp()
  return (
    <div className="copyval">
      <span className="small muted">{label}</span>
      <code>{value}</code>
      <button
        className="btn sm"
        onClick={() => {
          void navigator.clipboard.writeText(value)
          app.toast(`Copied “${value}”.`)
        }}
      >
        Copy
      </button>
    </div>
  )
}

/**
 * Connect (or replace) the one account for a platform. Platforms that need their own developer app first get a
 * numbered walkthrough: each step opens the exact page, offers the values to copy, and has the box to paste the
 * key into right where the platform shows it. The keys are saved here; nobody has to visit Settings first.
 */
export function ConnectDialog({ platform: p, onClose, onSaved }: { platform: PlatformManifest; onClose: () => void; onSaved?: () => void }) {
  const app = useApp()
  const existing = app.accountFor(p.id)
  const g = p.guide
  const { data: settings, reload } = useData<SettingsView>('settings.get', [])
  /** Setup values typed here (setting keys without the platform prefix), saved on Connect or Close. */
  const [typed, setTyped] = useState<Record<string, unknown>>({})
  const [input, setInput] = useState<Record<string, unknown>>(
    Object.fromEntries(p.connectFields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]))
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [showSteps, setShowSteps] = useState<boolean>()

  const settingSpec = (k: string) => p.settings.find((s) => s.key === k)
  const connectSpec = (k: string) => p.connectFields.find((s) => s.key === k)
  const saved = (k: string) => settings?.values[`${p.id}.${k}`]
  const secretSaved = (k: string) => !!settings?.secretsSet.includes(`${p.id}.${k}`)
  const filled = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== ''
  const hasSetting = (s: FieldSpec) => filled(typed[s.key]) || filled(saved(s.key)) || secretSaved(s.key) || s.default !== undefined
  const fill = (k: string) => String(typed[k] ?? saved(k) ?? settingSpec(k)?.default ?? '')

  const guideKeys = new Set(g?.steps.flatMap((s) => s.fields ?? []) ?? [])
  const missingSettings = p.settings.filter((s) => s.required && !hasSetting(s))
  const missingInput = p.connectFields.filter((f) => f.required && !filled(input[f.key]))
  // Steps start open while there is something to do in them (a key to paste, or a token every time).
  const stepsOpen = !!g && (showSteps ?? (missingSettings.length > 0 || p.connectFields.some((f) => guideKeys.has(f.key))))
  const stepOf = (k: string) => (g ? g.steps.findIndex((s) => s.fields?.includes(k)) + 1 : 0)
  const todo = [...missingSettings, ...missingInput]
  /** "First paste the Client ID and the Client secret (step 6)." */
  const todoText = (() => {
    const names = todo.map((f) => `the ${f.label}`)
    const steps = [...new Set(todo.map((f) => stepOf(f.key)).filter((n) => n > 0))]
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
    return `First paste ${list}${steps.length ? ` (step ${steps.join(' and ')})` : ''}.`
  })()

  const persist = async () => {
    const entries = Object.entries(typed)
      .filter(([k, v]) => settingSpec(k) && !(settingSpec(k)!.type === 'secret' && !filled(v)))
      .map(([k, v]) => ({ key: `${p.id}.${k}`, value: typeof v === 'string' ? v.trim() : v, secret: settingSpec(k)!.type === 'secret' }))
    if (!entries.length) return
    await call('settings.set', entries)
    setTyped({})
    reload()
    onSaved?.()
  }
  const close = () => {
    void persist().catch((e: Error) => app.toast(e.message, true))
    onClose()
  }
  const connect = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await persist()
      const values = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v ?? '').trim()]))
      const a = await call<Account>('accounts.connect', p.id, values)
      app.toast(`${p.name} connected as ${a.name}.`)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const fieldFor = (k: string) => {
    const sSpec = settingSpec(k)
    const spec = sSpec ?? connectSpec(k)
    if (!spec) return null
    const v = sSpec ? (spec.type === 'secret' ? typed[k] : (typed[k] ?? saved(k))) : input[k]
    const warn = mismatch(spec, v)
    return (
      <div key={k}>
        <Field
          spec={spec}
          value={v}
          secretSet={sSpec ? secretSaved(k) : undefined}
          onChange={(nv) => (sSpec ? setTyped((s) => ({ ...s, [k]: nv })) : setInput((s) => ({ ...s, [k]: nv })))}
        />
        {warn && <div className="field-warn">⚠ {warn}</div>}
      </div>
    )
  }
  const signIn = p.signIn ?? HOW[p.kind]

  return (
    <Modal onClose={busy ? undefined : close} wide={!!g}>
      <div className="row" style={{ marginBottom: 6 }}>
        <PlatformIcon p={p} size={34} />
        <h2 style={{ margin: 0 }}>{existing ? `Replace your ${p.name} account` : `Connect ${p.name}`}</h2>
      </div>
      {existing && <div className="note" style={{ marginBottom: 10 }}>OneDraft keeps one account per platform. Signing in again replaces {existing.name}; drafts and scheduled posts move to the new account.</div>}
      {g && !settings ? (
        <p className="muted">Loading…</p>
      ) : g ? (
        <>
          <p className="muted" style={{ marginTop: 4 }}>
            {rich(g.why, fill)}
          </p>
          {g.warning && <div className="note warn">{rich(g.warning, fill)}</div>}
          <div className="need">
            <b>Before you start</b>
            <ul>
              {g.need.map((n) => (
                <li key={n}>{n}</li>
              ))}
              <li>Takes {g.time}, once.</li>
            </ul>
          </div>
          {stepsOpen ? (
            <ol className="guide">
              {g.steps.map((s, i) => (
                <li key={i}>
                  <div>{rich(s.text, fill)}</div>
                  {s.detail && <div className="help">{rich(s.detail, fill)}</div>}
                  {s.link && (
                    <div>
                      <button className="btn sm" onClick={() => void call('shell.open', s.link!.url)}>
                        {s.link.label} ↗
                      </button>
                    </div>
                  )}
                  {s.icon && (
                    <div>
                      <button
                        className="btn sm"
                        onClick={() => void call('app.iconFile', s.icon).catch((e: Error) => app.toast(e.message, true))}
                        title="Saves a PNG and shows it in File Explorer, ready to drag onto the form"
                      >
                        Get OneDraft’s icon ({s.icon} × {s.icon})
                      </button>
                    </div>
                  )}
                  {s.copy?.map((c) => <CopyValue key={c.label} label={c.label} value={c.value.replace(/\{(\w+)\}/g, (_, k: string) => fill(k))} />)}
                  {s.fields?.map(fieldFor)}
                </li>
              ))}
              <li>
                <div>
                  Press <b>{existing ? 'Sign in with another account' : 'Connect'}</b> below. {rich(signIn, fill)}
                </div>
              </li>
            </ol>
          ) : (
            <div className="row" style={{ margin: '12px 0' }}>
              <span className="pill ok">✓ Setup done</span>
              <span className="small muted grow">Your {p.name} keys are saved on this computer.</span>
              <button className="btn ghost sm" onClick={() => setShowSteps(true)}>
                Show the setup steps
              </button>
            </div>
          )}
          {!stepsOpen && <p className="muted small">{rich(signIn, fill)}</p>}
        </>
      ) : (
        <p className="muted">{rich(signIn, fill)}</p>
      )}
      <div className="stack">
        {p.connectFields.filter((f) => !(stepsOpen && guideKeys.has(f.key))).map((f) => fieldFor(f.key))}
        {p.notes.length > 0 && (
          <div className="note">
            <b>Good to know</b>
            {p.notes.map((n) => (
              <div key={n}>• {n}</div>
            ))}
          </div>
        )}
        {g?.trouble && g.trouble.length > 0 && (
          <details className="trouble" open={!!error}>
            <summary>Something not working?</summary>
            {g.trouble.map((t) => (
              <div key={t.problem}>
                <b>{rich(t.problem, fill)}</b>
                <div>{rich(t.fix, fill)}</div>
              </div>
            ))}
          </details>
        )}
        {!g && p.source !== 'builtin' && p.docsUrl && (
          <a href="#" className="small" onClick={() => void call('shell.open', p.docsUrl)}>
            This connector’s setup instructions ↗
          </a>
        )}
        {error && <div className="note err">{error}</div>}
      </div>
      <div className="actions">
        {busy ? (
          <>
            <span className="muted small" style={{ alignSelf: 'center' }}>
              Waiting for you to finish signing in…
            </span>
            <button className="btn" onClick={() => void call('accounts.cancelConnect', p.id)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {todo.length > 0 && (
              <span className="muted small grow" style={{ alignSelf: 'center' }}>
                {todoText}
              </span>
            )}
            <button className="btn ghost" onClick={close}>
              Close
            </button>
            <button className="btn primary" disabled={todo.length > 0} onClick={connect}>
              {existing ? 'Sign in with another account' : 'Connect'}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}

export function PlatformDot({ color, size = 10 }: { color?: string; size?: number }) {
  return <span className="pdot" style={{ background: color ?? '#888', width: size, height: size }} />
}

export function Avatar({ url, name, color }: { url?: string; name: string; color?: string }) {
  const [broken, setBroken] = useState(false)
  if (url && !broken) return <img className="avatar" src={url} alt="" onError={() => setBroken(true)} />
  return (
    <div className="avatar" style={{ background: color ?? 'var(--raised)' }}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  )
}

const STATUS: Record<string, [string, string]> = {
  draft: ['', 'Draft'],
  queued: ['info', 'Queued'],
  publishing: ['accent', 'Publishing'],
  scheduled: ['info', 'Scheduled'],
  published: ['ok', 'Published'],
  partial: ['warn', 'Partly done'],
  unconfirmed: ['warn', 'Unconfirmed'],
  handoff: ['warn', 'Waiting for you'],
  failed: ['err', 'Failed'],
  canceled: ['', 'Canceled'],
  connected: ['ok', 'Connected'],
  needs_login: ['warn', 'Needs login'],
  error: ['err', 'Error']
}
export function Status({ s }: { s: TargetStatus | string }) {
  const [cls, label] = STATUS[s] ?? ['', s]
  return <span className={`pill ${cls}`}>{label}</span>
}

export function TagsInput({ value, onChange, placeholder, className }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; className?: string }) {
  const [draft, setDraft] = useState('')
  const add = (raw: string) => {
    const parts = raw
      .split(/[,，\n]/)
      .map((t) => t.trim().replace(/^#/, ''))
      .filter(Boolean)
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))])
    setDraft('')
  }
  return (
    <div className={`tags-input ${className ?? ''}`}>
      {value.map((t) => (
        <span className="tag" key={t}>
          #{t}
          <button onClick={() => onChange(value.filter((x) => x !== t))} title="Remove">
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        placeholder={value.length ? '' : (placeholder ?? 'Add tags, press Enter')}
        onChange={(e) => (/[,，]/.test(e.target.value) ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(draft)
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
        }}
        onBlur={() => draft && add(draft)}
      />
    </div>
  )
}

export function MediaTile({ path, info, onRemove, onEdit }: { path: string; info?: string; onRemove?: () => void; onEdit?: () => void }) {
  return (
    <div className="media" title={path}>
      {isVideoPath(path) ? <video src={mediaUrl(path)} muted preload="metadata" /> : <img src={mediaUrl(path)} alt="" />}
      <div className="meta">
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName(path)}</div>
        {info && <div style={{ opacity: 0.8 }}>{info}</div>}
      </div>
      {onRemove && (
        <button className="x" onClick={onRemove} title="Remove">
          ×
        </button>
      )}
      {onEdit && (
        <button className="x" style={{ right: 32 }} onClick={onEdit} title="Edit in Studio">
          ✂
        </button>
      )}
    </div>
  )
}

/** Render a FieldSpec (settings, connect form, post options). */
export function Field({ spec, value, onChange, secretSet }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void; secretSet?: boolean }) {
  const v = value ?? spec.default
  if (spec.type === 'boolean') {
    return (
      <div>
        <label className="check">
          <input type="checkbox" checked={Boolean(v)} onChange={(e) => onChange(e.target.checked)} />
          <span>{spec.label}</span>
        </label>
        {spec.help && <div className="help" style={{ marginLeft: 24 }}>{spec.help}</div>}
      </div>
    )
  }
  let input: ReactNode
  if (spec.type === 'select') {
    input = (
      <select value={v === undefined ? '' : String(v)} onChange={(e) => onChange(e.target.value)}>
        {(v === undefined || v === '') && <option value="">Choose…</option>}
        {spec.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  } else if (spec.type === 'textarea') {
    input = <textarea value={String(v ?? '')} placeholder={spec.placeholder} onChange={(e) => onChange(e.target.value)} />
  } else {
    input = (
      <input
        type={spec.type === 'secret' ? 'password' : spec.type === 'number' ? 'number' : spec.type === 'datetime' ? 'datetime-local' : 'text'}
        value={spec.type === 'secret' ? String(value ?? '') : String(v ?? '')}
        placeholder={spec.type === 'secret' && secretSet ? '•••••••• saved — type to replace' : spec.placeholder}
        onChange={(e) => onChange(spec.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
      />
    )
  }
  return (
    <label className="field">
      <span className="lab">
        <span>
          {spec.label}
          {spec.required && ' *'}
        </span>
      </span>
      {input}
      {spec.help && <span className="help">{spec.help}</span>}
    </label>
  )
}

export function Counter({ n, max }: { n: number; max?: number }) {
  if (!max) return <span className="counter faint small">{n}</span>
  return (
    <span className={`counter ${n > max ? 'over' : 'ok'}`}>
      {n}/{max}
    </span>
  )
}

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose?: () => void; wide?: boolean }) {
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? ' wide' : ''}`}>{children}</div>
    </div>
  )
}

export const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function timeAgo(iso?: string, now = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' })
}
