// One set of tools for every AI surface: the in-app agent and the MCP server use the same definitions,
// so anything an agent can do here, Claude Code / Claude Desktop / other MCP clients can do too.
// Tools that act on the outside world (publishing, replying) ask the user in the app first.

import { basename, join } from 'node:path'
import { z } from 'zod'
import { detectScenes, detectSilences, evenTimes, extractFrames, speechSegments } from './edit'
import type { Engine } from './engine'
import { Inbox } from './inbox'
import { coverFrame, fit, probe } from './media'
import type { Studio, Transcriber } from './studio'
import { isFiller } from '../shared/transcript'
import type { Post, Target } from '../shared/types'
import { resolveContent } from './validate'

/** Images a tool wants the model to see. Put them under this key in the result. */
export const IMAGES = '__images'
export interface ToolImage {
  path: string
  label?: string
}

/** Split a tool result into JSON-able data and images. */
export function splitImages(result: unknown): { data: unknown; images: ToolImage[] } {
  if (result && typeof result === 'object' && IMAGES in result) {
    const { [IMAGES]: images, ...data } = result as Record<string, unknown>
    return { data, images: (images as ToolImage[]) ?? [] }
  }
  return { data: result, images: [] }
}

export interface ToolEnv {
  engine: Engine
  studio?: Studio
  /** The app's Inbox (comments and stats). Tools make a throwaway one when it's missing (tests). */
  inbox?: Inbox
  /** Local speech-to-text, once it is set up. */
  speech?: Transcriber
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

/**
 * Tools may only change what the person has not approved yet. Once a post is queued, scheduled or publishing,
 * changing it would publish something they never saw: cancel it, edit, and approve again.
 */
function mustBeEditable(engine: Engine, postId: string, targetId?: string) {
  const p = engine.mustPost(postId)
  const approved = p.targets.filter((t) => (!targetId || t.id === targetId) && ['queued', 'publishing', 'scheduled'].includes(t.status))
  if (approved.length)
    throw new Error(
      `This post was already approved (${approved.map((t) => `${t.platform}: ${t.status}`).join(', ')}). Cancel it with cancel_post, change it, then ask for approval again.`
    )
}

/** Everything that decides what gets published, so an approval can be tied to exactly that. */
function contentFingerprint(engine: Engine, postId: string): string {
  const p = engine.mustPost(postId)
  return JSON.stringify([p.title, p.body, p.tags, p.media, p.aiGenerated, p.targets.map((t) => [t.id, t.status, t.variant])])
}

/** One platform's version as the person will see it in the approval card. */
function describeTarget(engine: Engine, post: Post, t: Target): string {
  const c = resolveContent(post, t)
  const name = engine.registry.has(t.platform) ? engine.connector(t.platform).manifest.name : t.platform
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
  return [
    `${name}:`,
    c.title ? `Title: ${clip(c.title, 120)}` : undefined,
    c.caption ? clip(c.caption, 400) : '(no text)',
    c.tags.length ? `Tags: ${c.tags.map((x) => `#${x}`).join(' ')}` : undefined,
    c.media.length ? `Media: ${c.media.map((m) => basename(m)).join(', ')}` : undefined,
    post.aiGenerated ? 'Labelled AI-generated' : undefined
  ]
    .filter(Boolean)
    .join('\n')
}

const inboxOf = (env: ToolEnv) => env.inbox ?? new Inbox(env.engine)

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
    description: 'List the platforms OneDraft can post to, with what each supports (video/image/text, native scheduling, comments).',
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
      'Create a DRAFT post. The person has one account per platform, so name the platforms to post to (e.g. ["youtube","rednote"]). The main title/body/tags/media apply everywhere unless a platform version overrides them. Nothing is published until approved.',
    schema: z.object({
      title: z.string().default(''),
      body: z.string().default(''),
      tags: z.array(z.string()).default([]),
      media: z.array(z.string()).default([]).describe('Absolute local file paths'),
      aiGenerated: z.boolean().default(false).describe('True if the content was made or substantially altered by AI (sets platform disclosure labels). Forced on when any media comes from generate_video.'),
      platforms: z.array(z.string()).optional().describe('Platform ids from list_accounts, e.g. youtube, rednote, bilibili, instagram, tiktok, x'),
      accountIds: z.array(z.string()).optional().describe('Alternative to platforms'),
      variants: z.array(z.object({ platform: z.string().optional(), accountId: z.string().optional(), ...variantShape })).optional().describe('Per-platform versions; give platform (or accountId)'),
      scheduledAt: z.string().optional().describe('ISO 8601 time to publish; omit for "as soon as approved"')
    }),
    async run(i, { engine }) {
      const byPlatform = (p: string) => {
        const a = engine.store.accountFor(p)
        if (!a) throw new Error(`No ${p} account is connected.`)
        return a.id
      }
      const ids = [...new Set([...(i.platforms ?? []).map(byPlatform), ...(i.accountIds ?? [])])]
      if (!ids.length) throw new Error('Name at least one platform.')
      for (const id of ids) engine.mustAccount(id)
      const vmap = new Map(
        (i.variants ?? []).map(({ platform, accountId, ...v }) => [accountId ?? (platform ? byPlatform(platform) : ''), v])
      )
      const post = engine.savePost({
        title: i.title,
        body: i.body,
        tags: i.tags,
        media: i.media,
        aiGenerated: i.aiGenerated,
        scheduledAt: i.scheduledAt,
        targets: ids.map((accountId) => ({ accountId, variant: vmap.get(accountId) ?? {} }))
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
      mustBeEditable(engine, postId)
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
      const before = engine.store.getTarget(targetId)
      if (!before) throw new Error(`Unknown target ${targetId}`)
      mustBeEditable(engine, before.postId, targetId)
      const t = engine.updateVariant(targetId, patch)
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
    async run({ path, aspect, mode, maxSec }, { engine, mediaDir, studio }) {
      // Renditions of AI-generated video stay labelled as AI-generated.
      const outDir = studio?.isAiMedia(path) ? join(studio.generatedDir, 'renditions') : join(mediaDir, 'renditions')
      return fit(engine.mediaTools, path, { aspect, mode, maxSec, outDir })
    }
  }),
  def({
    name: 'analyze_video',
    description:
      'Inspect a video before editing it: duration, size, whether it has sound, silent stretches (and the speech segments you get by cutting them out), and scene cuts. Times are seconds.',
    schema: z.object({
      path: z.string(),
      noiseDb: z.number().default(-35).describe('Quieter than this counts as silence'),
      minSilenceSec: z.number().default(0.6),
      scenes: z.boolean().default(true).describe('Detect scene cuts (slow on long videos)')
    }),
    async run({ path, noiseDb, minSilenceSec, scenes }, { engine }) {
      const info = await probe(engine.mediaTools, path)
      const duration = info.durationSec ?? 0
      const silences = info.hasAudio ? await detectSilences(engine.mediaTools, path, noiseDb, minSilenceSec) : []
      return {
        info,
        silences: silences.map((s) => ({ start: s.start, end: Number.isFinite(s.end) ? s.end : duration })),
        speechSegments: info.hasAudio ? speechSegments(duration, silences) : [],
        sceneCuts: scenes && info.kind === 'video' && duration <= 1800 ? await detectScenes(engine.mediaTools, path) : undefined
      }
    }
  }),
  def({
    name: 'view_frames',
    description:
      'Look at a video: returns still frames you can see, at evenly spaced times (count) or at the given times, labelled with their timestamps. Use it to understand what is in a clip, find the best moments and choose cut points.',
    schema: z.object({
      path: z.string(),
      count: z.number().int().min(1).max(16).default(8),
      times: z.array(z.number()).max(16).optional()
    }),
    async run({ path, count, times }, { engine, mediaDir }) {
      const info = await probe(engine.mediaTools, path)
      const ts = times?.length ? times : info.kind === 'image' ? [0] : evenTimes(info.durationSec ?? 1, count)
      const frames = await extractFrames(engine.mediaTools, path, ts, join(mediaDir, 'frames'))
      return { durationSec: info.durationSec, frames, [IMAGES]: frames.map((f) => ({ path: f.path, label: `t = ${f.t.toFixed(2)} s` })) }
    }
  }),
  def({
    name: 'transcribe_video',
    description:
      'What is said in a video or audio file, with times (local Whisper on this PC; the first run of a file takes a few seconds per minute, then it is cached). Returns sentences with their word numbers and times, filler words and long pauses; words: true adds every word as [number, text, start, end]. Cut by what is said with those word numbers in edit_video (removeWords, keepWords, removeFillers, maxPauseSec on a clip). Use the text for titles, descriptions, chapters and captions.',
    schema: z.object({
      path: z.string(),
      words: z.boolean().default(false).describe('Include every word with its number and times'),
      language: z.string().optional().describe("Spoken language like 'en' or 'zh'; default: detect")
    }),
    async run({ path, words, language }, { speech }) {
      if (!speech) return { error: 'Speech-to-text is not available here.' }
      const t = await speech.transcribe(path, { language })
      const pauses = t.words.flatMap((w, i) => (i + 1 < t.words.length && t.words[i + 1].start - w.end >= 1 ? [{ afterWord: i, seconds: Math.round((t.words[i + 1].start - w.end) * 10) / 10 }] : []))
      return {
        language: t.language,
        durationSec: t.durationSec,
        wordCount: t.words.length,
        sentences: t.segments.map((s) => ({ words: `${s.from}-${s.to - 1}`, start: s.start, end: s.end, text: s.text })),
        fillerWords: t.words.flatMap((w, i) => (isFiller(w) ? [i] : [])),
        longPauses: pauses,
        ...(words ? { words: t.words.map((w, i) => [i, w.text, w.start, w.end]) } : {})
      }
    }
  }),
  def({
    name: 'fix_transcript',
    description:
      "Correct words Whisper misheard in a file's transcript (names, places, brands, jargon), by word number from transcribe_video: [[12, 'Tofuku-ji'], ...]. Times stay the same; captions and later reads use the fixed words. Fix these before making captions.",
    schema: z.object({ path: z.string(), words: z.array(z.tuple([z.number().int().min(0), z.string().min(1)])).min(1) }),
    async run({ path, words }, { speech }) {
      if (!speech?.fixWords) return { error: 'Speech-to-text is not available here.' }
      const t = speech.fixWords(path, words)
      return { fixed: words.length, sentences: t.segments.map((s) => ({ words: `${s.from}-${s.to - 1}`, text: s.text })) }
    }
  }),
  def({
    name: 'edit_video',
    description: `Edit human-shot or existing videos into a new MP4 (the original files are never changed). Pass the whole edit as a spec; it is saved as a Studio project the person can reopen and tweak, then rendered. Spec:
- clips: [{src, in?, out?, speed?, volume?, mute?, durationSec? (images)}] played in order. Use analyze_video's speechSegments to cut silences, view_frames to choose moments.
- Cutting by what is said (needs transcribe_video's word numbers, all inclusive ranges): on a clip, removeWords: [[from, to], ...] takes those words out (retakes, mistakes, tangents); keepWords: [[from, to], ...] keeps only those words (highlights, shorts); removeFillers: true drops um/uh/嗯/呃; maxPauseSec: 0.4 shortens every longer pause. They become the clip's cuts (source seconds, also editable directly as cuts: [[start, end], ...]).
- autoCaptions: {style: highlight (word being said lights up, default) | pop (big, 2–3 words, punchy shorts) | clean | boxed, position: bottom | center | top, maxWords?} burns in captions made from what is said, timed to the finished edit (use instead of captions).
- aspect: '9:16' | '16:9' | '1:1' | '4:5' | '3:4' (default: the first clip's); fit: blur (default, blurred background) | crop | pad.
- transitionSec: crossfade between clips (0 = hard cuts).
- texts: [{text, start, end, position: top|center|bottom, size (fraction of frame height, default 0.045), color '#rrggbb', box}] — times on the OUTPUT timeline.
- captions: [{start, end, text}] burned in at the bottom (output timeline).
- music: {src, volume (default 0.25), duck (default true: lowers under speech)}; logo: {src, position, widthFraction, opacity}.
- fadeInSec, fadeOutSec, normalizeAudio (-14 LUFS), longSide (default 1920), fps (default 30).
Pass projectId to change an existing edit.`,
    schema: z.object({
      projectId: z.string().optional(),
      name: z.string().optional(),
      spec: z.object({
        clips: z
          .array(
            z.object({
              src: z.string(),
              in: z.number().optional(),
              out: z.number().optional(),
              durationSec: z.number().optional(),
              speed: z.number().optional(),
              volume: z.number().optional(),
              mute: z.boolean().optional(),
              cuts: z.array(z.tuple([z.number(), z.number()])).optional().describe('Stretches to take out, source seconds'),
              removeWords: z.array(z.tuple([z.number().int(), z.number().int()])).optional().describe('Word number ranges to take out (from transcribe_video)'),
              keepWords: z.array(z.tuple([z.number().int(), z.number().int()])).optional().describe('Keep only these word number ranges'),
              removeFillers: z.boolean().optional(),
              maxPauseSec: z.number().min(0).max(5).optional()
            })
          )
          .min(1),
        aspect: z.string().optional(),
        fit: z.enum(['crop', 'pad', 'blur']).optional(),
        longSide: z.number().optional(),
        fps: z.number().optional(),
        transitionSec: z.number().optional(),
        texts: z
          .array(
            z.object({
              text: z.string(),
              start: z.number(),
              end: z.number(),
              position: z.enum(['top', 'center', 'bottom']).optional(),
              size: z.number().optional(),
              color: z.string().optional(),
              box: z.boolean().optional()
            })
          )
          .optional(),
        captions: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).optional(),
        autoCaptions: z
          .object({
            style: z.enum(['highlight', 'pop', 'clean', 'boxed']).optional(),
            position: z.enum(['bottom', 'center', 'top']).optional(),
            maxWords: z.number().int().min(1).max(12).optional()
          })
          .optional(),
        music: z.object({ src: z.string(), volume: z.number().optional(), duck: z.boolean().optional() }).optional(),
        logo: z
          .object({
            src: z.string(),
            position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
            widthFraction: z.number().optional(),
            opacity: z.number().optional()
          })
          .optional(),
        fadeInSec: z.number().optional(),
        fadeOutSec: z.number().optional(),
        normalizeAudio: z.boolean().optional()
      })
    }),
    async run({ projectId, name, spec }, { studio }) {
      if (!studio) return { error: 'Video editing is not available here.' }
      const p = studio.saveEdit({ id: projectId, name, spec: await studio.withTranscriptCuts(spec) })
      const { project, info } = await studio.render(p.id)
      const removed = (project.spec?.clips ?? []).reduce((s, c) => s + (c.cuts ?? []).reduce((x, [a, b]) => x + b - a, 0), 0)
      return {
        projectId: project.id,
        output: project.output,
        aiGenerated: project.aiGenerated,
        durationSec: info.durationSec,
        width: info.width,
        height: info.height,
        ...(removed ? { cutSeconds: Math.round(removed * 10) / 10 } : {})
      }
    }
  }),
  def({
    name: 'generate_video',
    description: `Create an AI-generated video by writing it as HTML. OneDraft renders the page frame by frame (deterministically) into an MP4 and labels it AI-generated.
The page is sized width×height = 1080×1920 for 9:16, 1920×1080 for 16:9, 1080×1080 for 1:1, 1080×1350 for 4:5, 1080×1440 for 3:4 (also in window.ONEDRAFT {width,height,duration,fps}).
Animate with CSS @keyframes / transitions or the Web Animations API, using animation-delay to place things in time; OneDraft pauses every animation and sets its time for each frame. For canvas or JS-driven visuals define window.onedraftSeek = (t) => { draw the frame at t seconds } (may be async). Do not rely on setTimeout, setInterval or requestAnimationFrame for timing. No network: inline everything (SVG, CSS, data: URIs); local images/videos can be used as file:///C:/... URLs. System fonts: "Segoe UI", "Microsoft YaHei" (Chinese), "Segoe UI Emoji".
narration: {text, voice?, rate? (-10..10)} is spoken with a Windows voice (list_voices) and mixed in; keep it shorter than durationSec (≈ 2.5 words or 4 Chinese characters per second). music: {src, volume?}.
Pass projectId to change an existing generated video. Rendering takes about 2 s per second of 30 fps video.`,
    schema: z.object({
      projectId: z.string().optional(),
      name: z.string().optional(),
      prompt: z.string().optional().describe("The person's request, kept with the project"),
      html: z.string().min(20),
      durationSec: z.number().min(0.5).max(600),
      aspect: z.string().default('9:16'),
      fps: z.number().int().min(12).max(60).optional(),
      narration: z.object({ text: z.string(), voice: z.string().optional(), rate: z.number().optional() }).optional(),
      music: z.object({ src: z.string(), volume: z.number().optional() }).optional()
    }),
    async run({ projectId, name, prompt, html, durationSec, aspect, fps, narration, music }, { studio }) {
      if (!studio) return { error: 'Video generation is not available here.' }
      const p = studio.saveGenerated({ id: projectId, name, prompt, composition: { html, durationSec, aspect, fps, narration, music } })
      const { project, info } = await studio.render(p.id)
      return { projectId: project.id, output: project.output, aiGenerated: true, durationSec: info.durationSec, width: info.width, height: info.height, hint: 'Check it with view_frames before using it in a post.' }
    }
  }),
  def({
    name: 'list_voices',
    description: 'Windows voices available for narration (name, language, gender).',
    schema: z.object({}),
    async run(_i, { studio }) {
      return studio ? studio.voices() : []
    }
  }),
  def({
    name: 'list_projects',
    description: 'List Studio projects (video edits and generated videos) with their latest output files.',
    schema: z.object({}),
    async run(_i, { studio }) {
      return (studio?.list() ?? []).map((p) => ({ id: p.id, name: p.name, kind: p.kind, output: p.output, aiGenerated: p.aiGenerated, updatedAt: p.updatedAt }))
    }
  }),
  def({
    name: 'get_project',
    description: 'Get a Studio project with its full edit spec or HTML composition, to change and re-render it.',
    schema: z.object({ projectId: z.string() }),
    async run({ projectId }, { studio }) {
      if (!studio) return { error: 'Studio is not available here.' }
      return studio.get(projectId)
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
      'Approve a post for publishing (now, or at publishAt). The person must confirm in OneDraft unless they turned on auto-approve. Validate first.',
    schema: z.object({ postId: z.string(), publishAt: z.string().optional().describe("ISO 8601; omit to use the post's scheduledAt, or publish now if it has none") }),
    async run({ postId, publishAt }, env) {
      const { engine } = env
      const post = engine.mustPost(postId)
      // The post's own time counts when no other is given (create_post documents scheduledAt as the publish time).
      const future = post.scheduledAt && new Date(post.scheduledAt).getTime() > Date.now() ? post.scheduledAt : undefined
      const when = publishAt ?? future
      if (when && Number.isNaN(new Date(when).getTime())) throw new Error(`Bad publish time "${when}"`)
      const pending = post.targets.filter((t) => t.status === 'draft' || t.status === 'canceled')
      if (!pending.length) throw new Error('Nothing to approve: every platform on this post was already approved or sent.')
      if (!env.autoApprove()) {
        // Show exactly what each platform gets, and approve only that: if the post changes while the card is open,
        // the approval no longer applies.
        const fingerprint = contentFingerprint(engine, postId)
        const ok = await env.requestApproval({
          title: when ? `Schedule this post for ${new Date(when).toLocaleString()}?` : 'Publish this post now?',
          detail: pending.map((t) => describeTarget(engine, post, t)).join('\n\n'),
          source: env.source
        })
        if (!ok) return { approved: false, message: 'The person declined. Ask what to change.' }
        if (contentFingerprint(engine, postId) !== fingerprint)
          return { approved: false, message: 'The post changed while the person was looking at it, so the approval does not apply. Ask again.' }
      }
      const p = await engine.approve(postId, when)
      engine.tick()
      return { approved: true, status: p.status, publishAt: when ?? 'now' }
    }
  }),
  def({
    name: 'cancel_post',
    description: 'Cancel queued targets of a post (already published ones are not removed from platforms).',
    schema: z.object({ postId: z.string() }),
    async run({ postId }, { engine }) {
      const p = engine.cancel(postId)
      const held = engine.heldByPlatform(p)
      return {
        status: p.status,
        ...(held.length
          ? { note: `Already scheduled on ${held.map((t) => t.platform).join(', ')} itself; OneDraft cannot take those back. Remove them on the platform.` }
          : {})
      }
    }
  }),
  def({
    name: 'list_inbox',
    description:
      "Comments waiting in the person's OneDraft Inbox (already fetched from the platforms), newest first: who wrote what, on which post, and any draft reply. state 'open' = still to answer.",
    schema: z.object({
      state: z.enum(['open', 'done', 'replied', 'all']).default('open'),
      platform: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(30)
    }),
    async run({ state, platform, limit }, { engine }) {
      const accounts = new Map(engine.store.listAccounts().map((a) => [a.id, a]))
      return engine.store
        .listComments({ state: state === 'all' ? undefined : state, limit: platform ? 500 : limit })
        .filter((c) => !platform || c.platform === platform)
        .slice(0, limit)
        .map((c) => {
          const post = c.postId ? engine.store.getPost(c.postId) : undefined
          return {
            accountId: c.accountId,
            commentId: c.id,
            platform: c.platform,
            account: accounts.get(c.accountId)?.name,
            author: c.author,
            text: c.text,
            publishedAt: c.publishedAt,
            onPost: post ? post.title || post.body.slice(0, 80) : c.postRemoteId ? `a post outside OneDraft (${c.postRemoteId})` : undefined,
            state: c.state,
            draft: c.draft,
            reply: c.reply?.text
          }
        })
    }
  }),
  def({
    name: 'list_comments',
    description: "Read recent comments on an account's posts (or one post via remoteId) live from the platform, where it allows it. They are added to the Inbox.",
    schema: z.object({ accountId: z.string(), remoteId: z.string().optional(), limit: z.number().int().optional() }),
    async run({ accountId, remoteId, limit }, env) {
      const { engine } = env
      const a = engine.mustAccount(accountId)
      const c = engine.connector(a.platform)
      if (!c.listComments) return { error: `${c.manifest.name} comments are not available through OneDraft.` }
      const list = (await c.listComments(engine.makeContext(a.platform, a, a.id), a, { remoteId, limit })) ?? []
      inboxOf(env).save(a, list.map((x) => ({ ...x, postRemoteId: x.postRemoteId ?? remoteId })))
      return list
    }
  }),
  def({
    name: 'draft_reply',
    description:
      "Save a suggested reply to a comment in the person's Inbox WITHOUT sending it. They read it, change it if they like, and send it from the Inbox. Use this whenever you are asked to draft or suggest replies.",
    schema: z.object({ accountId: z.string(), commentId: z.string(), text: z.string().min(1) }),
    async run({ accountId, commentId, text }, { engine }) {
      const key = `${accountId}:${commentId}`
      const comment = engine.store.getComment(key)
      if (!comment) throw new Error('That comment is not in the Inbox. Find it with list_inbox (or list_comments first).')
      engine.store.setCommentDraft(key, text, 'claude')
      return { saved: true, note: 'The person sends it from the Inbox.' }
    }
  }),
  def({
    name: 'reply_comment',
    description: 'Send a reply to a comment now. The person must confirm the exact text in OneDraft first. To only suggest a reply, use draft_reply.',
    schema: z.object({ accountId: z.string(), commentId: z.string(), remoteId: z.string().optional(), text: z.string().min(1) }),
    async run({ accountId, commentId, remoteId, text }, env) {
      const a = env.engine.mustAccount(accountId)
      const c = env.engine.connector(a.platform)
      if (!c.reply) return { error: `${c.manifest.name} replies are not available through OneDraft.` }
      const ok = await env.requestApproval({ title: `Reply on ${c.manifest.name} as ${a.name}?`, detail: text, source: env.source })
      if (!ok) return { sent: false, message: 'The person declined.' }
      // A comment in the Inbox gets marked as answered there.
      const key = `${accountId}:${commentId}`
      if (env.engine.store.getComment(key)) return { sent: true, id: (await inboxOf(env).reply(key, text)).reply?.id }
      return { sent: true, ...(await c.reply(env.engine.makeContext(a.platform, a, a.id), a, { commentId, remoteId, text })) }
    }
  }),
  def({
    name: 'get_stats',
    description: 'Get fresh numbers for a published target: views, likes, comments, shares, saves, plus platform extras (coins, quotes, reach).',
    schema: z.object({ targetId: z.string() }),
    async run({ targetId }, env) {
      const t = env.engine.store.getTarget(targetId)
      if (!t) throw new Error(`Unknown target ${targetId}`)
      if (!t.remoteId) return { error: 'Not published yet (no remote id).' }
      const inbox = inboxOf(env)
      if (!inbox.hasStats(t)) {
        const name = env.engine.registry.has(t.platform) ? env.engine.connector(t.platform).manifest.name : t.platform
        return { error: t.status === 'scheduled' ? 'Not live yet: it is scheduled on the platform.' : `${name} stats are not available.` }
      }
      await inbox.refreshStats([targetId])
      const s = env.engine.store.getStats(targetId)
      if (!s) return { error: 'No numbers yet; try again in a moment.' }
      if (s.error) return { error: s.error, ...(Object.keys(s.metrics).length ? { lastKnown: s.metrics, lastFetchedAt: s.fetchedAt } : {}) }
      return { ...s.metrics, fetchedAt: s.fetchedAt }
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
