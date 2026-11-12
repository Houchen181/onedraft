// One set of tools for every AI surface: the in-app agent and the MCP server use the same definitions,
// so anything an agent can do here, Claude Code / Claude Desktop / other MCP clients can do too.
// Tools that act on the outside world (publishing, replying) ask the user in the app first.

import { join } from 'node:path'
import { z } from 'zod'
import type { Engine } from './engine'
import { coverFrame, fit, probe } from './media'
import { resolveContent } from './validate'

export interface ToolEnv {
  engine: Engine
  mediaDir: string
  /** Ask the person in the app. Resolves true if they approve. */
  requestApproval(req: { title: string; detail: string; source: 'agent' | 'mcp' }): Promise<boolean>
  /** When true, approving/publishing posts does not need a click (Settings → AI). */
  autoApprove(): boolean
  source: 'agent' | 'mcp'
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string
  description: string
  schema: S
  run(input: z.infer<S>, env: ToolEnv): Promise<unknown>
}

const def = <S extends z.ZodObject>(d: ToolDef<S>) => d as unknown as ToolDef

const variantShape = {
  title: z.string().optional().describe('Platform-specific title (falls back to the post title)'),
  caption: z.string().optional().describe('Platform-specific caption/description (falls back to the post body)'),
  tags: z.array(z.string()).optional().describe('Tags/hashtags without #'),
  media: z.array(z.string()).optional().describe('Absolute file paths that replace the post media for this platform, e.g. a 9:16 rendition'),
  cover: z.string().optional().describe('Absolute path of a cover image'),
  options: z.record(z.string(), z.unknown()).optional().describe('Platform options, keys from get_platform_rules')
}

function summarizePost(engine: Engine, id: string) {
  const p = engine.mustPost(id)
  const accounts = new Map(engine.store.listAccounts().map((a) => [a.id, a]))
  return {
    id: p.id,
    status: p.status,
    title: p.title,
    body: p.body,
    tags: p.tags,
    media: p.media,
    aiGenerated: p.aiGenerated,
    scheduledAt: p.scheduledAt,
    targets: p.targets.map((t) => ({
      targetId: t.id,
      accountId: t.accountId,
      account: accounts.get(t.accountId)?.name,
      platform: t.platform,
      status: t.status,
      variant: t.variant,
      url: t.url,
      error: t.error
    }))
  }
}

export const TOOLS: ToolDef[] = [
  def({
    name: 'list_platforms',
    description: 'List the platforms Polycast can post to, with what each supports (video/image/text, native scheduling, comments).',
    schema: z.object({}),
    async run(_i, { engine }) {
      return engine.registry.manifests().map((m) => ({ id: m.id, name: m.name, kind: m.kind, capabilities: m.capabilities, notes: m.notes }))
    }
  }),
  def({
    name: 'get_platform_rules',
    description:
      "Get one platform's limits (title/caption length, tag rules, video length/aspect/size, image count) and its per-post options. Read this before writing a variant for that platform.",
    schema: z.object({ platform: z.string() }),
    async run({ platform }, { engine }) {
      const m = engine.connector(platform).manifest
      return { id: m.id, name: m.name, constraints: m.constraints, options: m.options, capabilities: m.capabilities, notes: m.notes }
    }
  }),
  def({
    name: 'list_accounts',
    description: 'List connected social media accounts (id, platform, name, login status).',
    schema: z.object({}),
    async run(_i, { engine }) {
      return engine.store.listAccounts().map((a) => ({ id: a.id, platform: a.platform, name: a.name, handle: a.handle, status: a.status, note: a.statusNote }))
    }
  }),
  def({
    name: 'list_posts',
    description: 'List recent posts with their per-account status.',
    schema: z.object({ status: z.string().optional().describe('Filter: draft, queued, scheduled, published, partial, failed'), limit: z.number().int().optional() }),
    async run({ status, limit }, { engine }) {
      return engine.store
        .listPosts(limit ?? 30)
        .filter((p) => !status || p.status === status)
        .map((p) => ({ id: p.id, status: p.status, title: p.title || p.body.slice(0, 60), scheduledAt: p.scheduledAt, targets: p.targets.map((t) => `${t.platform}:${t.status}`) }))
    }
  }),
  def({
    name: 'get_post',
    description: 'Get one post with every target (account), its variant, status, link and errors.',
    schema: z.object({ postId: z.string() }),
    async run({ postId }, { engine }) {
      return summarizePost(engine, postId)
    }
  }),
  def({
    name: 'create_post',
    description:
      'Create a DRAFT post for one or more accounts. Master title/body/tags/media apply everywhere unless a variant overrides them. Nothing is published until approved.',
    schema: z.object({
      title: z.string().default(''),
      body: z.string().default(''),
      tags: z.array(z.string()).default([]),
      media: z.array(z.string()).default([]).describe('Absolute local file paths'),
      aiGenerated: z.boolean().default(false).describe('True if the content was made or substantially altered by AI (sets platform disclosure labels)'),
      accountIds: z.array(z.string()).min(1),
      variants: z.array(z.object({ accountId: z.string(), ...variantShape })).optional(),
      scheduledAt: z.string().optional().describe('ISO 8601 time to publish; omit for "as soon as approved"')
    }),
    async run(i, { engine }) {
      const vmap = new Map((i.variants ?? []).map(({ accountId, ...v }) => [accountId, v]))
      for (const id of i.accountIds) engine.mustAccount(id)
      const post = engine.savePost({
        title: i.title,
        body: i.body,
        tags: i.tags,
        media: i.media,
        aiGenerated: i.aiGenerated,
        scheduledAt: i.scheduledAt,
        targets: i.accountIds.map((accountId) => ({ accountId, variant: vmap.get(accountId) ?? {} }))
      })
      return { ...summarizePost(engine, post.id), issues: await engine.validatePost(post.id) }
    }
  }),
  def({
    name: 'update_post',
    description: 'Change the master fields of a draft post.',
    schema: z.object({
      postId: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      media: z.array(z.string()).optional(),
      aiGenerated: z.boolean().optional(),
      scheduledAt: z.string().optional()
    }),
    async run({ postId, ...patch }, { engine }) {
      const p = engine.mustPost(postId)
      engine.savePost({
        id: p.id,
        title: patch.title ?? p.title,
        body: patch.body ?? p.body,
        tags: patch.tags ?? p.tags,
        media: patch.media ?? p.media,
        aiGenerated: patch.aiGenerated ?? p.aiGenerated,
        scheduledAt: patch.scheduledAt ?? p.scheduledAt,
        targets: p.targets.map((t) => ({ accountId: t.accountId, variant: t.variant }))
      })
      return { ...summarizePost(engine, postId), issues: await engine.validatePost(postId) }
    }
  }),
  def({
    name: 'update_variant',
    description: "Set one account's platform-specific version of a post (title, caption, tags, media, cover, options). Fields you omit are kept.",
    schema: z.object({ targetId: z.string(), ...variantShape }),
    async run({ targetId, ...patch }, { engine }) {
      const t = engine.store.updateTargetVariant(targetId, patch)
      const post = engine.mustPost(t.postId)
      return { target: t, resolved: resolveContent(post, t), issues: await engine.validateTarget(post, t) }
    }
  }),
  def({
    name: 'validate_post',
    description: "Check every target of a post against its platform's rules. Errors block approval; warnings don't.",
    schema: z.object({ postId: z.string() }),
    async run({ postId }, { engine }) {
      return engine.validatePost(postId)
    }
  }),
  def({
    name: 'probe_media',
    description: 'Read a local video or image: duration, width, height, size, codec.',
    schema: z.object({ path: z.string() }),
    async run({ path }, { engine }) {
      return probe(engine.mediaTools, path)
    }
  }),
  def({
    name: 'fit_media',
    description:
      "Make a rendition of a video or image at another aspect ratio ('9:16', '16:9', '1:1', '4:5', '3:4'). mode: crop (fill, cut edges), pad (black bars), blur (blurred background). Optionally trim videos to maxSec. Returns the new file; put it in a variant's media.",
    schema: z.object({
      path: z.string(),
      aspect: z.string(),
      mode: z.enum(['crop', 'pad', 'blur']).default('blur'),
      maxSec: z.number().optional()
    }),
    async run({ path, aspect, mode, maxSec }, { engine, mediaDir }) {
      return fit(engine.mediaTools, path, { aspect, mode, maxSec, outDir: join(mediaDir, 'renditions') })
    }
  }),
  def({
    name: 'cover_frame',
    description: 'Save one frame of a video as a JPEG cover image.',
    schema: z.object({ path: z.string(), atSec: z.number().default(1) }),
    async run({ path, atSec }, { engine, mediaDir }) {
      return { cover: await coverFrame(engine.mediaTools, path, atSec, join(mediaDir, 'covers')) }
    }
  }),
  def({
    name: 'approve_post',
    description:
      'Approve a post for publishing (now, or at publishAt). The person must confirm in Polycast unless they turned on auto-approve. Validate first.',
    schema: z.object({ postId: z.string(), publishAt: z.string().optional().describe('ISO 8601; omit to publish now') }),
    async run({ postId, publishAt }, env) {
      const s = summarizePost(env.engine, postId)
      if (!env.autoApprove()) {
        const ok = await env.requestApproval({
          title: publishAt ? `Schedule post for ${new Date(publishAt).toLocaleString()}?` : 'Publish this post now?',
          detail: `${s.title || s.body.slice(0, 80)}\n→ ${s.targets.map((t) => `${t.platform} (${t.account})`).join(', ')}`,
          source: env.source
        })
        if (!ok) return { approved: false, message: 'The person declined. Ask what to change.' }
      }
      const p = await env.engine.approve(postId, publishAt)
      env.engine.tick()
      return { approved: true, status: p.status }
    }
  }),
  def({
    name: 'cancel_post',
    description: 'Cancel queued targets of a post (already published ones are not removed from platforms).',
    schema: z.object({ postId: z.string() }),
    async run({ postId }, { engine }) {
      return { status: engine.cancel(postId).status }
    }
  }),
  def({
    name: 'list_comments',
    description: "Read recent comments on an account's posts (or one post via remoteId) where the platform allows it.",
    schema: z.object({ accountId: z.string(), remoteId: z.string().optional(), limit: z.number().int().optional() }),
    async run({ accountId, remoteId, limit }, { engine }) {
      const a = engine.mustAccount(accountId)
      const c = engine.connector(a.platform)
      if (!c.listComments) return { error: `${c.manifest.name} comments are not available through Polycast.` }
      return c.listComments(engine.makeContext(a.platform, a, a.id), a, { remoteId, limit })
    }
  }),
  def({
    name: 'reply_comment',
    description: 'Reply to a comment. The person must confirm the exact text in Polycast first.',
    schema: z.object({ accountId: z.string(), commentId: z.string(), remoteId: z.string().optional(), text: z.string().min(1) }),
    async run({ accountId, commentId, remoteId, text }, env) {
      const a = env.engine.mustAccount(accountId)
      const c = env.engine.connector(a.platform)
      if (!c.reply) return { error: `${c.manifest.name} replies are not available through Polycast.` }
      const ok = await env.requestApproval({ title: `Reply on ${c.manifest.name} as ${a.name}?`, detail: text, source: env.source })
      if (!ok) return { sent: false, message: 'The person declined.' }
      return { sent: true, ...(await c.reply(env.engine.makeContext(a.platform, a, a.id), a, { commentId, remoteId, text })) }
    }
  }),
  def({
    name: 'get_stats',
    description: 'Get view/like/comment numbers for a published target.',
    schema: z.object({ targetId: z.string() }),
    async run({ targetId }, { engine }) {
      const t = engine.store.getTarget(targetId)
      if (!t?.remoteId) return { error: 'Not published yet (no remote id).' }
      const a = engine.mustAccount(t.accountId)
      const c = engine.connector(a.platform)
      if (!c.stats) return { error: `${c.manifest.name} stats are not available.` }
      return c.stats(engine.makeContext(a.platform, a, a.id), a, t.remoteId)
    }
  }),
  def({
    name: 'recent_activity',
    description: 'Read the activity log (publishing results, errors, logins).',
    schema: z.object({ limit: z.number().int().default(30), postId: z.string().optional() }),
    async run({ limit, postId }, { engine }) {
      return engine.store.listEvents(limit, postId).map((e) => `${e.ts} ${e.level.toUpperCase()} ${e.message}`)
    }
  })
]

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name)
}

/** Validate input against the tool's schema and run it; errors come back as `{ error }`. */
export async function runTool(name: string, input: unknown, env: ToolEnv): Promise<{ ok: boolean; result: unknown }> {
  const tool = findTool(name)
  if (!tool) return { ok: false, result: { error: `Unknown tool ${name}` } }
  const parsed = tool.schema.safeParse(input ?? {})
  if (!parsed.success) return { ok: false, result: { error: `Invalid input: ${parsed.error.message}` } }
  try {
    return { ok: true, result: await tool.run(parsed.data, env) }
  } catch (e) {
    return { ok: false, result: { error: (e as Error).message } }
  }
}
