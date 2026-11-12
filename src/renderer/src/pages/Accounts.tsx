import { useState } from 'react'
import type { Account, PlatformManifest, SettingsView } from '@shared/types'
import { call, useData } from '../api'
import { Avatar, Field, Modal, PlatformDot, Status, useApp } from '../ui'

const KIND: Record<string, string> = { api: 'Official API', browser: 'Browser', cli: 'biliup CLI', mcp: 'MCP bridge', plugin: 'Plugin' }

export function Accounts() {
  const app = useApp()
  const { data: accounts } = useData<Account[]>('accounts.list', [], ['accounts'])
  const { data: settings } = useData<SettingsView>('settings.get', [])
  const [connecting, setConnecting] = useState<PlatformManifest>()
  const [busy, setBusy] = useState<string>()

  const missingSettings = (p: PlatformManifest) =>
    p.settings.filter((s) => s.required && !(settings?.values[`${p.id}.${s.key}`] || settings?.secretsSet.includes(`${p.id}.${s.key}`)))

  const run = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(id)
    try {
      await fn()
      if (ok) app.toast(ok)
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="page">
      <h1>Accounts</h1>
      <p className="sub">Your logins are encrypted on this computer with Windows’ own protection.</p>

      <div className="card">
        <h2>Connected</h2>
        {!accounts?.length && <div className="muted">No accounts yet — pick a platform below.</div>}
        <div className="list">
          {accounts?.map((a) => {
            const p = app.platform(a.platform)
            return (
              <div className="item" key={a.id}>
                <Avatar url={a.avatarUrl} name={a.name} color={p?.color} />
                <div className="grow">
                  <div className="row">
                    <b>{a.name}</b>
                    {a.handle && <span className="muted small">{a.handle}</span>}
                  </div>
                  <div className="small faint row">
                    <PlatformDot color={p?.color} size={8} /> {p?.name ?? `${a.platform} (connector missing)`}
                    {a.statusNote && <span className="muted"> · {a.statusNote.slice(0, 140)}</span>}
                  </div>
                </div>
                <Status s={a.status} />
                <button className="btn sm" disabled={busy === a.id} onClick={() => run(a.id, () => call('accounts.check', a.id))}>
                  {busy === a.id ? 'Checking…' : 'Check'}
                </button>
                <button className="btn sm" disabled={busy === a.id} onClick={() => run(a.id, () => call('accounts.reconnect', a.id), 'Reconnected.')}>
                  Reconnect
                </button>
                <button
                  className="btn ghost sm danger"
                  onClick={() => {
                    if (confirm(`Remove ${a.name} from Polycast? This signs Polycast out; your account itself is untouched.`)) void run(a.id, () => call('accounts.remove', a.id))
                  }}
                >
                  Remove
                </button>
              </div>
            )
          })}
        </div>
      </div>

      <div className="card">
        <h2>Add an account</h2>
        <div className="platform-grid">
          {app.platforms.map((p) => {
            const missing = missingSettings(p)
            return (
              <div className="platform" key={p.id}>
                <div className="name">
                  <PlatformDot color={p.color} size={12} />
                  {p.name}
                  <span className="pill" style={{ marginLeft: 'auto' }}>
                    {KIND[p.kind] ?? p.kind}
                  </span>
                </div>
                <div className="small faint">
                  {[p.capabilities.video && 'video', p.capabilities.image && 'images', p.capabilities.text && 'text'].filter(Boolean).join(' · ')}
                  {p.capabilities.nativeSchedule && ' · platform scheduling'}
                </div>
                {missing.length > 0 ? (
                  <button className="btn sm" onClick={() => app.go('settings')}>
                    Set up {p.name} in Settings first
                  </button>
                ) : (
                  <button className="btn primary sm" onClick={() => setConnecting(p)}>
                    Connect
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <p className="help" style={{ marginTop: 12 }}>
          Any other platform can be added as a connector plugin or through an MCP server (Settings → Connectors).
        </p>
      </div>

      {connecting && <ConnectDialog platform={connecting} onClose={() => setConnecting(undefined)} />}
    </div>
  )
}

function ConnectDialog({ platform: p, onClose }: { platform: PlatformManifest; onClose: () => void }) {
  const app = useApp()
  const [input, setInput] = useState<Record<string, unknown>>(Object.fromEntries(p.connectFields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])))
  const [busy, setBusy] = useState(false)
  const connect = async () => {
    setBusy(true)
    try {
      const values = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v ?? '')]))
      const a = await call<Account>('accounts.connect', p.id, values)
      app.toast(`Connected ${a.name}.`)
      onClose()
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(false)
    }
  }
  const how: Record<string, string> = {
    api: 'Your browser opens the platform’s sign-in page. Approve access, then come back here.',
    browser: 'A browser window opens on the platform. Log in there (scan the QR code with the phone app); Polycast keeps that login in its own profile.',
    cli: 'A console window opens. Choose QR login and scan it with the phone app.',
    mcp: 'Polycast checks that the MCP server is reachable and logged in.',
    plugin: 'The plugin handles login.'
  }
  return (
    <Modal onClose={busy ? undefined : onClose}>
      <h2>
        <PlatformDot color={p.color} size={12} /> Connect {p.name}
      </h2>
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
            <button
              className="btn"
              onClick={() => {
                void call('accounts.cancelConnect', p.id)
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose}>
              Close
            </button>
            <button className="btn primary" onClick={connect}>
              Connect
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
