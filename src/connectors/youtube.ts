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
import { body, explain, fileSize, mimeOf, readChunk, requireSetting } from './util'
import { isWeb, WEB_SELECTOR_SETTING, webCheck, webConnect, webDisconnect, webManifest, webPublish } from './web'

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
      'Google signed OneDraft out (it does that every 7 days while your Google app is in Testing). Press Connect in Settings → Platforms to sign in again.'
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
        label: 'Client ID',
        type: 'text',
        required: true,
        placeholder: '1234…apps.googleusercontent.com',
        pattern: '^\\d+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$',
        mismatch: 'A Google Client ID ends in .apps.googleusercontent.com. Copy the Client ID, not the secret or an API key.'
      },
      {
        key: 'clientSecret',
        label: 'Client secret',
        type: 'secret',
        required: true,
        placeholder: 'GOCSPX-…',
        pattern: '^GOCSPX-[\\w-]+$',
        mismatch: 'A Google Client secret starts with GOCSPX- (only very old ones don’t). Check you copied the secret, not the Client ID.'
      },
      WEB_SELECTOR_SETTING
    ],
    signIn:
      'Your browser opens Google. Pick the Google account that owns your channel. Google warns “Google hasn’t verified this app”: that is expected for an app you made yourself. Press **Continue** (or **Advanced**, then **Go to OneDraft (unsafe)**), tick every box and press **Continue**.',
    guide: {
      why: 'YouTube only lets an app upload for you when the app has its own key from Google. OneDraft has no company behind it, so you make that key yourself, once, in Google Cloud. It’s free, and the key stays on this computer.',
      need: [
        'The Google account that owns your YouTube channel. A personal Gmail works best: school and work accounts can block apps like this.',
        'No credit card: skip any free-trial offer Google shows'
      ],
      time: 'about 10 minutes',
      steps: [
        {
          text: 'Make a project: sign in to Google Cloud with the account that owns your channel (accept the terms if it asks). Project name **OneDraft**, Location **No organization**, press **Create**. Then pick **OneDraft** in the project picker at the top of the page.',
          link: { label: 'Open “New project”', url: 'https://console.cloud.google.com/projectcreate' },
          copy: [{ label: 'Project name', value: 'OneDraft' }]
        },
        {
          text: 'Turn on the YouTube Data API v3: check that the project picker says **OneDraft**, then press **Enable**.',
          detail: 'If the page doesn’t show the API, search the API Library for “YouTube Data API v3”.',
          link: { label: 'Open YouTube Data API v3', url: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com' }
        },
        {
          text: 'Turn on the YouTube Analytics API the same way (OneDraft reads your views and likes with it): press **Enable**.',
          link: { label: 'Open YouTube Analytics API', url: 'https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com' }
        },
        {
          text: 'Set up the sign-in screen: press **Get started**. App name **OneDraft** and your email as User support email, **Next**. Audience **External**, **Next**. Your email again, **Next**. Tick **I agree to the Google API Services: User Data Policy**, **Continue**, then **Create**.',
          detail: 'Don’t upload a logo: that makes Google ask for a review.',
          link: { label: 'Open Branding', url: 'https://console.cloud.google.com/auth/branding' },
          copy: [{ label: 'App name', value: 'OneDraft' }]
        },
        {
          text: 'Let your account in: on the **Audience** page, under **Test users**, press **Add users**, type the Google account that owns your channel and press **Save**.',
          link: { label: 'Open Audience', url: 'https://console.cloud.google.com/auth/audience' }
        },
        {
          text: 'Make the key: press **Create client**. Application type **Desktop app**, Name **OneDraft**, leave “AI-powered agent” unticked, press **Create**. Copy the **Client ID** and the **Client secret** into the boxes below before you close Google’s window.',
          detail: 'Google shows the secret only this once, so press **Download JSON** too. Lost it? Open the client and press **Add secret**.',
          link: { label: 'Open Clients', url: 'https://console.cloud.google.com/auth/clients' },
          fields: ['clientId', 'clientSecret']
        },
        {
          text: 'Optional: while your app is in Testing, Google signs OneDraft out every 7 days and OneDraft asks you to press Connect again. To stop that, on **Branding** fill in a home page and privacy policy link (below) and **Save**, then on **Audience** press **Publish app** and **Confirm**.',
          detail: 'If Publish app stays greyed out, skip this step: everything else works.',
          copy: [
            { label: 'Home page', value: 'https://github.com/Houchen181/onedraft' },
            { label: 'Privacy policy', value: 'https://github.com/Houchen181/onedraft/blob/main/docs/privacy.md' }
          ]
        }
      ],
      trouble: [
        { problem: '“Google hasn’t verified this app”', fix: 'Expected: it’s the app you just made. Press Continue, or Advanced and then Go to OneDraft (unsafe).' },
        {
          problem: '“Access blocked” or “Error 403: access_denied”',
          fix: 'Your Google account isn’t a test user yet. Add it under Audience → Test users (step 5), then press Connect again.'
        },
        {
          problem: '“Error 400: redirect_uri_mismatch”',
          fix: 'The client isn’t a Desktop app. Make a new client with Application type Desktop app (step 6) and paste its Client ID and secret.'
        },
        { problem: '“Error 401: invalid_client” or “deleted_client”', fix: 'The Client ID or secret has a typo, or the client was deleted. Copy both again from Google Cloud → Clients (step 6).' },
        {
          problem: '“YouTube Data API v3 has not been used in project … or it is disabled”',
          fix: 'Turn on the YouTube Data API v3 in the same project (the picker at the top must say OneDraft), wait a minute, then press Connect.'
        },
        {
          problem: '“This Google account has no YouTube channel”',
          fix: 'Sign in with the account that owns the channel. If the channel belongs to a Brand Account, pick that channel when Google asks which one to use.'
        },
        { problem: 'Publish app is greyed out', fix: 'Google wants a home page and privacy policy link first, and sometimes still refuses. You can skip it: OneDraft just asks you to sign in again once a week.' }
      ]
    },
    web: webManifest('youtube', ['If your channel belongs to a Brand Account and YouTube asks which channel to use when you post, pick it there.'], ['privacy', 'madeForKids']),
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
      'While your Google app is in Testing, Google signs OneDraft out every 7 days: press Connect again when OneDraft asks.',
      'Google allows 100 uploads a day per project. Videos over 15 minutes need a phone-verified channel.',
      'Vertical videos up to 3 minutes are published as Shorts automatically.'
    ]
  },

  async connect(ctx, input) {
    if (input.method === 'web' || (!input.method && input._profileKey)) return webConnect('youtube', ctx, input)
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
    ).catch((e) => {
      throw explain(e, {
        invalid_client:
          'Google doesn’t accept this Client ID and Client secret together. Copy both again from the same client (Google Cloud → Clients → OneDraft) and press Connect.',
        client_secret:
          'Google wants the Client secret too. Paste it from Google Cloud → Clients → OneDraft (or from the JSON file you downloaded) and press Connect.',
        invalid_grant: 'The sign-in took too long, or was used twice. Press Connect again.'
      })
    })
    // Google's permission screen has a tick box per permission; an unticked upload box would only fail at the first post.
    if (tok.scope && !tok.scope.split(' ').includes(SCOPES[0]))
      throw new Error('Google didn’t give OneDraft permission to upload videos. Press Connect again and tick every box on Google’s permission screen.')
    ctx.secrets.set({
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
      scope: tok.scope
    } satisfies OAuthTokens)
    const ch = await api<{ items?: Channel[] }>(ctx, '/channels?part=snippet&mine=true').catch((e) => {
      throw explain(e, {
        accessNotConfigured:
          'The YouTube Data API v3 is off in this Google Cloud project. Turn it on (the “Turn on the YouTube Data API v3” step; check the project name at the top), wait a minute, then press Connect.',
        SERVICE_DISABLED:
          'The YouTube Data API v3 is off in this Google Cloud project. Turn it on (the “Turn on the YouTube Data API v3” step; check the project name at the top), wait a minute, then press Connect.'
      })
    })
    const c = ch.items?.[0]
    if (!c)
      throw new Error(
        'This Google account has no YouTube channel. Press Connect again and pick the account that owns your channel (or create a channel at youtube.com first).'
      )
    return {
      name: c.snippet.title,
      handle: c.snippet.customUrl,
      avatarUrl: c.snippet.thumbnails?.default?.url,
      remoteUserId: c.id,
      meta: { channelId: c.id }
    }
  },

  async check(ctx, account) {
    if (isWeb(account)) return webCheck('youtube', ctx, account)
    const ch = await api<{ items?: Channel[] }>(ctx, '/channels?part=snippet&mine=true')
    return { ok: !!ch.items?.length, name: ch.items?.[0]?.snippet.title }
  },

  async publish(ctx, account, req) {
    if (isWeb(account)) return webPublish('youtube', ctx, account, req)
    const { content, publishAt } = req
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
        selfDeclaredMadeForKids: content.options.madeForKids === true || content.options.madeForKids === 'true',
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
          topLevelComment: {
            id: string
            snippet: { authorDisplayName: string; authorChannelId?: { value?: string }; textOriginal: string; publishedAt: string; likeCount: number }
          }
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
        url: t.snippet.videoId ? `https://www.youtube.com/watch?v=${t.snippet.videoId}&lc=${t.snippet.topLevelComment.id}` : undefined,
        mine: !!account.meta.channelId && t.snippet.topLevelComment.snippet.authorChannelId?.value === account.meta.channelId
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

  async disconnect(ctx, account) {
    if (isWeb(account)) return webDisconnect(ctx, account)
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
