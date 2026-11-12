import { useEffect, useState } from 'react'
import type { FieldSpec, SettingsView } from '@shared/types'
import { call, useData } from '../api'
import { Field, PlatformDot, useApp } from '../ui'

interface McpInfo {
  enabled: boolean
  running: boolean
  url: string
  token: string
  claudeCode: string
}

const AI_FIELDS: FieldSpec[] = [
  { key: 'ai.apiKey', label: 'Claude API key', type: 'secret', help: 'From platform.claude.com → API keys. Stored encrypted on this computer.' },
  {
    key: 'ai.model',
    label: 'Model',
    type: 'select',
    default: 'claude-opus-5-5',
    options: [
      { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 (default)' },
      { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)' },
      { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' },
      { value: 'claude-fable-5-2', label: 'Claude Fable 5.2 (most capable)' }
    ]
  },
  {
    key: 'ai.effort',
    label: 'Effort',
    type: 'select',
    default: 'medium',
    options: ['low', 'medium', 'high', 'xhigh'].map((v) => ({ value: v, label: v }))
  },
  {
    key: 'ai.autoApprove',
    label: 'Let AI publish without asking me',
    type: 'boolean',
    default: false,
    help: 'Off: every publish or reply from the assistant or an MCP client waits for your click. Rednote and others penalise fully automated accounts.'
  }
]

const HOST_FIELDS: FieldSpec[] = [
  { key: 'mediaHost.endpoint', label: 'S3 endpoint', type: 'text', placeholder: 'https://<account>.r2.cloudflarestorage.com' },
  { key: 'mediaHost.bucket', label: 'Bucket', type: 'text' },
  { key: 'mediaHost.region', label: 'Region', type: 'text', placeholder: 'auto' },
  { key: 'mediaHost.accessKeyId', label: 'Access key id', type: 'text' },
  { key: 'mediaHost.secretAccessKey', label: 'Secret access key', type: 'secret' },
  { key: 'mediaHost.publicBaseUrl', label: 'Public URL of the bucket', type: 'text', placeholder: 'https://pub-xxxx.r2.dev' }
]

const APP_FIELDS: FieldSpec[] = [
  { key: 'app.runInBackground', label: 'Keep running in the tray when the window closes (so scheduled posts go out)', type: 'boolean', default: true },
  { key: 'app.ffmpegPath', label: 'ffmpeg path (optional)', type: 'path', help: 'Leave empty to use the bundled ffmpeg.' }
]

export function Settings() {
  const app = useApp()
  const { data: settings, reload } = useData<SettingsView>('settings.get', [])
  const [edits, setEdits] = useState<Record<string, unknown>>({})
  const [mcp, setMcp] = useState<McpInfo>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void call<McpInfo>('mcp.info').then(setMcp)
  }, [settings])

  const value = (k: string) => (k in edits ? edits[k] : settings?.values[k])
  const set = (k: string, v: unknown) => setEdits((s) => ({ ...s, [k]: v }))
  const isSecret = (k: string, spec?: FieldSpec) => spec?.type === 'secret'

  const allSpecs: FieldSpec[] = [
    ...AI_FIELDS,
    ...HOST_FIELDS,
    ...APP_FIELDS,
    { key: 'mcp.enabled', label: '', type: 'boolean' },
    { key: 'mcp.port', label: '', type: 'number' },
    { key: 'mcpBridges', label: '', type: 'textarea' },
    ...app.platforms.flatMap((p) => p.settings.map((s) => ({ ...s, key: `${p.id}.${s.key}` })))
  ]

  const save = async () => {
    setSaving(true)
    try {
      const entries = Object.entries(edits)
        .filter(([k, v]) => !(isSecret(k, allSpecs.find((s) => s.key === k)) && (v === '' || v === undefined)))
        .map(([key, v]) => ({ key, value: v, secret: isSecret(key, allSpecs.find((s) => s.key === key)) }))
      if (entries.some((e) => e.key === 'mcpBridges' && String(e.value ?? '').trim())) JSON.parse(String(entries.find((e) => e.key === 'mcpBridges')!.value))
      await call('settings.set', entries)
      setEdits({})
      reload()
      app.toast('Saved.')
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setSaving(false)
    }
  }

  const fields = (specs: FieldSpec[]) => (
    <div className="split">
      {specs.map((s) => (
        <div key={s.key} style={s.type === 'textarea' || s.type === 'boolean' ? { gridColumn: '1 / -1' } : undefined}>
          <Field spec={s} value={value(s.key)} onChange={(v) => set(s.key, v)} secretSet={settings?.secretsSet.includes(s.key)} />
          {s.type === 'secret' && settings?.secretsSet.includes(s.key) && (
            <button className="btn ghost sm" onClick={() => call('settings.set', [{ key: s.key, value: null }]).then(reload)}>
              Clear saved value
            </button>
          )}
        </div>
      ))}
    </div>
  )

  const copy = (t: string) => {
    void navigator.clipboard.writeText(t)
    app.toast('Copied.')
  }

  return (
    <div className="page">
      <div className="row" style={{ position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 2, padding: '6px 0 12px' }}>
        <div className="grow">
          <h1>Settings</h1>
        </div>
        {Object.keys(edits).length > 0 && <span className="muted small">Unsaved changes</span>}
        <button className="btn primary" disabled={!Object.keys(edits).length || saving} onClick={save}>
          Save
        </button>
      </div>

      <div className="card">
        <h2>AI assistant</h2>
        {fields(AI_FIELDS)}
      </div>

      <div className="card">
        <h2>Use Polycast from Claude Code or other AI apps (MCP)</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Starts a local MCP server so any MCP client can draft, check and schedule posts with the same tools as the built-in assistant. Publishing still waits for your OK here.
        </p>
        <div className="split">
          <Field spec={{ key: 'mcp.enabled', label: 'Run the MCP server', type: 'boolean', default: false }} value={value('mcp.enabled')} onChange={(v) => set('mcp.enabled', v)} />
          <Field spec={{ key: 'mcp.port', label: 'Port', type: 'number', default: 7341 }} value={value('mcp.port')} onChange={(v) => set('mcp.port', v)} />
        </div>
        {mcp && (
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="small">
              Status: {mcp.running ? <span className="pill ok">running at {mcp.url}</span> : <span className="pill">off</span>}
            </div>
            <div className="small muted">Add to Claude Code:</div>
            <div className="row">
              <code className="mono grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'var(--bg)', padding: '7px 9px', borderRadius: 8 }}>
                {mcp.claudeCode.replace(mcp.token, '••••••')}
              </code>
              <button className="btn sm" onClick={() => copy(mcp.claudeCode)}>
                Copy
              </button>
              <button className="btn ghost sm" onClick={() => call<McpInfo>('mcp.newToken').then(setMcp)}>
                New token
              </button>
            </div>
          </div>
        )}
      </div>

      {app.platforms
        .filter((p) => p.settings.length)
        .map((p) => (
          <div className="card" key={p.id}>
            <h2 className="row">
              <PlatformDot color={p.color} size={12} /> {p.name}
              {p.docsUrl && (
                <a href="#" className="small" style={{ fontWeight: 400 }} onClick={() => call('shell.open', p.docsUrl)}>
                  docs ↗
                </a>
              )}
            </h2>
            {fields(p.settings.map((s) => ({ ...s, key: `${p.id}.${s.key}` })))}
          </div>
        ))}

      <div className="card">
        <h2>Public media host (for Instagram images)</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Instagram downloads images from a public link instead of accepting an upload. Point Polycast at any S3-compatible bucket with public read (Cloudflare R2’s free tier works). Files are deleted right after posting.
        </p>
        {fields(HOST_FIELDS)}
      </div>

      <div className="card">
        <h2>Connectors</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Add any platform: drop a connector plugin into the plugins folder, or bridge an MCP server that can post (e.g. xiaohongshu-mcp). See docs/writing-a-connector.md.
        </p>
        <Field
          spec={{
            key: 'mcpBridges',
            label: 'MCP bridges (JSON array)',
            type: 'textarea',
            placeholder: '[{ "id": "xhs-mcp", "name": "Rednote via xiaohongshu-mcp", "url": "http://localhost:18060/mcp", "video": true, "image": true, "tools": { … } }]'
          }}
          value={value('mcpBridges')}
          onChange={(v) => set('mcpBridges', v)}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn sm"
            onClick={async () => {
              const r = await call<{ loaded: string[]; errors: string[] }>('connectors.reload')
              app.toast(r.errors.length ? r.errors.join('\n') : `Loaded: ${r.loaded.join(', ') || 'no extra connectors'}`, r.errors.length > 0)
            }}
          >
            Reload connectors
          </button>
          <button
            className="btn ghost sm"
            onClick={async () => {
              const info = await call<{ paths: { plugins: string } }>('app.info')
              void call('shell.openPath', info.paths.plugins)
            }}
          >
            Open plugins folder
          </button>
        </div>
      </div>

      <div className="card">
        <h2>App</h2>
        {fields(APP_FIELDS)}
      </div>
    </div>
  )
}
