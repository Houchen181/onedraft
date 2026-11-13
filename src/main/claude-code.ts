// The assistant on the person's own Claude plan, through the Claude Code on this computer.
//
// Polycast starts the unmodified `claude` program (signed in by the person, with their Pro/Max plan) in
// print mode, with its built-in tools switched off and only Polycast's tools available through a private
// MCP server. Polycast never reads, stores or passes on Claude credentials, and removes any API key from
// the child's environment so the person's own sign-in is used.
//
// Anthropic does not allow third-party apps to offer Claude plan sign-in to their users, so this is for
// the developer's own use; a distributed build should default to API keys (see README).

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Store } from '../core/store'
import type { AgentItem } from '../shared/types'
import type { AgentEvent } from './agent'
import { SYSTEM } from './agent'

const CONVERSATION = 'claude-code'
const PREFIX = 'mcp__polycast__'

export function findClaude(configured?: string): string | undefined {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates = [
    configured?.trim(),
    ...(process.env.PATH ?? '').split(delimiter).map((d) => d && join(d, exe)),
    join(homedir(), '.local', 'bin', exe)
  ]
  return candidates.find((c) => !!c && existsSync(c))
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ELECTRON_RUN_AS_NODE
  // Rendering a video or waiting for the person's approval can take a while.
  env.MCP_TOOL_TIMEOUT = String(45 * 60_000)
  return env
}

export async function claudeStatus(cli: string | undefined): Promise<{ found: boolean; path?: string; signedIn: boolean; method?: string; error?: string }> {
  if (!cli) return { found: false, signedIn: false }
  return new Promise((resolve) => {
    const p = spawn(cli, ['auth', 'status'], { env: childEnv(), windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', (e) => resolve({ found: true, path: cli, signedIn: false, error: e.message }))
    p.on('close', (code) => {
      try {
        const j = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string }
        resolve({ found: true, path: cli, signedIn: code === 0 && !!j.loggedIn && j.authMethod !== 'none', method: j.authMethod })
      } catch {
        resolve({ found: true, path: cli, signedIn: false, error: out.slice(0, 200) })
      }
    })
    setTimeout(() => p.kill(), 20_000)
  })
}

interface CcEvent {
  type: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  result?: string
  mcp_servers?: { name: string; status: string }[]
  event?: { type: string; delta?: { type: string; text?: string } }
  message?: { content?: ({ type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean })[] }
  parent_tool_use_id?: string | null
}

export class ClaudeCodeAgent {
  private items: AgentItem[]
  private proc?: ChildProcess
  private stopped = false

  constructor(
    private deps: {
      store: Store
      emit: (e: AgentEvent) => void
      cli: () => string | undefined
      model: () => string | undefined
      /** The private MCP server Claude Code uses to reach Polycast's tools. */
      mcp: () => Promise<{ url: string; token: string }>
      workDir: string
    }
  ) {
    this.items = deps.store.agentMessages<AgentItem>(CONVERSATION).filter(Boolean)
  }

  history() {
    return this.items
  }

  get busy() {
    return !!this.proc
  }

  stop() {
    this.stopped = true
    this.proc?.kill()
  }

  reset() {
    this.stop()
    this.items = []
    this.deps.store.clearAgent(CONVERSATION)
    this.deps.store.setSetting('ai.ccSession', null)
    this.deps.emit({ type: 'items', items: [] })
  }

  private add(item: AgentItem) {
    this.items.push(item)
    this.deps.store.appendAgentMessage(CONVERSATION, item)
  }

  /** Persist tool results that arrived after the tool item was saved. */
  private resave() {
    this.deps.store.clearAgent(CONVERSATION)
    for (const it of this.items) this.deps.store.appendAgentMessage(CONVERSATION, it)
  }

  async send(text: string): Promise<void> {
    if (this.proc) throw new Error('The assistant is still working; wait or press Stop.')
    const cli = this.deps.cli()
    this.add({ kind: 'user', text })
    this.deps.emit({ type: 'busy', busy: true })
    this.deps.emit({ type: 'items', items: this.items })
    try {
      if (!cli) throw new Error('Claude Code was not found. Install it (claude.com/claude-code) and sign in with your Claude plan, or switch to an API key in Settings → AI.')
      await this.turn(cli, text)
    } catch (e) {
      const message = (e as Error).message
      this.add({ kind: 'error', text: message })
      this.deps.emit({ type: 'error', message })
    } finally {
      this.proc = undefined
      this.resave()
      this.deps.emit({ type: 'busy', busy: false })
      this.deps.emit({ type: 'items', items: this.items })
    }
  }

  private async turn(cli: string, text: string) {
    mkdirSync(this.deps.workDir, { recursive: true })
    const mcp = await this.deps.mcp()
    const config = JSON.stringify({
      mcpServers: { polycast: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } }
    })
    const existing = this.deps.store.getSetting<string>('ai.ccSession')
    const session = existing ?? randomUUID()
    const args = [
      '-p',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--system-prompt', SYSTEM,
      '--tools', '',
      '--mcp-config', config, '--strict-mcp-config',
      '--allowedTools', 'mcp__polycast',
      '--permission-mode', 'dontAsk',
      '--setting-sources', 'local',
      '--disable-slash-commands',
      '--max-turns', '60',
      ...(existing ? ['--resume', session] : ['--session-id', session])
    ]
    const model = this.deps.model()
    if (model) args.push('--model', model)

    this.stopped = false
    const proc = spawn(cli, args, { cwd: this.deps.workDir, env: childEnv(), windowsHide: true })
    this.proc = proc
    proc.stdin.end(text, 'utf8')

    const tools = new Map<string, Extract<AgentItem, { kind: 'tool' }>>()
    let stderr = ''
    let buf = ''
    let result: CcEvent | undefined
    let sawSession = false
    proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)))

    const handle = (ev: CcEvent) => {
      if (ev.type === 'system' && ev.subtype === 'init') {
        sawSession = true
        if (!existing) this.deps.store.setSetting('ai.ccSession', ev.session_id ?? session)
        const pc = ev.mcp_servers?.find((s) => s.name === 'polycast')
        if (pc && pc.status !== 'connected') this.deps.emit({ type: 'error', message: `Claude Code could not reach Polycast's tools (${pc.status}).` })
        return
      }
      if (ev.parent_tool_use_id) return // subagent chatter
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        this.deps.emit({ type: 'delta', text: ev.event.delta.text ?? '' })
        return
      }
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) this.add({ kind: 'assistant', text: b.text })
          else if (b.type === 'tool_use' && b.id) {
            const item: Extract<AgentItem, { kind: 'tool' }> = { kind: 'tool', id: b.id, name: (b.name ?? '').replace(PREFIX, ''), input: b.input }
            tools.set(b.id, item)
            this.add(item)
          }
        }
        this.deps.emit({ type: 'items', items: this.items })
        return
      }
      if (ev.type === 'user') {
        for (const b of ev.message?.content ?? []) {
          if (b.type !== 'tool_result' || !b.tool_use_id) continue
          const t = tools.get(b.tool_use_id)
          if (!t) continue
          if (typeof b.content === 'string') t.result = b.content
          else if (Array.isArray(b.content)) {
            const parts = b.content as { type: string; text?: string }[]
            const n = parts.filter((p) => p.type === 'image').length
            t.result = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') + (n ? `\n[${n} image${n > 1 ? 's' : ''}]` : '')
          }
          t.isError = b.is_error
        }
        this.deps.emit({ type: 'items', items: this.items })
        return
      }
      if (ev.type === 'result') result = ev
    }

    proc.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          handle(JSON.parse(line) as CcEvent)
        } catch {
          /* not JSON */
        }
      }
    })

    const code = await new Promise<number | null>((resolve, reject) => {
      proc.on('error', reject)
      proc.on('close', resolve)
    })
    if (buf.trim()) {
      try {
        handle(JSON.parse(buf) as CcEvent)
      } catch {
        /* ignore */
      }
    }
    if (this.stopped) {
      this.add({ kind: 'error', text: 'Stopped.' })
      return
    }
    if (result?.is_error || (result && result.subtype !== 'success')) {
      const msg = result.result || result.subtype || 'Claude Code failed'
      if (existing && !sawSession) this.deps.store.setSetting('ai.ccSession', null) // the saved session is gone; start fresh next time
      throw new Error(/log ?in|not logged|authenticat/i.test(msg) ? 'Claude Code is not signed in. Run `claude` once in a terminal and sign in with your Claude plan.' : msg)
    }
    if (!result) {
      if (existing && /no conversation found|session/i.test(stderr)) this.deps.store.setSetting('ai.ccSession', null)
      throw new Error(`Claude Code stopped (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' ') || 'no message'}`)
    }
  }
}
