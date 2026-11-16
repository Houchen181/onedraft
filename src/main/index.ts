// Electron main process: wires storage, connectors, the publish scheduler, the AI agent,
// approvals, the MCP server and the IPC bridge to the UI.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, safeStorage, shell, Tray } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { BUILTINS, loadBridges, loadPlugins } from '../connectors'
import { detectSilences, parseSrt, speechSegments } from '../core/edit'
import { Engine } from '../core/engine'
import { Inbox } from '../core/inbox'
import { coverFrame, fit, kindOf, probe, type FitMode } from '../core/media'
import { Registry } from '../core/registry'
import { plainCipher, Store, type Cipher } from '../core/store'
import { Studio } from '../core/studio'
import type { ToolEnv } from '../core/tools'
import type { ApprovalRequest, CompositionSpec, EditSpec, PostDraft } from '../shared/types'
import { Agent, type AgentEvent } from './agent'
import { BrowserManager } from './browser'
import { claudeStatus, ClaudeCodeAgent, findClaude } from './claude-code'
import { renderComposition } from './composer'
import { makeContextFactory, settingString, type Paths } from './context'
import { OneDraftMcpServer } from './mcp-server'
import { listVoices, speak } from './tts'

protocol.registerSchemesAsPrivileged([
  { scheme: 'onedraft-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } }
])

// A second launch hands over to the running one and does nothing else: it must not run start-up work such as
// recover(), which would mark the first instance's live uploads as interrupted.
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
app.setAppUserModelId('app.onedraft.desktop')

const unpacked = (p: string) => p.replace('app.asar', 'app.asar.unpacked')
const dataRoot = process.env.ONEDRAFT_DATA || app.getPath('userData')
const paths: Paths = {
  data: dataRoot,
  profiles: join(dataRoot, 'profiles'),
  tools: join(dataRoot, 'tools'),
  temp: join(dataRoot, 'temp'),
  media: join(dataRoot, 'media'),
  plugins: join(dataRoot, 'connectors')
}
for (const p of Object.values(paths)) mkdirSync(p, { recursive: true })

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

const send = (channel: string, payload: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

async function main() {
  await app.whenReady()

  const cipher: Cipher = safeStorage.isEncryptionAvailable()
    ? { encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(Buffer.from(b)) }
    : plainCipher
  const store = new Store(join(paths.data, 'onedraft.db'), cipher)
  if (cipher === plainCipher) store.log('warn', 'OS encryption is unavailable; secrets are stored unencrypted.')

  const registry = new Registry()
  for (const c of BUILTINS) registry.register(c)
  const reloadExtensions = () => {
    for (const m of registry.manifests()) if (m.source !== 'builtin') registry.unregister(m.id)
    const p = loadPlugins(registry, paths.plugins)
    const b = loadBridges(registry, settingString(store, 'mcpBridges'))
    for (const e of [...p.errors, ...b.errors]) store.log('error', `Connector load: ${e}`)
    return { loaded: [...p.loaded, ...b.loaded], errors: [...p.errors, ...b.errors] }
  }
  reloadExtensions()
  const applySettings = () => {
    for (const m of registry.manifests()) registry.get(m.id).applySettings?.((key) => settingString(store, `${m.id}.${key}`))
  }
  applySettings()

  const browsers = new BrowserManager(paths.profiles, () => settingString(store, 'rednote.browserChannel') ?? 'msedge')
  const makeContext = makeContextFactory({
    store,
    browsers,
    paths,
    onProgress: (scope, fraction, note) => send('progress', { scope, fraction, note })
  })
  const mediaTools = {
    ffmpeg: settingString(store, 'app.ffmpegPath') || unpacked(ffmpegStatic ?? 'ffmpeg'),
    ffprobe: settingString(store, 'app.ffprobePath') || unpacked(ffprobeStatic.path)
  }
  const engine = new Engine(store, registry, makeContext, mediaTools)
  engine.recover()

  // ---- inbox: comments and post numbers ----
  const inboxEvery = () => {
    const v = Number(store.getSetting('inbox.checkEveryMin') ?? 30)
    return Number.isFinite(v) && v >= 0 ? v : 30
  }
  const inbox = new Inbox(engine, { everyMin: inboxEvery, onChange: () => send('changed', 'inbox') })

  // ---- local media for previews and compositions ----
  const mediaHandler = (req: Request) => {
    const p = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''))
    if (!kindOf(p) && !/\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(p)) return new Response('not media', { status: 403 })
    return net.fetch(pathToFileURL(p).toString(), { headers: req.headers })
  }

  // ---- studio: video edits and Claude-generated videos ----
  const studio = new Studio(
    store,
    mediaTools,
    paths.media,
    {
      renderComposition: (c, out, work, narration, onProgress, signal) =>
        renderComposition(c, out, work, narration, { tools: mediaTools, mediaHandler }, onProgress, signal),
      speak,
      voices: listVoices
    },
    (id, fraction, note) => send('progress', { scope: `project:${id}`, fraction, note })
  )
  engine.isAiMedia = studio.isAiMedia

  // ---- approvals (the person confirms anything an AI wants to publish or send) ----
  const approvals = new Map<string, { req: ApprovalRequest; answer: (ok: boolean) => void }>()
  const requestApproval = (req: Omit<ApprovalRequest, 'id'>) =>
    new Promise<boolean>((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        approvals.delete(id)
        send('approval-closed', id)
        resolve(false)
      }, 30 * 60_000)
      approvals.set(id, {
        req: { id, ...req },
        answer: (ok) => {
          clearTimeout(timer)
          approvals.delete(id)
          send('approval-closed', id)
          resolve(ok)
        }
      })
      showWindow()
      send('approval', { id, ...req } satisfies ApprovalRequest)
      if (Notification.isSupported()) new Notification({ title: 'OneDraft needs your OK', body: req.title }).show()
    })
  const toolEnv = (source: 'agent' | 'mcp'): ToolEnv => ({
    engine,
    studio,
    inbox,
    mediaDir: paths.media,
    requestApproval,
    autoApprove: () => store.getSetting('ai.autoApprove') === true,
    source
  })

  // ---- assistant: on the person's Claude plan (Claude Code) or with an API key ----
  const apiAgent = new Agent({
    store,
    toolEnv: () => toolEnv('agent'),
    emit: (e: AgentEvent) => send('agent', e),
    apiKey: () => settingString(store, 'ai.apiKey'),
    model: () => settingString(store, 'ai.model') || 'claude-opus-5-5',
    effort: () => (settingString(store, 'ai.effort') as 'low' | 'medium' | 'high' | 'xhigh' | 'max') || 'medium'
  })
  // A private MCP server only OneDraft's own Claude Code runs know about (random port and token).
  const assistantMcp = new OneDraftMcpServer(() => toolEnv('agent'))
  const assistantToken = randomBytes(24).toString('hex')
  const claudeCli = () => findClaude(settingString(store, 'ai.claudePath'))
  const ccAgent = new ClaudeCodeAgent({
    store,
    emit: (e: AgentEvent) => send('agent', e),
    cli: claudeCli,
    model: () => settingString(store, 'ai.ccModel') || undefined,
    workDir: join(paths.data, 'claude-code'),
    mcp: async () => {
      if (!assistantMcp.running) await assistantMcp.start(0, assistantToken)
      return { url: `http://127.0.0.1:${assistantMcp.port}/mcp`, token: assistantToken }
    }
  })
  /** Which engine runs the assistant: the setting, else the Claude plan when Claude Code is installed. */
  const engineName = (): 'claude-code' | 'api' => {
    const s = settingString(store, 'ai.engine')
    if (s === 'claude-code' || s === 'api') return s
    return claudeCli() ? 'claude-code' : 'api'
  }
  const agent = () => (engineName() === 'claude-code' ? ccAgent : apiAgent)

  // ---- MCP server ----
  if (!store.getSetting('mcp.token')) store.setSetting('mcp.token', randomBytes(24).toString('hex'), true)
  const mcp = new OneDraftMcpServer(() => toolEnv('mcp'))
  const mcpInfo = () => {
    const port = Number(store.getSetting('mcp.port') ?? 7341)
    const token = settingString(store, 'mcp.token') ?? ''
    const url = `http://127.0.0.1:${port}/mcp`
    return {
      enabled: store.getSetting('mcp.enabled') === true,
      running: mcp.running,
      url,
      token,
      claudeCode: `claude mcp add --transport http onedraft ${url} --header "Authorization: Bearer ${token}"`
    }
  }
  const syncMcp = async () => {
    const info = mcpInfo()
    try {
      if (info.enabled) await mcp.start(Number(store.getSetting('mcp.port') ?? 7341), info.token)
      else await mcp.stop()
    } catch (e) {
      store.log('error', `MCP server: ${(e as Error).message}`)
    }
  }
  await syncMcp()

  // ---- media protocol for previews ----
  protocol.handle('onedraft-media', mediaHandler)

  // ---- change notifications to the UI + desktop notifications ----
  const pending = new Set<string>()
  let flush: NodeJS.Timeout | undefined
  let lastEventId = store.listEvents(1)[0]?.id ?? 0
  store.onChange((kind) => {
    pending.add(kind)
    flush ??= setTimeout(() => {
      flush = undefined
      for (const k of pending) send('changed', k)
      if (pending.has('events') && Notification.isSupported()) {
        for (const e of store.listEvents(20).filter((x) => x.id > lastEventId).reverse()) {
          if (/^(Published|Scheduled|Ready for you)/.test(e.message) || (e.level === 'error' && e.scope)) {
            new Notification({ title: e.level === 'error' ? 'OneDraft: a post failed' : 'OneDraft', body: e.message.slice(0, 200) }).show()
          }
        }
        lastEventId = store.listEvents(1)[0]?.id ?? lastEventId
      }
      pending.clear()
    }, 150)
  })

  // ---- IPC ----
  const connecting = new Map<string, AbortController>()
  const handlers: Record<string, (...a: never[]) => unknown> = {
    'app.info': () => ({ version: app.getVersion(), paths, encryption: cipher !== plainCipher }),
    platforms: () => registry.manifests(),
    'accounts.list': () => store.listAccounts(),
    'accounts.connect': async (platform: string, input: Record<string, string>) => {
      const ac = new AbortController()
      connecting.get(platform)?.abort()
      connecting.set(platform, ac)
      try {
        return await engine.connect(platform, input, ac.signal)
      } finally {
        if (connecting.get(platform) === ac) connecting.delete(platform)
      }
    },
    'accounts.cancelConnect': (platform: string) => connecting.get(platform)?.abort(),
    'accounts.reconnect': async (id: string) => {
      const a = engine.mustAccount(id)
      const input: Record<string, string> = { label: a.name }
      if (a.meta.profileKey) input._profileKey = String(a.meta.profileKey)
      return engine.connect(a.platform, input)
    },
    'accounts.check': (id: string) => engine.checkAccount(id),
    'accounts.remove': (id: string) => engine.removeAccount(id),
    'posts.list': () => store.listPosts(),
    'posts.get': (id: string) => store.getPost(id),
    'posts.save': (d: PostDraft) => engine.savePost(d),
    'posts.remove': (id: string) => engine.removePost(id),
    'posts.validate': (id: string) => engine.validatePost(id),
    'posts.approve': async (id: string, publishAt?: string) => {
      const p = await engine.approve(id, publishAt)
      engine.tick()
      return p
    },
    'posts.cancel': (id: string) => engine.cancel(id),
    'targets.retry': (id: string, force?: boolean) => {
      engine.retry(id, !!force)
      engine.tick()
    },
    'targets.markDone': (id: string, url?: string) => store.setTarget(id, { status: 'published', error: null, url: url ?? null }),
    'media.pick': async () => {
      const r = await dialog.showOpenDialog(win!, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Video and images', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'jpg', 'jpeg', 'png', 'webp', 'gif'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      return r.canceled ? [] : r.filePaths
    },
    'media.pickOne': async (kind: 'image' | 'any') => {
      const r = await dialog.showOpenDialog(win!, {
        properties: ['openFile'],
        filters: kind === 'image' ? [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] : []
      })
      return r.canceled ? undefined : r.filePaths[0]
    },
    'media.probe': (path: string) => probe(mediaTools, path),
    'media.fit': (path: string, aspect: string, mode: FitMode, maxSec?: number) =>
      fit(
        mediaTools,
        path,
        { aspect, mode, maxSec, outDir: studio.isAiMedia(path) ? join(studio.generatedDir, 'renditions') : join(paths.media, 'renditions') },
        (f) => send('progress', { scope: 'media', fraction: f, note: 'Converting' })
      ),
    'media.isAi': (path: string) => studio.isAiMedia(path),
    'media.analyze': async (path: string) => {
      const info = await probe(mediaTools, path)
      const silences = info.hasAudio ? await detectSilences(mediaTools, path) : []
      return { info, silences, speechSegments: info.hasAudio ? speechSegments(info.durationSec ?? 0, silences) : [] }
    },
    'media.readSrt': (path: string) => parseSrt(readFileSync(path, 'utf8')),
    'media.pickFiles': async (kind: 'video' | 'image' | 'audio' | 'srt' | 'any', multi?: boolean) => {
      const ext = { video: ['mp4', 'mov', 'm4v', 'webm', 'mkv'], image: ['jpg', 'jpeg', 'png', 'webp'], audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'], srt: ['srt'], any: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'jpg', 'jpeg', 'png', 'webp'] }[kind]
      const r = await dialog.showOpenDialog(win!, { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name: kind, extensions: ext }] })
      return r.canceled ? [] : r.filePaths
    },
    'studio.list': () => studio.list(),
    'studio.get': (id: string) => studio.get(id),
    'studio.saveEdit': (p: { id?: string; name?: string; spec: EditSpec }) => studio.saveEdit(p),
    'studio.saveGenerated': (p: { id?: string; name?: string; prompt?: string; composition: CompositionSpec }) => studio.saveGenerated(p),
    'studio.render': async (id: string) => {
      try {
        return await studio.render(id)
      } catch (e) {
        send('progress', { scope: `project:${id}`, fraction: 0, note: 'Failed' })
        throw e
      }
    },
    'studio.cancel': (id: string) => studio.cancel(id),
    'studio.remove': (id: string) => studio.remove(id),
    'studio.voices': () => studio.voices(),
    'media.cover': (path: string, atSec: number) => coverFrame(mediaTools, path, atSec, join(paths.media, 'covers')),
    'inbox.list': () => store.listComments(),
    'inbox.status': () => inbox.status(),
    'inbox.check': async () => {
      const r = await inbox.check()
      return { ...inbox.status(), added: r.added.length }
    },
    'inbox.reply': (key: string, text: string) => inbox.reply(String(key), String(text ?? '')),
    'inbox.setDraft': (key: string, text: string) => store.setCommentDraft(String(key), typeof text === 'string' ? text : undefined, 'you'),
    'inbox.setState': (keys: string[], state: 'open' | 'done') => {
      if (!Array.isArray(keys) || (state !== 'open' && state !== 'done')) throw new Error('Bad request.')
      store.setCommentState(keys.map(String), state)
    },
    'stats.list': () => store.listStats(),
    'stats.refresh': (targetIds?: string[]) => inbox.refreshStats(Array.isArray(targetIds) ? targetIds.map(String) : undefined),
    'settings.get': () => store.allSettings(),
    'settings.set': async (entries: { key: string; value: unknown; secret?: boolean }[]) => {
      for (const e of entries) store.setSetting(e.key, e.value, !!e.secret)
      if (entries.some((e) => e.key.startsWith('inbox.'))) send('changed', 'inbox')
      if (entries.some((e) => e.key.startsWith('mcp.'))) await syncMcp()
      if (entries.some((e) => e.key === 'mcpBridges')) reloadExtensions()
      applySettings()
      if (entries.some((e) => e.key === 'mcpBridges' || /^[\w-]+\./.test(e.key))) send('changed', 'platforms')
      return store.allSettings()
    },
    'connectors.reload': () => {
      const r = reloadExtensions()
      applySettings()
      send('changed', 'platforms')
      return r
    },
    'agent.send': (text: string) => {
      const a = agent()
      if (a.busy) throw new Error('Claude is still working on the last request. Wait for it, or press Stop.')
      a.send(text).catch((e: Error) => send('agent', { type: 'error', message: e.message } satisfies AgentEvent))
    },
    'agent.stop': () => agent().stop(),
    'agent.reset': () => agent().reset(),
    'agent.history': () => ({ items: agent().history(), busy: agent().busy, engine: engineName() }),
    'ai.status': async () => ({
      engine: engineName(),
      engineSetting: settingString(store, 'ai.engine') ?? 'auto',
      claude: await claudeStatus(claudeCli()),
      apiKeySet: store.allSettings().secretsSet.includes('ai.apiKey')
    }),
    'approvals.respond': (id: string, ok: boolean) => {
      const a = approvals.get(id)
      if (!a) throw new Error('That request expired or was already answered.')
      a.answer(ok)
    },
    'approvals.list': () => [...approvals.values()].map((a) => a.req),
    'events.list': (limit?: number, scope?: string) => store.listEvents(limit ?? 300, scope),
    'mcp.info': () => mcpInfo(),
    'mcp.newToken': async () => {
      store.setSetting('mcp.token', randomBytes(24).toString('hex'), true)
      await syncMcp()
      return mcpInfo()
    },
    'shell.open': (url: string) => {
      if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    },
    'shell.showItem': (path: string) => shell.showItemInFolder(path),
    'shell.openPath': (path: string) => shell.openPath(path)
  }
  ipcMain.handle('call', async (e, method: string, ...args: unknown[]) => {
    // Only OneDraft's own page may call in (not a file dropped on the window, not a render window).
    if (!isAppUrl(e.senderFrame?.url)) throw new Error('Not allowed.')
    const h = handlers[method]
    if (!h) throw new Error(`Unknown method ${method}`)
    return (h as (...a: unknown[]) => unknown)(...args)
  })

  // ---- scheduler ----
  setInterval(() => engine.tick(), 15_000)
  setTimeout(() => engine.tick(), 3000)

  // New comments, looked for in the background as often as Inbox → "Check every" says.
  const backgroundCheck = async () => {
    const every = inboxEvery()
    if (!every || !inbox.accounts().length) return
    const last = inbox.lastCheckedAt ? new Date(inbox.lastCheckedAt).getTime() : 0
    if (Date.now() - last < every * 60_000) return
    const { added } = await inbox.check({ background: true })
    // No pop-up while you're looking at OneDraft: the Inbox badge already shows them.
    if (!added.length || !Notification.isSupported() || win?.isFocused()) return
    const names = [...new Set(added.map((c) => c.author))]
    const n = new Notification(
      added.length === 1
        ? { title: `New comment from ${added[0].author}`, body: added[0].text.slice(0, 200) }
        : { title: `${added.length} new comments`, body: `From ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}` }
    )
    n.on('click', () => {
      showWindow()
      send('navigate', 'inbox')
    })
    n.show()
  }
  const runBackgroundCheck = () => void backgroundCheck().catch((e: Error) => store.log('warn', `Inbox check: ${e.message}`))
  setInterval(runBackgroundCheck, 60_000)
  setTimeout(runBackgroundCheck, 20_000)
  setInterval(
    () => {
      for (const a of store.listAccounts()) {
        if (registry.has(a.platform) && registry.get(a.platform).manifest.kind === 'api') void engine.checkAccount(a.id)
      }
    },
    6 * 3600_000
  )

  createWindow()
  createTray()

  app.on('second-instance', showWindow)
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => {
    void mcp.stop()
    void assistantMcp.stop()
    ccAgent.stop()
    void browsers.closeAll()
  })
  app.on('window-all-closed', () => {
    // Keep running in the tray so scheduled posts go out, unless turned off.
    if (store.getSetting('app.runInBackground') === false) app.quit()
  })
}

function iconPath() {
  const candidates = [join(__dirname, '../../resources/icon.png'), join(process.resourcesPath ?? '', 'icon.png')]
  return candidates.find((p) => existsSync(p))
}

const rendererFile = join(__dirname, '../renderer/index.html')
function isAppUrl(url: string | undefined): boolean {
  if (!url) return false
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) return url === dev || url.startsWith(dev.endsWith('/') ? dev : `${dev}/`) || url.startsWith(`${dev}#`) || url.startsWith(`${dev}?`)
  return url.split(/[?#]/)[0] === pathToFileURL(rendererFile).toString()
}

function createWindow() {
  const icon = iconPath()
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0e1014',
    title: 'OneDraft',
    icon,
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Dropping a file on the window (or any link) must not replace the app with that page.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })
  win.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => {
    win = null
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(rendererFile)
}

function showWindow() {
  if (!win) createWindow()
  if (win?.isMinimized()) win.restore()
  win?.show()
  win?.focus()
}

function createTray() {
  const icon = iconPath()
  if (!icon) return
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setToolTip('OneDraft — scheduled posts keep going while this runs')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open OneDraft', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showWindow)
}

// Write a small README into the plugins folder the first time.
const pluginReadme = join(paths.plugins, 'README.txt')
if (primary && !existsSync(pluginReadme)) {
  writeFileSync(
    pluginReadme,
    'OneDraft connector plugins\n\nEach folder here with an index.js (CommonJS) exporting `connector` adds a platform.\nSee docs/writing-a-connector.md in the OneDraft source for the interface.\nUse Settings → Connectors → Reload after adding one.\n'
  )
}

if (primary) void main()
