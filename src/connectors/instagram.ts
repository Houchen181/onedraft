// Instagram via the official Instagram Platform (Instagram Login, graph.instagram.com).
// Personal setup: paste a token generated in the Meta app dashboard. Reels upload straight from disk
// (resumable); images need a public URL, which comes from the optional media host (Settings).

import { ContentError, NeedsLoginError, RetryableError, UnconfirmedError, type Connector, type ConnectorContext } from '../core/connector'
import { check, getJson, HttpError, sleep } from '../core/http'
import { MediaHost } from '../core/mediahost'
import { captionWithHashtags } from '../core/validate'
import type { Comment } from '../shared/types'
import { body, fileSize, isVideo, readChunk } from './util'

interface IgSecret {
  accessToken: string
  obtainedAt: number
  expiresAt?: number
}

const ver = (ctx: ConnectorContext) => ctx.setting('graphVersion') || 'v27.0'
const base = (ctx: ConnectorContext) => `https://graph.instagram.com/${ver(ctx)}`

async function token(ctx: ConnectorContext): Promise<string> {
  const s = ctx.secrets.get<IgSecret>()
  if (!s?.accessToken) throw new NeedsLoginError()
  const day = 86_400_000
  // Long-lived tokens last ~60 days and can be refreshed once they are a day old.
  if (Date.now() - s.obtainedAt > day && (!s.expiresAt || s.expiresAt - Date.now() < 30 * day)) {
    try {
      const r = await getJson<{ access_token: string; expires_in: number }>(
        ctx.fetch,
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(s.accessToken)}`,
        {},
        'Refresh Instagram token'
      )
      ctx.secrets.set({ accessToken: r.access_token, obtainedAt: Date.now(), expiresAt: Date.now() + r.expires_in * 1000 } satisfies IgSecret)
      return r.access_token
    } catch (e) {
      if (s.expiresAt && s.expiresAt < Date.now()) throw new NeedsLoginError('Instagram token expired; generate a new one.')
      ctx.log(`Instagram token refresh failed: ${(e as Error).message}`, 'warn')
    }
  }
  return s.accessToken
}

async function graph<T>(ctx: ConnectorContext, path: string, params: Record<string, string | undefined> = {}, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v)
  q.set('access_token', await token(ctx))
  const url = `${base(ctx)}${path}?${q}`
  try {
    return await getJson<T>(ctx.fetch, url, { method }, 'Instagram')
  } catch (e) {
    if (e instanceof HttpError) {
      const err = (() => {
        try {
          return (JSON.parse(e.body) as { error?: { code?: number; message?: string; error_user_msg?: string } }).error
        } catch {
          return undefined
        }
      })()
      if (err?.code === 190) throw new NeedsLoginError(`Instagram token is no longer valid: ${err.message}`)
      if (err?.code === 4 || err?.code === 17 || err?.code === 32 || err?.code === 613) throw new RetryableError(`Instagram rate limit: ${err.message}`, 1800)
      throw new ContentError(err?.error_user_msg ?? err?.message ?? e.message)
    }
    throw e
  }
}

async function waitContainer(ctx: ConnectorContext, id: string, maxMs: number) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const s = await graph<{ status_code: string; status?: string }>(ctx, `/${id}`, { fields: 'status_code,status' })
    if (s.status_code === 'FINISHED' || s.status_code === 'PUBLISHED') return
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new ContentError(`Instagram could not process the media: ${s.status ?? s.status_code}`)
    await sleep(8000, ctx.signal)
  }
  throw new RetryableError('Instagram is taking too long to process the media.', 600)
}

/** Create a video container and upload the file directly (resumable), falling back to the media host. */
async function videoContainer(
  ctx: ConnectorContext,
  igId: string,
  path: string,
  params: Record<string, string | undefined>,
  host: MediaHost | undefined,
  hosted: string[]
): Promise<string> {
  try {
    const c = await graph<{ id: string; uri?: string }>(ctx, `/${igId}/media`, { ...params, upload_type: 'resumable' }, 'POST')
    const size = fileSize(path)
    const uri = c.uri ?? `https://rupload.facebook.com/ig-api-upload/${ver(ctx)}/${c.id}`
    await check(
      await ctx.fetch(uri, {
        method: 'POST',
        headers: { authorization: `OAuth ${await token(ctx)}`, offset: '0', file_size: String(size) },
        body: body(readChunk(path, 0, size)),
        signal: ctx.signal
      }),
      'Instagram video upload'
    )
    return c.id
  } catch (e) {
    if (!host) {
      throw new ContentError(
        `Instagram would not take a direct video upload (${(e as Error).message.slice(0, 200)}). Set up a public media host in Settings so Instagram can fetch the file.`
      )
    }
    ctx.log(`Direct upload refused, using the media host: ${(e as Error).message.slice(0, 200)}`, 'warn')
    const h = await host.put(path)
    hosted.push(h.key)
    const c = await graph<{ id: string }>(ctx, `/${igId}/media`, { ...params, video_url: h.url }, 'POST')
    return c.id
  }
}

export const instagram: Connector = {
  manifest: {
    id: 'instagram',
    name: 'Instagram',
    kind: 'api',
    color: '#e1306c',
    source: 'builtin',
    docsUrl: 'https://developers.facebook.com/docs/instagram-platform/content-publishing',
    capabilities: { video: true, image: true, text: false, nativeSchedule: false, comments: true, reply: true, stats: true },
    constraints: {
      caption: { max: 2200 },
      tags: { style: 'hashtags', max: 30 },
      video: { minSec: 3, maxSec: 900, maxBytes: 300e6, preferredAspect: '9:16', formats: ['mp4', 'mov'] },
      image: { maxCount: 20, maxBytes: 8e6, formats: ['jpg', 'jpeg'], preferredAspect: '4:5' },
      media: { required: true, mixed: false, maxVideos: 1 }
    },
    settings: [
      { key: 'graphVersion', label: 'Graph API version', type: 'text', default: 'v27.0' }
    ],
    connectFields: [
      {
        key: 'accessToken',
        label: 'Access token',
        type: 'secret',
        required: true,
        help: 'developers.facebook.com → your app (type Business) → Instagram → "API setup with Instagram login" → Generate token for your Business/Creator account.'
      }
    ],
    options: [
      {
        key: 'format',
        label: 'Post as',
        type: 'select',
        default: 'post',
        options: [
          { value: 'post', label: 'Feed post / Reel' },
          { value: 'story', label: 'Story' }
        ]
      },
      { key: 'shareToFeed', label: 'Also show Reel in the feed', type: 'boolean', default: true },
      { key: 'coverAtSec', label: 'Reel cover frame (seconds)', type: 'number', default: 0 }
    ],
    notes: [
      'Needs an Instagram Business or Creator account.',
      'Images (and videos, if direct upload is refused) need a public media host: set one up in Settings.',
      'Instagram has no scheduling API: scheduled posts need Polycast running at the publish time.',
      'About 100 API posts per 24 hours.'
    ]
  },

  async connect(ctx, input) {
    const accessToken = input.accessToken.trim()
    ctx.secrets.set({ accessToken, obtainedAt: Date.now() } satisfies IgSecret)
    const me = await graph<{ user_id?: string; id: string; username: string; name?: string; profile_picture_url?: string; account_type?: string }>(ctx, '/me', {
      fields: 'user_id,username,name,profile_picture_url,account_type'
    })
    if (me.account_type && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(me.account_type))
      throw new Error(`@${me.username} is a ${me.account_type} account; switch it to Business or Creator in the Instagram app.`)
    const igId = me.user_id ?? me.id
    return {
      name: me.name || me.username,
      handle: `@${me.username}`,
      avatarUrl: me.profile_picture_url,
      remoteUserId: igId,
      meta: { igId, username: me.username }
    }
  },

  async check(ctx) {
    const me = await graph<{ username: string }>(ctx, '/me', { fields: 'username' })
    return { ok: true, name: me.username }
  },

  async publish(ctx, account, { content }) {
    const igId = account.meta.igId as string
    const host = MediaHost.fromSettings((k) => ctx.globalSetting(k), ctx.fetch)
    const hosted: string[] = []
    const story = content.options.format === 'story'
    const caption = story ? undefined : captionWithHashtags(content.caption, content.tags)
    const ai = content.aiGenerated ? 'true' : undefined
    const videos = content.media.filter(isVideo)
    const images = content.media.filter((m) => !isVideo(m))
    const needHost = () => {
      if (!host) throw new ContentError('Instagram fetches images from a public URL. Set up a public media host in Settings (any S3-compatible bucket, e.g. Cloudflare R2).')
      return host
    }
    try {
      let creationId: string
      if (videos.length) {
        creationId = await videoContainer(
          ctx,
          igId,
          videos[0],
          {
            media_type: story ? 'STORIES' : 'REELS',
            caption,
            share_to_feed: story ? undefined : String(content.options.shareToFeed !== false),
            thumb_offset: content.options.coverAtSec ? String(Math.round(Number(content.options.coverAtSec) * 1000)) : undefined,
            is_ai_generated: ai
          },
          host,
          hosted
        )
        ctx.progress(0.6, 'Instagram is processing the video')
        await waitContainer(ctx, creationId, 15 * 60_000)
      } else if (images.length === 1 || story) {
        const h = await needHost().put(images[0])
        hosted.push(h.key)
        const c = await graph<{ id: string }>(
          ctx,
          `/${igId}/media`,
          { image_url: h.url, caption, media_type: story ? 'STORIES' : undefined, is_ai_generated: ai },
          'POST'
        )
        creationId = c.id
        await waitContainer(ctx, creationId, 3 * 60_000)
      } else {
        const children: string[] = []
        for (const [i, im] of images.entries()) {
          const h = await needHost().put(im)
          hosted.push(h.key)
          const c = await graph<{ id: string }>(ctx, `/${igId}/media`, { image_url: h.url, is_carousel_item: 'true' }, 'POST')
          children.push(c.id)
          ctx.progress((i + 1) / (images.length + 1), 'Preparing carousel')
        }
        for (const id of children) await waitContainer(ctx, id, 3 * 60_000)
        const parent = await graph<{ id: string }>(
          ctx,
          `/${igId}/media`,
          { media_type: 'CAROUSEL', children: children.join(','), caption, is_ai_generated: ai },
          'POST'
        )
        creationId = parent.id
        await waitContainer(ctx, creationId, 3 * 60_000)
      }

      let mediaId: string
      try {
        mediaId = (await graph<{ id: string }>(ctx, `/${igId}/media_publish`, { creation_id: creationId }, 'POST')).id
      } catch (e) {
        if (e instanceof ContentError) throw e
        throw new UnconfirmedError(`Instagram publish call failed after the media was ready: ${(e as Error).message}`, creationId)
      }
      const link = await graph<{ permalink?: string }>(ctx, `/${mediaId}`, { fields: 'permalink' }).catch(() => ({ permalink: undefined }))
      return { remoteId: mediaId, url: link.permalink, state: 'published' }
    } finally {
      for (const key of hosted) await host?.remove(key)
    }
  },

  async listComments(ctx, account, { remoteId, limit = 50 }) {
    const mediaIds = remoteId
      ? [remoteId]
      : (await graph<{ data: { id: string }[] }>(ctx, `/${account.meta.igId as string}/media`, { fields: 'id', limit: '5' })).data.map((m) => m.id)
    const out: Comment[] = []
    for (const id of mediaIds) {
      const r = await graph<{ data: { id: string; text: string; username?: string; timestamp?: string; like_count?: number }[] }>(ctx, `/${id}/comments`, {
        fields: 'id,text,username,timestamp,like_count',
        limit: String(Math.min(50, limit))
      })
      out.push(...r.data.map((c) => ({ id: c.id, author: c.username ?? 'someone', text: c.text, publishedAt: c.timestamp, likeCount: c.like_count, postRemoteId: id })))
    }
    return out.slice(0, limit)
  },

  async reply(ctx, _account, { commentId, text }) {
    const r = await graph<{ id: string }>(ctx, `/${commentId}/replies`, { message: text }, 'POST')
    return { id: r.id }
  },

  async stats(ctx, _account, remoteId) {
    const r = await graph<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(ctx, `/${remoteId}/insights`, {
      metric: 'views,reach,likes,comments,shares,saved,total_interactions'
    })
    return Object.fromEntries(r.data.map((m) => [m.name, m.total_value?.value ?? m.values?.[0]?.value ?? 0]))
  }
}
