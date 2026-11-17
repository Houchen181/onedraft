import { useEffect, useState } from 'react'
import type { FieldSpec, LogEvent, PlatformManifest, SettingsView, SpeechStatus, UpdateStatus } from '@shared/types'
import { call, useData } from '../api'
import { Avatar, ConnectDialog, Field, PlatformIcon, Status, timeAgo, useApp } from '../ui'

/** The running version and its updates (from GitHub Releases). */
function UpdateRow() {
  const app = useApp()
  const { data: u } = useData<UpdateStatus>('update.status', [], ['update'])
  if (!u) return null
  const pct = Math.round((u.progress ?? 0) * 100)
  const text =
    u.state === 'dev'
      ? 'A development run: updates come with the installed app.'
      : u.state === 'checking'
        ? 'Checking for updates…'
        : u.state === 'downloading'
          ? `Downloading OneDraft ${u.version}… ${pct}%`
          : u.state === 'ready'
            ? `OneDraft ${u.version} is ready. Restart to update, or it updates the next time you quit.`
            : u.state === 'none'
              ? `Up to date${u.checkedAt ? ` (checked ${timeAgo(u.checkedAt)})` : ''}.`
              : u.state === 'error'
                ? `Couldn’t check for updates: ${u.error}`
                : 'Looks for updates in the background.'
  const install = () => call('update.install').catch((e: Error) => app.toast(e.message, true))
  return (
    <div className="row wrap" style={{ marginBottom: 12 }}>
      <b>OneDraft {u.current}</b>
      <span className="small muted grow">{text}</span>
      {u.state === 'ready' ? (
        <button className="btn primary sm" onClick={() => void install()}>
          Restart to update
        </button>
      ) : (
        u.state !== 'dev' && (
          <button className="btn sm" disabled={u.state === 'checking' || u.state === 'downloading'} onClick={() => void call('update.check')}>
            Check for updates
          </button>
        )
      )}
    </div>
  )
}

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
  {
    key: 'ai.claudePath',
    label: 'claude.exe path (optional)',
    type: 'path',
    help: 'Leave empty to find it on PATH, in %USERPROFILE%\\.local\\bin, or inside the Claude desktop app.'
  }
]

interface AiStatus {
  engine: 'claude-code' | 'api'
  engineSetting: string
  claude: { found: boolean; path?: string; desktopApp?: boolean; signedIn: boolean; method?: string; error?: string }
  apiKeySet: boolean
}

/** The official Claude Code installer for Windows (claude.com/claude-code). */
const INSTALL_CLAUDE = 'irm https://claude.ai/install.ps1 | iex'

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

function EngineStatus({ ai, waiting, onSignIn, onRecheck }: { ai: AiStatus; waiting: boolean; onSignIn: () => void; onRecheck: () => void }) {
  const app = useApp()
  const c = ai.claude
  const where = c.desktopApp ? ' (the copy that comes with the Claude desktop app)' : ''
  const install = (
    <div className="stack" style={{ gap: 6, marginTop: 6 }}>
      <span>
        Install Claude Code: open <b>PowerShell</b>, paste this and press Enter, then come back and press <i>Check again</i>.
      </span>
      <div className="row">
        <code className="mono grow" style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 9px' }}>
          {INSTALL_CLAUDE}
        </code>
        <button
          className="btn sm"
          onClick={() => {
            void navigator.clipboard.writeText(INSTALL_CLAUDE)
            app.toast('Copied.')
          }}
        >
          Copy
        </button>
        <button className="btn sm" onClick={onRecheck}>
          Check again
        </button>
      </div>
    </div>
  )
  const signIn = (
    <div className="row wrap" style={{ marginTop: 8 }}>
      <button className="btn primary sm" onClick={onSignIn} disabled={waiting}>
        Sign in to Claude Code
      </button>
      <button className="btn sm" onClick={onRecheck}>
        Check again
      </button>
      <span className="small muted">
        {waiting ? 'Finish signing in in the window and browser that opened; this turns Ready by itself.' : 'Opens Claude Code’s own sign-in in your browser. Use the account with your Pro or Max plan.'}
      </span>
    </div>
  )
  if (ai.engine === 'api')
    return (
      <div className="note">
        Using a Claude API key {ai.apiKeySet ? <span className="pill ok">key saved</span> : <span className="pill warn">no key yet</span>}. Each request is billed to
        your API account.
        {ai.engineSetting === 'auto' && !ai.apiKeySet && (
          <div style={{ marginTop: 6 }}>
            Have a Claude Pro or Max plan? OneDraft can use it instead, through Claude Code{c.found ? ':' : '.'}
            {c.found ? signIn : install}
          </div>
        )}
      </div>
    )
  return (
    <div className="note">
      {!c.found ? (
        <>
          <span className="pill warn">Claude Code not found</span> OneDraft runs the assistant on your Claude plan through Claude Code, which isn’t on this computer.
          {install}
        </>
      ) : c.signedIn ? (
        <>
          <span className="pill ok">Ready</span> Using your Claude plan through Claude Code{where} ({c.method === 'claude.ai' ? 'signed in with claude.ai' : c.method}).
          Uses your plan’s usage limits; no API key needed.
        </>
      ) : (
        <>
          <span className="pill warn">Not signed in</span> Found Claude Code{where}, but it isn’t signed in yet. The Claude desktop app’s own sign-in doesn’t carry
          over, so sign in once here.
          {signIn}
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
  const [waitingSignIn, setWaitingSignIn] = useState(false)
  const recheck = () => call<AiStatus>('ai.status').then((s) => (setAi(s), s))
  useEffect(() => {
    void call<McpInfo>('mcp.info').then(setMcp)
    void recheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])
  // After "Sign in", look every few seconds until Claude Code says it's signed in (up to 5 minutes).
  useEffect(() => {
    if (!waitingSignIn) return
    const started = Date.now()
    const t = setInterval(() => {
      void recheck().then((s) => {
        if (s.claude.signedIn || Date.now() - started > 5 * 60_000) {
          setWaitingSignIn(false)
          if (s.claude.signedIn) app.toast('Claude Code is signed in. The assistant now runs on your Claude plan.')
        }
      })
    }, 3000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingSignIn])
  const signIn = async () => {
    try {
      await call('ai.signIn')
      setWaitingSignIn(true)
    } catch (e) {
      app.toast((e as Error).message, true)
    }
  }

  const value = (k: string) => (k in edits ? edits[k] : settings?.values[k])
  const set = (k: string, v: unknown) => setEdits((s) => ({ ...s, [k]: v }))
  const isSecret = (k: string, spec?: FieldSpec) => spec?.type === 'secret'

  const [connectP, setConnectP] = useState<PlatformManifest>()
  const [setupOpen, setSetupOpen] = useState<string>()
  const [busyAcct, setBusyAcct] = useState<string>()
  const { data: events } = useData<LogEvent[]>('events.list', [150], ['events'])
  /** Required setup values (developer keys) still missing. A default counts as set. */
  const missing = (p: PlatformManifest) =>
    p.settings.filter((s) => s.required && s.default === undefined && !(value(`${p.id}.${s.key}`) || settings?.secretsSet.includes(`${p.id}.${s.key}`)))
  /** Settings the setup walkthrough doesn't cover (preferences, advanced): shown under Options. */
  const extraSettings = (p: PlatformManifest) => {
    const inGuide = new Set(p.guide?.steps.flatMap((s) => s.fields ?? []) ?? [])
    return p.settings.filter((s) => !inGuide.has(s.key))
  }
  const names = (ps: PlatformManifest[]) => {
    const n = ps.map((p) => p.name)
    return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : (n[0] ?? '')
  }
  /** The walkthrough is done once its keys are saved (a token pasted at every Connect never is). */
  const setupDone = (p: PlatformManifest) =>
    !!p.guide && !missing(p).length && !p.guide.steps.some((s) => s.fields?.some((k) => p.connectFields.some((f) => f.key === k)))
  const signInOnly = app.platforms.filter((p) => !p.guide || p.web)
  const withSetup = app.platforms.filter((p) => p.guide && !p.web)
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
          Press <b>Connect</b> next to each platform you post to.
          {signInOnly.length > 0 && ` ${names(signInOnly)} ${signInOnly.length > 1 ? 'only need' : 'only needs'} you to sign in.`}
          {withSetup.length > 0 &&
            ` ${names(withSetup)} ${withSetup.length > 1 ? 'need' : 'needs'} a one-time setup on the platform’s developer site first: Connect walks you through it step by step.`}{' '}
          One account per platform.
        </p>
        <div style={{ maxWidth: 360, marginBottom: 6 }}>
          <Field spec={PROFILE_FIELD} value={value('profile.name')} onChange={(v) => set('profile.name', v)} />
        </div>
        {app.platforms.map((p) => {
          const a = app.accountFor(p.id)
          const extra = extraSettings(p)
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
                  <div className="acct">
                    Not connected
                    <span className="effort">
                      {' · '}
                      {!p.guide || p.web ? 'just sign in' : setupDone(p) ? 'setup done, ready to connect' : `one-time setup first (${p.guide.time})`}
                    </span>
                  </div>
                )}
              </div>
              <div className="row">
                {extra.length > 0 && (
                  <button className="btn ghost sm" onClick={() => setSetupOpen(open ? undefined : p.id)}>
                    {open ? 'Hide options' : 'Options'}
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
                  <button className="btn primary sm" onClick={() => setConnectP(p)}>
                    Connect
                  </button>
                )}
              </div>
              {open && (
                <div className="setup">
                  {fields(extra.map((s) => ({ ...s, key: `${p.id}.${s.key}` })))}
                  <div className="help" style={{ marginTop: 8 }}>
                    Press Save (top right) to keep changes.
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
          {ai && <EngineStatus ai={ai} waiting={waitingSignIn} onSignIn={() => void signIn()} onRecheck={() => void recheck()} />}
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
        <UpdateRow />
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
      {connectP && <ConnectDialog platform={connectP} onClose={() => setConnectP(undefined)} onSaved={reload} />}
    </div>
  )
}
