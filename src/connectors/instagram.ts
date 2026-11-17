// Instagram via the official Instagram Platform (Instagram Login, graph.instagram.com).
// Personal setup: paste a token generated in the Meta app dashboard. Reels upload straight from disk
// (resumable); images need a public URL, which comes from the optional media host (Settings).

import { ContentError, NeedsLoginError, RetryableError, UnconfirmedError, type Connector, type ConnectorContext } from '../core/connector'
import { check, getJson, HttpError, sleep } from '../core/http'
import { MediaHost } from '../core/mediahost'
import { captionWithHashtags } from '../core/validate'
import type { Comment } from '../shared/types'
import { body, explain, fileSize, isVideo, readChunk } from './util'
import { isWeb, WEB_SELECTOR_SETTING, webCheck, webConnect, webDisconnect, webIssues, webManifest, webPublish } from './web'

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
  // Creating the container can fail for real reasons (login, rate limit, caption): let those through as they are.
  const c = await graph<{ id: string; uri?: string }>(ctx, `/${igId}/media`, { ...params, upload_type: 'resumable' }, 'POST')
  try {
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
    // Only a refused direct upload (a 4xx from rupload) falls back to the media host.
    if (!(e instanceof HttpError)) throw e
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
    settings: [{ key: 'graphVersion', label: 'Graph API version', type: 'text', default: 'v27.0' }, WEB_SELECTOR_SETTING],
    web: webManifest('instagram', ['Photo posts work without a media host this way.'], ['format'], {
      image: { maxCount: 10, maxBytes: undefined, formats: ['jpg', 'jpeg', 'png', 'webp'], preferredAspect: '4:5' },
      media: { required: true, mixed: true, maxVideos: 10 }
    }),
    connectFields: [
      {
        key: 'accessToken',
        label: 'Access token',
        type: 'secret',
        required: true,
        placeholder: 'IGAA…',
        pattern: '^IG\\w{20,}$',
        mismatch:
          'Tokens for Instagram login start with “IG”. One starting with “EAA” is a Facebook token: make it under API setup with Instagram login instead (step 5).'
      }
    ],
    signIn: 'OneDraft checks the token you pasted with Instagram and shows which account it belongs to. Nothing opens.',
    guide: {
      why: 'Instagram only lets apps post through its API, and every app needs its own key. You make a developer app of your own on Meta for Developers, once, and copy the access token it gives you for your account. It’s free.',
      warning:
        'Meta stopped offering this setup to apps created after late October 2026. If your app shows “API setup with Instagram login is not available for newer apps”, OneDraft can’t connect it yet. An app you made earlier still works.',
      need: [
        'An Instagram professional account (Business or Creator). To switch, in the Instagram app: your profile → ☰ → Settings and activity → Account type and tools → Switch to professional account.',
        'A Facebook account, to sign in to Meta for Developers'
      ],
      time: 'about 15 minutes',
      steps: [
        {
          text: 'Register as a Meta developer: sign in with Facebook, press **Next**, type the codes Meta sends to your phone and email, and pick an occupation.',
          link: { label: 'Open Meta developer registration', url: 'https://developers.facebook.com/async/registration' }
        },
        {
          text: 'Make the app: App name **OneDraft** and your email, **Next**. Use case **Manage messaging & content on Instagram**, **Next**. Business: **I don’t want to connect a business portfolio yet**, **Next**. Then **Next** and **Go to dashboard**.',
          link: { label: 'Open “Create app”', url: 'https://developers.facebook.com/apps/creation/' },
          copy: [{ label: 'App name', value: 'OneDraft' }]
        },
        {
          text: 'In the dashboard open **Use cases** → **Manage messaging & content on Instagram** → **Customize** → **API setup with Instagram login**. Press **Add all required permissions**. Then under **Permissions and features** add **instagram_business_content_publish**, **instagram_business_manage_comments** and **instagram_business_manage_insights**.',
          detail: 'Add these before you make the token: a token made earlier doesn’t get them.'
        },
        {
          text: 'Under **Generate access tokens** press **Add account**, then **Continue**. Sign in to Instagram in the window that opens, then **Save** and **Got it**.',
          detail:
            'If it says “Insufficient developer role”: open App roles → Roles and add your Instagram username as an Instagram Tester. On instagram.com open More → Settings → Website permissions → Apps and websites → Tester invites and press Accept. Then press Add account again.'
        },
        {
          text: 'Press **Generate token** next to your account, allow access, and copy the token straight away: Meta shows it only once. Paste it below. It starts with **IG**.',
          fields: ['accessToken']
        }
      ],
      trouble: [
        {
          problem: '“API setup with Instagram login is not available for newer apps”',
          fix: 'Meta gives apps created after late October 2026 a different setup (“Unified login”), which OneDraft can’t use yet. If you made a Meta app before then, use that app.'
        },
        { problem: 'The token starts with EAA', fix: 'That’s a Facebook token (Facebook login setup or Graph API Explorer). Make the token under API setup with Instagram login (step 5).' },
        {
          problem: '“account type is not business or creator”, or “is a PERSONAL account”',
          fix: 'Switch the Instagram account to a professional account (Business or Creator) in the Instagram app, then make a new token.'
        },
        {
          problem: '“Insufficient developer role”',
          fix: 'Add your Instagram username as an Instagram Tester (App roles → Roles) and accept the invite on instagram.com (Settings → Website permissions → Apps and websites → Tester invites). The browser must be signed in to that same Instagram account.'
        },
        { problem: 'Posting fails with a permission error', fix: 'The token was made before the permissions in step 3 were added. Make a new token and press Connect again with it.' }
      ]
    },
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
      'Photo posts (and videos, if Instagram refuses the direct upload) also need a public media host: Settings → Media host.',
      'The token lasts 60 days; OneDraft renews it while you use it. If it runs out, make a new one (step 5) and press Connect.',
      'Instagram has no scheduling API: scheduled posts need OneDraft running at the publish time.',
      'About 100 API posts per 24 hours.'
    ]
  },

  validate(content, account) {
    return account && isWeb(account) ? webIssues('instagram', content) : []
  },

  async connect(ctx, input) {
    if (input.method === 'web' || (!input.method && input._profileKey)) return webConnect('instagram', ctx, input)
    const accessToken = (input.accessToken ?? '').trim()
    if (!accessToken) throw new Error('Paste the access token first (step 5).')
    ctx.secrets.set({ accessToken, obtainedAt: Date.now() } satisfies IgSecret)
    const me = await graph<{ user_id?: string; id: string; username: string; name?: string; profile_picture_url?: string; account_type?: string }>(ctx, '/me', {
      fields: 'user_id,username,name,profile_picture_url,account_type'
    }).catch((e) => {
      throw explain(e, {
        'Cannot parse access token':
          'Instagram didn’t accept this token. Copy it again, all of it (it starts with IG), or make a new one under API setup with Instagram login.',
        'no longer valid': 'Instagram says this token has expired or was revoked. Make a new one under API setup with Instagram login (step 5) and paste it.'
      })
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

  async check(ctx, account) {
    if (isWeb(account)) return webCheck('instagram', ctx, account)
    const me = await graph<{ username: string }>(ctx, '/me', { fields: 'username' })
    return { ok: true, name: me.username }
  },

  async publish(ctx, account, req) {
    if (isWeb(account)) return webPublish('instagram', ctx, account, req)
    const { content } = req
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
      const me = account.meta.username as string | undefined
      out.push(
        ...r.data.map((c) => ({
          id: c.id,
          author: c.username ?? 'someone',
          text: c.text,
          publishedAt: c.timestamp,
          likeCount: c.like_count,
          postRemoteId: id,
          mine: !!me && c.username === me
        }))
      )
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
  },

  async disconnect(ctx, account) {
    if (isWeb(account)) await webDisconnect(ctx, account)
  }
}
