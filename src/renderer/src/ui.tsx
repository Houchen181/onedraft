// Small shared UI pieces.

import { createContext, useContext, useState, type ReactNode } from 'react'
import type { Account, FieldSpec, PlatformManifest, TargetStatus } from '@shared/types'
import { call, fileName, isVideoPath, mediaUrl } from './api'

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

/** Connect (or replace) the one account for a platform. */
export function ConnectDialog({ platform: p, onClose }: { platform: PlatformManifest; onClose: () => void }) {
  const app = useApp()
  const existing = app.accountFor(p.id)
  const [input, setInput] = useState<Record<string, unknown>>(
    Object.fromEntries(p.connectFields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]))
  )
  const [busy, setBusy] = useState(false)
  const how: Record<string, string> = {
    api: 'Your browser opens the platform’s sign-in page. Approve access, then come back here.',
    browser: 'A browser window opens on the platform. Log in there (scan the QR code with the phone app); OneDraft keeps that login in its own profile.',
    cli: 'A console window opens. Choose the QR-code login and scan it with the phone app.',
    mcp: 'OneDraft checks that the MCP server is reachable and logged in.',
    plugin: 'The plugin handles login.'
  }
  const connect = async () => {
    setBusy(true)
    try {
      const values = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v ?? '')]))
      const a = await call<Account>('accounts.connect', p.id, values)
      app.toast(`${p.name} connected as ${a.name}.`)
      onClose()
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal onClose={busy ? undefined : onClose}>
      <div className="row" style={{ marginBottom: 6 }}>
        <PlatformIcon p={p} size={34} />
        <h2 style={{ margin: 0 }}>{existing ? `Replace your ${p.name} account` : `Connect ${p.name}`}</h2>
      </div>
      {existing && <div className="note" style={{ marginBottom: 10 }}>OneDraft keeps one account per platform. Signing in again replaces {existing.name}; drafts and scheduled posts move to the new account.</div>}
      <p className="muted">{how[p.kind]}</p>
      <div className="stack">
        {p.connectFields.map((f) => (
          <Field key={f.key} spec={f} value={input[f.key]} onChange={(v) => setInput((s) => ({ ...s, [f.key]: v }))} />
        ))}
        {p.notes.length > 0 && (
          <div className="note">
            {p.notes.map((n) => (
              <div key={n}>• {n}</div>
            ))}
          </div>
        )}
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
            <button className="btn ghost" onClick={onClose}>
              Close
            </button>
            <button className="btn primary" onClick={connect}>
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

export function Modal({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal">{children}</div>
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
