// MCP bridge: turns any MCP server that can post somewhere into a OneDraft platform.
// Configure in Settings → "MCP bridges" (JSON). Example for xiaohongshu-mcp:
//
// [{ "id": "xhs-mcp", "name": "Rednote (xiaohongshu-mcp)", "url": "http://localhost:18060/mcp",
//    "video": true, "image": true,
//    "tools": {
//      "check": { "name": "check_login_status" },
//      "publishVideo": { "name": "publish_with_video",
//        "args": { "title": "{{title}}", "content": "{{caption}}", "video": "{{video}}", "tags": "{{tags}}", "schedule_at": "{{publishAt}}" } },
//      "publishImages": { "name": "publish_content",
//        "args": { "title": "{{title}}", "content": "{{caption}}", "images": "{{images}}", "tags": "{{tags}}" } } } }]
//
// "{{x}}" alone keeps the value's type (arrays stay arrays, empty values are dropped);
// "{{x}}" inside a longer string is interpolated. Available: title caption tags video images media
// cover publishAt aiGenerated, plus options.<key>.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ContentError, type Connector } from '../core/connector'
import type { Constraints, ResolvedContent } from '../shared/types'
import { isVideo } from './util'

export interface BridgeTool {
  name: string
  args?: Record<string, unknown>
}

export interface BridgeConfig {
  id: string
  name: string
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  video?: boolean
  image?: boolean
  text?: boolean
  nativeSchedule?: boolean
  color?: string
  constraints?: Constraints
  tools: { check?: BridgeTool; publishVideo?: BridgeTool; publishImages?: BridgeTool; publishText?: BridgeTool }
}

function vars(c: ResolvedContent, publishAt?: string): Record<string, unknown> {
  const video = c.media.find(isVideo)
  return {
    title: c.title,
    caption: c.caption,
    tags: c.tags,
    video,
    images: c.media.filter((m) => !isVideo(m)),
    media: c.media,
    cover: c.cover,
    publishAt,
    aiGenerated: c.aiGenerated,
    ...Object.fromEntries(Object.entries(c.options).map(([k, v]) => [`options.${k}`, v]))
  }
}

export function fillTemplate(t: unknown, v: Record<string, unknown>): unknown {
  if (typeof t === 'string') {
    const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(t)
    if (whole) return v[whole[1]]
    return t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
      const x = v[k]
      return Array.isArray(x) ? x.join(',') : x === undefined || x === null ? '' : String(x)
    })
  }
  if (Array.isArray(t)) return t.map((x) => fillTemplate(x, v))
  if (t && typeof t === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(t)) {
      const filled = fillTemplate(x, v)
      if (filled !== undefined && filled !== '' && !(Array.isArray(filled) && !filled.length)) out[k] = filled
    }
    return out
  }
  return t
}

async function withClient<T>(cfg: BridgeConfig, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'onedraft', version: '0.1.0' })
  const transport = cfg.url
    ? new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers ?? {} } })
    : cfg.command
      ? new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [] })
      : undefined
  if (!transport) throw new Error(`MCP bridge ${cfg.id} needs a url or a command.`)
  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => undefined)
  }
}

function textOf(r: unknown): string {
  const content = (r as { content?: unknown }).content
  const parts = Array.isArray(content) ? (content as { type: string; text?: string }[]) : []
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

export function makeBridge(cfg: BridgeConfig): Connector {
  return {
    manifest: {
      id: cfg.id,
      name: cfg.name,
      kind: 'mcp',
      color: cfg.color ?? '#8b5cf6',
      source: 'mcp',
      capabilities: {
        video: !!cfg.video,
        image: !!cfg.image,
        text: !!cfg.text,
        nativeSchedule: !!cfg.nativeSchedule,
        comments: false,
        reply: false,
        stats: false
      },
      constraints: cfg.constraints ?? { media: { required: !cfg.text } },
      settings: [],
      connectFields: [{ key: 'label', label: 'Name for this account', type: 'text' }],
      options: [],
      notes: [
        `Runs through the MCP server at ${cfg.url ?? [cfg.command, ...(cfg.args ?? []).map((a) => a.split(/[\\/]/).pop())].join(' ')}. Log in with that server’s own tools first.`
      ]
    },

    async connect(_ctx, input) {
      if (cfg.tools.check) {
        const r = await withClient(cfg, (c) => c.callTool({ name: cfg.tools.check!.name, arguments: (cfg.tools.check!.args ?? {}) as Record<string, unknown> }))
        if (r.isError) throw new Error(`${cfg.name}: ${textOf(r)}`)
      }
      const label = input.label?.trim() || cfg.name
      return { name: label, remoteUserId: `${cfg.id}:${label}` }
    },

    async check() {
      if (!cfg.tools.check) return { ok: true }
      const r = await withClient(cfg, (c) => c.callTool({ name: cfg.tools.check!.name, arguments: (cfg.tools.check!.args ?? {}) as Record<string, unknown> }))
      return { ok: !r.isError, note: textOf(r).slice(0, 300) }
    },

    async publish(_ctx, _account, { content, publishAt }) {
      const tool = content.media.some(isVideo) ? cfg.tools.publishVideo : content.media.length ? cfg.tools.publishImages : cfg.tools.publishText
      if (!tool) throw new ContentError(`${cfg.name} has no tool configured for this kind of post.`)
      const args = fillTemplate(tool.args ?? {}, vars(content, publishAt)) as Record<string, unknown>
      const r = await withClient(cfg, (c) => c.callTool({ name: tool.name, arguments: args }, undefined, { timeout: 20 * 60_000 }))
      const text = textOf(r)
      if (r.isError) throw new Error(`${cfg.name}: ${text.slice(0, 500)}`)
      const url = /https?:\/\/\S+/.exec(text)?.[0]
      return { state: publishAt && cfg.nativeSchedule ? 'scheduled' : 'published', url, note: text.slice(0, 300) || undefined }
    }
  }
}
