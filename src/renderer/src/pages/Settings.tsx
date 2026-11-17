import { useEffect, useState } from 'react'
import type { FieldSpec, LogEvent, PlatformManifest, SettingsView, SpeechStatus } from '@shared/types'
import { call, useData } from '../api'
import { Avatar, ConnectDialog, Field, PlatformIcon, Status, useApp } from '../ui'

/** Local speech-to-text (Whisper): what's installed, or a one-time setup with its exact downloads. */
function SpeechCard() {
  const app = useApp()
  const { data: st, reload } = useData<SpeechStatus>('speech.status', [], ['speech'])
  const [busy, setBusy] = useState(false)
  const install = async () => {
    setBusy(true)
    try {
      await call('speech.install')
      app.toast('Speech-to-text is ready.')
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusy(false)
      reload()
    }
  }
  const mb = st?.downloads.reduce((s, d) => s + d.mb, 0) ?? 0
  return (
    <div className="card" id="s-speech">
      <h2>Speech-to-text</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Lets Studio and Claude edit videos by what is said (cut filler words, retakes and pauses) and burn in word-by-word captions. It runs Whisper
        (whisper.cpp, large-v3-turbo) on this computer; your audio is never uploaded.
      </p>
      {st?.installed ? (
        <div className="row">
          <Status s="connected" />
          <span className="small muted">
            {st.gpu ? 'On your NVIDIA graphics card' : 'On the processor'} · {st.model}
          </span>
        </div>
      ) : st?.installing ? (
        <div>
          <div className="progress">
            <div style={{ width: `${Math.round(st.installing.fraction * 100)}%` }} />
          </div>
          <div className="small faint" style={{ marginTop: 4 }}>
            {st.installing.note} · {Math.round(st.installing.fraction * 100)}%
          </div>
        </div>
      ) : (
        <div className="row wrap">
          <button className="btn primary" disabled={busy || !st} onClick={() => void install()}>
            Set up ({mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`} download)
          </button>
          <span className="small faint">{st?.downloads.map((d) => `${d.name} (${d.mb} MB)`).join(' + ')}, checked against their published checksums.</span>
        </div>
      )}
      {st?.error && !st.installing && (
        <div className="issue error" style={{ marginTop: 8 }}>
          {st.error}
        </div>
      )}
    </div>
  )
}

const PROFILE_FIELD: FieldSpec = { key: 'profile.name', label: 'Your name', type: 'text', placeholder: 'Shown at the top of the sidebar' }

interface McpInfo {
  enabled: boolean
  running: boolean
  url: string
  token: string
  claudeCode: string
}

const ENGINE_FIELD: FieldSpec = {
  key: 'ai.engine',
  label: 'Run the assistant on',
  type: 'select',
  default: 'auto',
  options: [
    { value: 'auto', label: 'Automatic (my Claude plan if Claude Code is installed)' },
    { value: 'claude-code', label: 'My Claude plan, through Claude Code on this computer' },
    { value: 'api', label: 'A Claude API key (billed per use)' }
  ]
}

const CC_FIELDS: FieldSpec[] = [
  {
    key: 'ai.ccModel',
    label: 'Model',
    type: 'select',
    default: '',
    options: [
      { value: '', label: 'Claude Code’s default for my plan' },
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet (uses less of the plan)' },
      { value: 'haiku', label: 'Haiku' }
    ]
  },
  { key: 'ai.claudePath', label: 'claude.exe path (optional)', type: 'path', help: 'Leave empty to find it on PATH or in %USERPROFILE%\\.local\\bin.' }
]

interface AiStatus {
  engine: 'claude-code' | 'api'
  claude: { found: boolean; path?: string; signedIn: boolean; method?: string; error?: string }
  apiKeySet: boolean
}

const API_FIELDS: FieldSpec[] = [
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
  }
]

const AI_FIELDS: FieldSpec[] = [
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
  {
    key: 'app.openAtLogin',
    label: 'Start OneDraft in the tray when you sign in to Windows (so scheduled posts go out after a restart)',
    type: 'boolean',
    default: false,
    help: 'For the installed app (npm run dist); a development run can’t start with Windows.'
  },
  { key: 'app.ffmpegPath', label: 'ffmpeg path (optional)', type: 'path', help: 'Leave empty to use the bundled ffmpeg.' }
]

function EngineStatus({ ai }: { ai: AiStatus }) {
  const c = ai.claude
  if (ai.engine === 'api')
    return (
      <div className="note">
        Using a Claude API key {ai.apiKeySet ? <span className="pill ok">key saved</span> : <span className="pill warn">no key yet</span>}. Each request is billed to
        your API account.
      </div>
    )
  return (
    <div className="note">
      {!c.found ? (
        <>
          <span className="pill warn">Claude Code not found</span> Install Claude Code (claude.com/claude-code), run <code className="mono">claude</code> once and
          sign in with your Claude plan.
        </>
      ) : c.signedIn ? (
        <>
          <span className="pill ok">Ready</span> Using your Claude plan through Claude Code ({c.method === 'claude.ai' ? 'signed in with claude.ai' : c.method}). Uses
          your plan’s usage limits; no API key needed.
        </>
      ) : (
        <>
          <span className="pill warn">Not signed in</span> Run <code className="mono">claude</code> in a terminal and sign in with your Claude plan.
        </>
      )}
      <div className="help" style={{ marginTop: 6 }}>
        OneDraft starts your own Claude Code with only OneDraft’s tools and never sees your Claude login. For your own use: Anthropic doesn’t allow apps to offer
        Claude plan sign-in to other people.
      </div>
    </div>
  )
}

export function Settings() {
  const app = useApp()
  const { data: settings, reload } = useData<SettingsView>('settings.get', [])
  const [edits, setEdits] = useState<Record<string, unknown>>({})
  const [mcp, setMcp] = useState<McpInfo>()
  const [saving, setSaving] = useState(false)

  const [ai, setAi] = useState<AiStatus>()
  useEffect(() => {
    void call<McpInfo>('mcp.info').then(setMcp)
    void call<AiStatus>('ai.status').then(setAi)
  }, [settings])

  const value = (k: string) => (k in edits ? edits[k] : settings?.values[k])
  const set = (k: string, v: unknown) => setEdits((s) => ({ ...s, [k]: v }))
  const isSecret = (k: string, spec?: FieldSpec) => spec?.type === 'secret'

  const [connectP, setConnectP] = useState<PlatformManifest>()
  const [setupOpen, setSetupOpen] = useState<string>()
  const [busyAcct, setBusyAcct] = useState<string>()
  const { data: events } = useData<LogEvent[]>('events.list', [150], ['events'])
  const missing = (p: PlatformManifest) =>
    p.settings.filter((s) => s.required && !(value(`${p.id}.${s.key}`) || settings?.secretsSet.includes(`${p.id}.${s.key}`)))
  const acctAction = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusyAcct(id)
    try {
      await fn()
      if (ok) app.toast(ok)
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setBusyAcct(undefined)
    }
  }

  const allSpecs: FieldSpec[] = [
    PROFILE_FIELD,
    ENGINE_FIELD,
    ...CC_FIELDS,
    ...API_FIELDS,
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

      <div className="snav">
        {[
          ['platforms', 'Platforms'],
          ['assistant', 'Assistant'],
          ['speech', 'Speech-to-text'],
          ['mcp', 'Use from Claude Code'],
          ['media', 'Media host'],
          ['connectors', 'Add a platform'],
          ['app', 'App'],
          ['activity', 'Activity']
        ].map(([id, label]) => (
          <a key={id} href={`#s-${id}`}>
            {label}
          </a>
        ))}
      </div>

      <div className="card" id="s-platforms">
        <h2>Platforms</h2>
        <p className="muted small" style={{ marginTop: -6 }}>
          One account per platform. Signing in with a different account replaces the old one.
        </p>
        <div style={{ maxWidth: 360, marginBottom: 6 }}>
          <Field spec={PROFILE_FIELD} value={value('profile.name')} onChange={(v) => set('profile.name', v)} />
        </div>
        {app.platforms.map((p) => {
          const a = app.accountFor(p.id)
          const miss = missing(p)
          const open = setupOpen === p.id
          return (
            <div className="prow" key={p.id}>
              <PlatformIcon p={p} size={34} />
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <b>{p.name}</b>
                  {a && <Status s={a.status} />}
                </div>
                {a ? (
                  <div className="acct">
                    <Avatar url={a.avatarUrl} name={a.name} color={p.color} />
                    {a.name}
                    {a.handle && <span className="faint">{a.handle}</span>}
                    {a.statusNote && <span className="faint"> · {a.statusNote.slice(0, 120)}</span>}
                  </div>
                ) : (
                  <div className="acct">{miss.length ? 'Needs a one-time setup first' : 'Not connected'}</div>
                )}
              </div>
              <div className="row">
                {p.settings.length > 0 && (
                  <button className="btn ghost sm" onClick={() => setSetupOpen(open ? undefined : p.id)}>
                    {open ? 'Hide setup' : 'Setup'}
                  </button>
                )}
                {a ? (
                  <>
                    <button className="btn sm" disabled={busyAcct === a.id} onClick={() => acctAction(a.id, () => call('accounts.check', a.id))}>
                      {busyAcct === a.id ? 'Checking…' : 'Check'}
                    </button>
                    <button className="btn sm" onClick={() => setConnectP(p)}>
                      Switch account
                    </button>
                    <button
                      className="btn ghost sm danger"
                      onClick={() => {
                        if (confirm(`Disconnect ${p.name} (${a.name})? OneDraft signs out; your account itself is untouched.`))
                          void acctAction(a.id, () => call('accounts.remove', a.id), `${p.name} disconnected.`)
                      }}
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    className="btn primary sm"
                    onClick={() => (miss.length ? setSetupOpen(p.id) : setConnectP(p))}
                    title={miss.length ? `Fill in ${miss.map((s) => s.label).join(', ')} first` : ''}
                  >
                    Connect
                  </button>
                )}
              </div>
              {open && (
                <div className="setup">
                  {p.docsUrl && (
                    <a href="#" className="small" onClick={() => call('shell.open', p.docsUrl)}>
                      How to set up {p.name} ↗
                    </a>
                  )}
                  <div style={{ marginTop: 10 }}>{fields(p.settings.map((s) => ({ ...s, key: `${p.id}.${s.key}` })))}</div>
                  <div className="help" style={{ marginTop: 8 }}>
                    Press Save (top right), then Connect.
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="card" id="s-assistant">
        <h2>AI assistant</h2>
        <div className="stack">
          <Field spec={ENGINE_FIELD} value={value('ai.engine')} onChange={(v) => set('ai.engine', v)} />
          {ai && <EngineStatus ai={ai} />}
          {(() => {
            const chosen = String(value('ai.engine') ?? 'auto')
            const engine = chosen === 'auto' ? ai?.engine : chosen
            return engine === 'api' ? fields(API_FIELDS) : fields(CC_FIELDS)
          })()}
          {fields(AI_FIELDS)}
        </div>
      </div>

      <SpeechCard />

      <div className="card" id="s-mcp">
        <h2>Use OneDraft from Claude Code or other AI apps (MCP)</h2>
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

      <div className="card" id="s-media">
        <h2>Public media host (for Instagram images)</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Instagram downloads images from a public link instead of accepting an upload. Point OneDraft at any S3-compatible bucket with public read (Cloudflare R2’s free tier works). Files are deleted right after posting.
        </p>
        {fields(HOST_FIELDS)}
      </div>

      <div className="card" id="s-connectors">
        <h2>Add another platform</h2>
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

      <div className="card" id="s-app">
        <h2>App</h2>
        {fields(APP_FIELDS)}
      </div>

      <div className="card" id="s-activity">
        <h2>Activity</h2>
        <div className="log" style={{ maxHeight: 360, overflow: 'auto' }}>
          {!events?.length && <div className="muted">Nothing yet.</div>}
          {events?.map((e) => (
            <div key={e.id} className={`e-${e.level}`}>
              <span className="faint">{new Date(e.ts).toLocaleString()}</span> {e.message}
            </div>
          ))}
        </div>
      </div>
      {connectP && <ConnectDialog platform={connectP} onClose={() => setConnectP(undefined)} />}
    </div>
  )
}
