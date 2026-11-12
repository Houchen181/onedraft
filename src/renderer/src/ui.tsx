// Small shared UI pieces.

import { createContext, useContext, useState, type ReactNode } from 'react'
import type { FieldSpec, PlatformManifest, TargetStatus } from '@shared/types'
import { fileName, isVideoPath, mediaUrl } from './api'

export interface AppCtx {
  toast(text: string, error?: boolean): void
  go(page: Page, postId?: string): void
  ask(text: string): void
  platforms: PlatformManifest[]
  platform(id: string): PlatformManifest | undefined
}
export type Page = 'compose' | 'posts' | 'accounts' | 'activity' | 'settings'
export const Ctx = createContext<AppCtx>(null as unknown as AppCtx)
export const useApp = () => useContext(Ctx)

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

export function TagsInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
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
    <div className="tags-input">
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

export function MediaTile({ path, info, onRemove }: { path: string; info?: string; onRemove?: () => void }) {
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
    <span className={`counter small ${n > max ? 'over' : 'faint'}`}>
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
