// The in-app AI agent: Claude with Polycast's tools, a streaming tool loop, conversation kept in SQLite.
// Anything that publishes or replies goes through an approval card in the app (see core/tools.ts).

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { Store } from '../core/store'
import { runTool, TOOLS, type ToolEnv } from '../core/tools'
import type { AgentItem } from '../shared/types'

type Msg = Anthropic.Beta.BetaMessageParam
const CONVERSATION = 'main'

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'items'; items: AgentItem[] }
  | { type: 'busy'; busy: boolean }
  | { type: 'error'; message: string }

const SYSTEM = `You are Polycast's assistant. Polycast is a desktop app that manages the user's own social media accounts (YouTube, Bilibili, Rednote/小红书, Instagram, TikTok, X, and any platform added as a plugin or MCP bridge). You act through the tools; you cannot see the screen.

How to help with a post:
1. list_accounts, then get_platform_rules for each platform involved. Respect every limit exactly (Rednote titles are 20 characters with English letters counting half; Bilibili titles 80; YouTube titles 100).
2. probe_media on the user's files. If a platform prefers another aspect ratio (TikTok/Reels/Shorts/Rednote video 9:16, Rednote images 3:4, Instagram images 4:5, Bilibili/YouTube long-form 16:9), make renditions with fit_media and put them in that account's variant.
3. Write a real per-platform version, not one caption pasted everywhere: YouTube = searchable title and a description with context and links; Bilibili and Rednote = natural Simplified Chinese unless the user says otherwise (Rednote: short punchy title, conversational body, a few emoji, topics as tags); Instagram and TikTok = a hook in the first line plus relevant hashtags; X = concise, threads only when the text needs it.
4. create_post (it is only a draft), read the issues it returns, fix errors with update_variant, then summarize what each account will get.
5. Publishing: call approve_post only when the user asked to publish or schedule. The user confirms in the app; if they decline, ask what to change. Never claim something is published until get_post shows it.

Mark aiGenerated true when the user's media or text was generated or substantially altered by AI; ask if you are unsure. Platforms (and China's labeling rules for Bilibili and Rednote) require that disclosure.
For comments, draft replies in the user's voice and send them with reply_comment, which the user confirms.
Be brief in chat. File paths are absolute Windows paths.`

function toolDefs(): Anthropic.Beta.BetaTool[] {
  return TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>
    delete schema.$schema
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true
    }
  })
}

/** Rebuild chat items from stored API messages. */
export function itemsFrom(messages: Msg[]): AgentItem[] {
  const items: AgentItem[] = []
  const tools = new Map<string, Extract<AgentItem, { kind: 'tool' }>>()
  for (const m of messages) {
    if (typeof m.content === "string" || !m.content) {
      const text = m.content ?? ""
      items.push(m.role === "user" ? { kind: "user", text } : { kind: "assistant", text })
      continue
    }
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) items.push(m.role === 'user' ? { kind: 'user', text: b.text } : { kind: 'assistant', text: b.text })
      else if (b.type === 'tool_use') {
        const item: Extract<AgentItem, { kind: 'tool' }> = { kind: 'tool', id: b.id, name: b.name, input: b.input }
        tools.set(b.id, item)
        items.push(item)
      } else if (b.type === 'tool_result') {
        const t = tools.get(b.tool_use_id)
        if (t) {
          t.result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
          t.isError = b.is_error
        }
      }
    }
  }
  return items
}

export class Agent {
  private messages: Msg[]
  private abort?: AbortController

  constructor(
    private deps: {
      store: Store
      toolEnv: () => ToolEnv
      emit: (e: AgentEvent) => void
      apiKey: () => string | undefined
      model: () => string
      effort: () => 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    }
  ) {
    this.messages = deps.store.agentMessages<Msg>(CONVERSATION).filter(Boolean)
  }

  history(): AgentItem[] {
    return itemsFrom(this.messages)
  }

  get busy() {
    return !!this.abort
  }

  stop() {
    this.abort?.abort()
  }

  reset() {
    this.stop()
    this.messages = []
    this.deps.store.clearAgent(CONVERSATION)
    this.deps.emit({ type: 'items', items: [] })
  }

  private push(m: Msg) {
    this.messages.push(m)
    this.deps.store.appendAgentMessage(CONVERSATION, m)
  }

  async send(text: string): Promise<void> {
    if (this.abort) throw new Error('The assistant is still working; wait or press Stop.')
    // A stopped turn can leave an assistant tool_use without results; close it before continuing.
    this.repairDanglingToolUse()
    this.abort = new AbortController()
    this.deps.emit({ type: 'busy', busy: true })
    this.push({ role: 'user', content: text })
    this.deps.emit({ type: 'items', items: this.history() })
    try {
      await this.loop(this.abort.signal)
    } catch (e) {
      this.deps.emit({ type: 'error', message: describe(e) })
    } finally {
      this.abort = undefined
      this.deps.emit({ type: 'busy', busy: false })
      this.deps.emit({ type: 'items', items: this.history() })
    }
  }

  private repairDanglingToolUse() {
    const last = this.messages[this.messages.length - 1]
    if (!last || last.role !== 'assistant' || typeof last.content === 'string') return
    const pending = last.content.filter((b) => b.type === 'tool_use')
    if (!pending.length) return
    this.push({
      role: 'user',
      content: pending.map((b) => ({ type: 'tool_result' as const, tool_use_id: (b as { id: string }).id, content: 'Stopped by the user.', is_error: true }))
    })
  }

  private async loop(signal: AbortSignal) {
    const key = this.deps.apiKey()
    const client = key ? new Anthropic({ apiKey: key }) : new Anthropic()
    const tools = toolDefs()
    let jsonRetries = 0
    for (let turn = 0; turn < 40; turn++) {
      const stream = client.beta.messages.stream(
        {
          model: this.deps.model(),
          max_tokens: 64000,
          system: SYSTEM,
          tools,
          messages: this.messages,
          output_config: { effort: this.deps.effort() },
          cache_control: { type: 'ephemeral' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default'
        } as Anthropic.Beta.MessageCreateParamsStreaming,
        { signal }
      )
      stream.on('text', (delta) => this.deps.emit({ type: 'delta', text: delta }))
      let message: Anthropic.Beta.BetaMessage
      try {
        message = await stream.finalMessage()
        jsonRetries = 0
      } catch (e) {
        if (e instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw e
        continue // a tool input could not be parsed; ask again
      }
      this.push({ role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] })
      this.deps.emit({ type: 'items', items: this.history() })

      if (message.stop_reason === 'refusal') throw new Error('Claude declined this request.')
      if (message.stop_reason === 'pause_turn') continue
      const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      if (!uses.length || message.stop_reason === 'end_turn') return
      if (message.stop_reason === 'max_tokens') throw new Error('The reply was cut off (max tokens). Try a smaller request.')

      const env = this.deps.toolEnv()
      const results = await Promise.all(
        uses.map(async (u) => {
          const r = await runTool(u.name, u.input, env)
          let content = JSON.stringify(r.result ?? null, null, 1)
          if (content.length > 30_000) content = `${content.slice(0, 30_000)}… (truncated)`
          return { type: 'tool_result' as const, tool_use_id: u.id, content, is_error: !r.ok }
        })
      )
      if (signal.aborted) {
        this.push({ role: 'user', content: results.map((r) => ({ ...r, content: 'Stopped by the user.', is_error: true })) })
        return
      }
      this.push({ role: 'user', content: results })
      this.deps.emit({ type: 'items', items: this.history() })
    }
    throw new Error('Stopped after 40 steps.')
  }
}

function describe(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Claude API key missing or invalid: add it in Settings → AI.'
  if (e instanceof Anthropic.PermissionDeniedError) return `Claude API refused: ${e.message}`
  if (e instanceof Anthropic.RateLimitError) return 'Claude API rate limit reached; try again shortly.'
  if (e instanceof Anthropic.APIUserAbortError) return 'Stopped.'
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status ?? ''}: ${e.message}`
  if (e instanceof Error && /api key|apiKey|authentication/i.test(e.message)) return 'Add your Claude API key in Settings → AI.'
  return (e as Error)?.message ?? String(e)
}
