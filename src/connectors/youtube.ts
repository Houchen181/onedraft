// YouTube via the official Data API v3: resumable upload, native scheduling, comments, stats.

import {
  NeedsLoginError,
  RetryableError,
  UnconfirmedError,
  type Connector,
  type ConnectorContext
} from '../core/connector'
import { check, expiresSoon, form, getJson, HttpError, secondsToPacificMidnight, sleep, type OAuthTokens } from '../core/http'
import type { Account, Comment } from '../shared/types'
import { body, fileSize, mimeOf, readChunk, requireSetting } from './util'

const API = 'https://www.googleapis.com/youtube/v3'
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3'
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/yt-analytics.readonly'
]
const CHUNK = 64 * 256 * 1024 // 16 MiB, a multiple of 256 KiB as required

const CATEGORIES: [string, string][] = [
  ['22', 'People & Blogs'],
  ['28', 'Science & Technology'],
  ['27', 'Education'],
  ['24', 'Entertainment'],
  ['10', 'Music'],
  ['20', 'Gaming'],
  ['26', 'Howto & Style'],
  ['25', 'News & Politics'],
  ['17', 'Sports'],
  ['19', 'Travel & Events'],
  ['1', 'Film & Animation'],
  ['2', 'Autos & Vehicles'],
  ['15', 'Pets & Animals'],
  ['23', 'Comedy'],
  ['29', 'Nonprofits & Activism']
]

/** YouTube rejects < and > in titles and descriptions. */
const clean = (s: string) => s.replace(/</g, '‹').replace(/>/g, '›')

async function accessToken(ctx: ConnectorContext): Promise<string> {
  const t = ctx.secrets.get<OAuthTokens>()
  if (!t?.accessToken) throw new NeedsLoginError()
  if (!expiresSoon(t)) return t.accessToken
  if (!t.refreshToken) throw new NeedsLoginError()
  const res = await ctx.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: form({
      client_id: requireSetting(ctx.setting, 'clientId', 'the YouTube OAuth client ID'),
      client_secret: ctx.setting('clientSecret'),
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken
    })
  })
  if (res.status === 400 || res.status === 401) {
    throw new NeedsLoginError(
      'Google refused the saved login (expired or revoked). If your OAuth app is in "Testing", Google expires logins after 7 days.'
    )
  }
  const j = (await (await check(res, 'Refresh YouTube token')).json()) as { access_token: string; expires_in: number }
  const next = { ...t, accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 }
  ctx.secrets.set(next)
  return next.accessToken
}

async function api<T>(ctx: ConnectorContext, path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(ctx)
  return getJson<T>(
    ctx.fetch,
    path.startsWith('http') ? path : `${API}${path}`,
    { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } },
    'YouTube'
  )
}

interface Channel {
  id: string
  snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } }
}

export const youtube: Connector = {
  manifest: {
    id: 'youtube',
    name: 'YouTube',
    kind: 'api',
    color: '#ff0033',
    source: 'builtin',
    docsUrl: 'https://developers.google.com/youtube/v3/guides/uploading_a_video',
    capabilities: {
      video: true,
      image: false,
      text: false,
      nativeSchedule: true,
      scheduleWindow: { minSec: 0, maxSec: 5 * 365 * 86400 },
      comments: true,
      reply: true,
      stats: true
    },
    constraints: {
      title: { required: true, max: 100 },
      caption: { max: 5000, unit: 'bytes' },
      tags: { style: 'field', maxTotalChars: 500 },
      video: { maxBytes: 256e9, preferredAspect: undefined },
      media: { required: true, maxVideos: 1 }
    },
    settings: [
      {
        key: 'clientId',
        label: 'OAuth client ID',
        type: 'text',
        required: true,
        help: 'Google Cloud console → APIs & Services → Credentials → Create OAuth client → "Desktop app". Enable "YouTube Data API v3" first.'
      },
      { key: 'clientSecret', label: 'OAuth client secret', type: 'secret', help: 'Shown with the client ID. Desktop-app secrets are not confidential.' }
    ],
    connectFields: [],
    options: [
      {
        key: 'privacy',
        label: 'Visibility',
        type: 'select',
        default: 'public',
        options: [
          { value: 'public', label: 'Public' },
          { value: 'unlisted', label: 'Unlisted' },
          { value: 'private', label: 'Private' }
        ],
        help: 'Scheduled videos stay private until the publish time, then become public.'
      },
      { key: 'categoryId', label: 'Category', type: 'select', default: '22', options: CATEGORIES.map(([value, label]) => ({ value, label })) },
      { key: 'madeForKids', label: 'Made for kids', type: 'boolean', default: false },
      { key: 'notifySubscribers', label: 'Notify subscribers', type: 'boolean', default: true }
    ],
    notes: [
      'Uses your own Google Cloud OAuth client. While the app is in "Testing", Google expires the login every 7 days.',
      'Quota: 100 uploads a day per Google Cloud project.',
      'Vertical videos up to 3 minutes are published as Shorts automatically.'
    ]
  },

  async connect(ctx) {
    const clientId = requireSetting(ctx.setting, 'clientId', 'the YouTube OAuth client ID')
    const r = await ctx.oauthLoopback({
      authorizeUrl: ({ redirectUri, state, codeChallenge }) =>
        'https://accounts.google.com/o/oauth2/v2/auth?' +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES.join(' '),
          state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent'
        })
    })
    const tok = await getJson<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>(
      ctx.fetch,
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        body: form({
          client_id: clientId,
          client_secret: ctx.setting('clientSecret'),
          code: r.code,
          code_verifier: r.codeVerifier,
          grant_type: 'authorization_code',
          redirect_uri: r.redirectUri
        })
      },
      'Google token exchange'
    )
    ctx.secrets.set({
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
      scope: tok.scope
    } satisfies OAuthTokens)
    const ch = await api<{ items?: Channel[] }>(ctx, '/channels?part=snippet&mine=true')
    const c = ch.items?.[0]
    if (!c) throw new Error('This Google account has no YouTube channel. Create one at youtube.com first.')
    return {
      name: c.snippet.title,
      handle: c.snippet.customUrl,
      avatarUrl: c.snippet.thumbnails?.default?.url,
      remoteUserId: c.id,
      meta: { channelId: c.id }
    }
  },

  async check(ctx) {
    const ch = await api<{ items?: Channel[] }>(ctx, '/channels?part=snippet&mine=true')
    return { ok: !!ch.items?.length, name: ch.items?.[0]?.snippet.title }
  },

  async publish(ctx, _account, { content, publishAt }) {
    const file = content.media[0]
    const size = fileSize(file)
    const privacy = publishAt ? 'private' : String(content.options.privacy ?? 'public')
    const resource = {
      snippet: {
        title: clean(content.title).slice(0, 100),
        description: clean(content.caption),
        tags: content.tags,
        categoryId: String(content.options.categoryId ?? '22')
      },
      status: {
        privacyStatus: privacy,
        ...(publishAt ? { publishAt: new Date(publishAt).toISOString() } : {}),
        selfDeclaredMadeForKids: Boolean(content.options.madeForKids),
        containsSyntheticMedia: content.aiGenerated
      }
    }
    const notify = content.options.notifySubscribers === false ? 'false' : 'true'
    const token = await accessToken(ctx)
    const init = await checkQuota(
      await ctx.fetch(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${notify}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(size),
          'x-upload-content-type': mimeOf(file).startsWith('video/') ? mimeOf(file) : 'application/octet-stream'
        },
        body: JSON.stringify(resource)
      }),
      'Start YouTube upload'
    )
    const session = init.headers.get('location')
    if (!session) throw new RetryableError('YouTube did not return an upload session.')

    let offset = 0
    let video: { id: string } | undefined
    let failures = 0
    while (!video) {
      const end = Math.min(offset + CHUNK, size) - 1
      let res: Response
      try {
        res = await ctx.fetch(session, {
          method: 'PUT',
          headers: { authorization: `Bearer ${await accessToken(ctx)}`, 'content-range': `bytes ${offset}-${end}/${size}` },
          body: body(readChunk(file, offset, end - offset + 1)),
          signal: ctx.signal
        })
      } catch (e) {
        if (ctx.signal.aborted) throw e
        res = await resumeStatus(ctx, session, size, ++failures, end === size - 1)
      }
      if (res.status === 308) {
        const range = res.headers.get('range')
        offset = range ? Number(range.split('-')[1]) + 1 : 0
        ctx.progress(offset / size, 'Uploading to YouTube')
        continue
      }
      if (res.status === 200 || res.status === 201) {
        video = (await res.json()) as { id: string }
        break
      }
      if (res.status === 404) throw new RetryableError('YouTube upload session expired; will start over.', 60)
      if (res.status >= 500) {
        // Ask where the upload stands, through further server errors. resumeStatus gives up after 6 tries,
        // as unconfirmed if the last byte was sent (YouTube may have finished the video).
        while (res.status >= 500) res = await resumeStatus(ctx, session, size, ++failures, end === size - 1)
        if (res.status === 308) {
          const range = res.headers.get('range')
          offset = range ? Number(range.split('-')[1]) + 1 : 0
          continue
        }
        if (res.status === 200 || res.status === 201) {
          video = (await res.json()) as { id: string }
          break
        }
      }
      await check(res, 'YouTube upload')
    }
    ctx.progress(1, 'Uploaded')

    let note: string | undefined
    if (content.cover) {
      try {
        await check(
          await ctx.fetch(`${UPLOAD}/thumbnails/set?videoId=${video.id}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${await accessToken(ctx)}`, 'content-type': mimeOf(content.cover) },
            body: body(readChunk(content.cover, 0, fileSize(content.cover)))
          }),
          'Set thumbnail'
        )
      } catch (e) {
        note = `Video is up, but the thumbnail failed: ${(e as Error).message.slice(0, 200)}`
      }
    }
    return {
      remoteId: video.id,
      url: `https://www.youtube.com/watch?v=${video.id}`,
      state: publishAt ? 'scheduled' : 'published',
      note
    }
  },

  async listComments(ctx, account, { remoteId, limit = 50 }) {
    const q = remoteId ? `videoId=${remoteId}` : `allThreadsRelatedToChannelId=${account.meta.channelId as string}`
    const r = await api<{
      items?: {
        snippet: {
          videoId?: string
          totalReplyCount: number
          topLevelComment: { id: string; snippet: { authorDisplayName: string; textOriginal: string; publishedAt: string; likeCount: number } }
        }
      }[]
    }>(ctx, `/commentThreads?part=snippet&order=time&maxResults=${Math.min(100, limit)}&${q}`)
    return (r.items ?? []).map(
      (t): Comment => ({
        id: t.snippet.topLevelComment.id,
        author: t.snippet.topLevelComment.snippet.authorDisplayName,
        text: t.snippet.topLevelComment.snippet.textOriginal,
        publishedAt: t.snippet.topLevelComment.snippet.publishedAt,
        likeCount: t.snippet.topLevelComment.snippet.likeCount,
        replyCount: t.snippet.totalReplyCount,
        postRemoteId: t.snippet.videoId,
        url: t.snippet.videoId ? `https://www.youtube.com/watch?v=${t.snippet.videoId}&lc=${t.snippet.topLevelComment.id}` : undefined
      })
    )
  },

  async reply(ctx, _account, { commentId, text }) {
    const r = await api<{ id: string }>(ctx, '/comments?part=snippet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: text } })
    })
    return { id: r.id }
  },

  async stats(ctx, _account: Account, remoteId) {
    const r = await api<{ items?: { statistics: Record<string, string> }[] }>(ctx, `/videos?part=statistics&id=${remoteId}`)
    const s = r.items?.[0]?.statistics ?? {}
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v)]))
  },

  async disconnect(ctx) {
    const t = ctx.secrets.get<OAuthTokens>()
    if (t?.refreshToken) {
      await ctx.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refreshToken)}`, { method: 'POST' }).catch(() => undefined)
    }
  }
}

/** Ask the session how much it has after a dropped request (Content-Range: bytes * /size). */
/** The daily upload limit and API quota reset at midnight Pacific; nothing was sent yet, so retrying is safe. */
async function checkQuota(res: Response, what: string): Promise<Response> {
  if (res.status === 403 || res.status === 400) {
    const text = await res.clone().text().catch(() => '')
    if (/quotaExceeded|uploadLimitExceeded|rateLimitExceeded|dailyLimitExceeded/.test(text))
      throw new RetryableError(`YouTube's daily limit is used up (${/"reason":\s*"(\w+)"/.exec(text)?.[1] ?? 'quota'}); will try again after it resets.`, secondsToPacificMidnight() + 300)
  }
  return check(res, what)
}

async function resumeStatus(ctx: ConnectorContext, session: string, size: number, failures: number, wasLastChunk: boolean): Promise<Response> {
  if (failures > 6) {
    if (wasLastChunk) throw new UnconfirmedError('Lost the connection while YouTube was finishing the upload.')
    throw new RetryableError('YouTube upload kept failing; will retry later.')
  }
  await sleep(Math.min(60_000, 1000 * 2 ** failures), ctx.signal)
  try {
    return await ctx.fetch(session, {
      method: 'PUT',
      headers: { authorization: `Bearer ${await accessToken(ctx)}`, 'content-range': `bytes */${size}` }
    })
  } catch (e) {
    if (e instanceof HttpError) throw e
    return resumeStatus(ctx, session, size, failures + 1, wasLastChunk)
  }
}
