// TikTok via the official Content Posting API (direct post or send-to-drafts), Login Kit for Desktop.
// Unaudited apps can only post privately (SELF_ONLY) to private accounts — see manifest notes.

import { ContentError, NeedsLoginError, RetryableError, UnconfirmedError, type Connector, type ConnectorContext } from '../core/connector'
import { check, expiresSoon, form, sleep, type OAuthTokens } from '../core/http'
import { captionWithHashtags } from '../core/validate'
import { body, fileSize, mimeOf, readChunk, requireSetting } from './util'

const API = 'https://open.tiktokapis.com/v2'
const CHUNK = 10_000_000

interface TtEnvelope<T> {
  data: T
  error: { code: string; message?: string; log_id?: string }
}

function raise(e: TtEnvelope<unknown>['error'], what: string): never {
  const msg = `${what}: ${e.code}${e.message ? ` — ${e.message}` : ''}`
  if (e.code === 'access_token_invalid' || e.code === 'scope_not_authorized') throw new NeedsLoginError(msg)
  if (e.code === 'rate_limit_exceeded') throw new RetryableError(msg, 120)
  if (e.code.startsWith('unaudited_client') || e.code.startsWith('spam_risk') || e.code === 'privacy_level_option_mismatch')
    throw new ContentError(
      e.code.startsWith('unaudited_client')
        ? `${msg}. Until TikTok audits your app, posts must be "Only me" and the TikTok account must be private.`
        : msg
    )
  throw new Error(msg)
}

async function accessToken(ctx: ConnectorContext): Promise<string> {
  const t = ctx.secrets.get<OAuthTokens & { openId?: string }>()
  if (!t?.accessToken) throw new NeedsLoginError()
  if (!expiresSoon(t)) return t.accessToken
  if (!t.refreshToken) throw new NeedsLoginError()
  const res = await ctx.fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      client_key: requireSetting(ctx.setting, 'clientKey', 'the TikTok client key'),
      client_secret: requireSetting(ctx.setting, 'clientSecret', 'the TikTok client secret'),
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken
    })
  })
  const j = (await (await check(res, 'Refresh TikTok token')).json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!j.access_token) throw new NeedsLoginError(`TikTok refused the saved login: ${j.error_description ?? j.error ?? 'unknown'}`)
  const next = { ...t, accessToken: j.access_token, refreshToken: j.refresh_token ?? t.refreshToken, expiresAt: Date.now() + (j.expires_in ?? 7200) * 1000 }
  ctx.secrets.set(next)
  return next.accessToken
}

async function call<T>(ctx: ConnectorContext, path: string, payload: unknown, what: string): Promise<T> {
  const res = await ctx.fetch(`${API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken(ctx)}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(payload ?? {})
  })
  if (res.status >= 500) throw new RetryableError(`${what}: TikTok server error ${res.status}`)
  const j = (await res.json()) as TtEnvelope<T>
  if (j.error && j.error.code !== 'ok') raise(j.error, what)
  return j.data
}

export const tiktok: Connector = {
  manifest: {
    id: 'tiktok',
    name: 'TikTok',
    kind: 'api',
    color: '#25f4ee',
    source: 'builtin',
    docsUrl: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
    capabilities: { video: true, image: false, text: false, nativeSchedule: false, comments: false, reply: false, stats: true },
    constraints: {
      caption: { max: 2200 },
      tags: { style: 'hashtags' },
      video: { minSec: 3, maxSec: 600, maxBytes: 4e9, preferredAspect: '9:16', formats: ['mp4', 'mov', 'webm'] },
      media: { required: true, maxVideos: 1 }
    },
    settings: [
      {
        key: 'clientKey',
        label: 'Client key',
        type: 'text',
        required: true,
        help: 'developers.tiktok.com → Manage apps → add Login Kit (Desktop) + Content Posting API (Direct Post on). Redirect URI http://127.0.0.1:53682/callback/'
      },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
      { key: 'redirectPort', label: 'Redirect port', type: 'number', default: 53682 }
    ],
    connectFields: [],
    options: [
      {
        key: 'mode',
        label: 'How to post',
        type: 'select',
        default: 'direct',
        options: [
          { value: 'direct', label: 'Post directly' },
          { value: 'draft', label: 'Send to TikTok drafts (finish in the app)' }
        ]
      },
      {
        key: 'privacyLevel',
        label: 'Who can view',
        type: 'select',
        required: true,
        options: [
          { value: 'PUBLIC_TO_EVERYONE', label: 'Everyone' },
          { value: 'MUTUAL_FOLLOW_FRIENDS', label: 'Friends' },
          { value: 'FOLLOWER_OF_CREATOR', label: 'Followers' },
          { value: 'SELF_ONLY', label: 'Only me' }
        ],
        help: 'TikTok requires you to choose; there is no default. Unaudited apps can only use "Only me".'
      },
      { key: 'allowComments', label: 'Allow comments', type: 'boolean', default: false },
      { key: 'allowDuet', label: 'Allow Duet', type: 'boolean', default: false },
      { key: 'allowStitch', label: 'Allow Stitch', type: 'boolean', default: false },
      {
        key: 'commercial',
        label: 'Commercial content',
        type: 'select',
        default: 'none',
        options: [
          { value: 'none', label: 'Not commercial' },
          { value: 'own', label: 'Promotes my own brand' },
          { value: 'branded', label: 'Branded content (paid partnership)' }
        ]
      },
      { key: 'coverAtSec', label: 'Cover frame (seconds into the video)', type: 'number', default: 0 }
    ],
    notes: [
      'Until TikTok audits your developer app, posts are private ("Only me") and the TikTok account must be private.',
      "By posting you agree to TikTok's Music Usage Confirmation.",
      'TikTok has no scheduling API: scheduled posts need OneDraft running at the publish time.'
    ]
  },

  async connect(ctx) {
    const clientKey = requireSetting(ctx.setting, 'clientKey', 'the TikTok client key')
    const clientSecret = requireSetting(ctx.setting, 'clientSecret', 'the TikTok client secret')
    const r = await ctx.oauthLoopback({
      port: Number(ctx.setting('redirectPort') || 53682),
      host: '127.0.0.1',
      path: '/callback/',
      challengeMethod: 'S256-hex',
      authorizeUrl: ({ redirectUri, state, codeChallenge }) =>
        'https://www.tiktok.com/v2/auth/authorize/?' +
        new URLSearchParams({
          client_key: clientKey,
          scope: 'user.info.basic,video.publish,video.upload,video.list',
          response_type: 'code',
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256'
        })
    })
    const res = await ctx.fetch(`${API}/oauth/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        client_key: clientKey,
        client_secret: clientSecret,
        code: r.code,
        grant_type: 'authorization_code',
        redirect_uri: r.redirectUri,
        code_verifier: r.codeVerifier
      })
    })
    const tok = (await (await check(res, 'TikTok token exchange')).json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      open_id?: string
      error_description?: string
    }
    if (!tok.access_token) throw new Error(`TikTok sign-in failed: ${tok.error_description ?? 'no token'}`)
    ctx.secrets.set({ accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + (tok.expires_in ?? 7200) * 1000, openId: tok.open_id })
    const info = await ctx.fetch(`${API}/user/info/?fields=open_id,avatar_url,display_name`, { headers: { authorization: `Bearer ${tok.access_token}` } })
    const j = (await info.json()) as TtEnvelope<{ user?: { open_id: string; avatar_url?: string; display_name?: string } }>
    const u = j.data?.user
    const creator = await call<{ creator_username?: string; creator_nickname?: string }>(ctx, '/post/publish/creator_info/query/', {}, 'TikTok creator info').catch(
      () => undefined
    )
    return {
      name: u?.display_name ?? creator?.creator_nickname ?? 'TikTok account',
      handle: creator?.creator_username ? `@${creator.creator_username}` : undefined,
      avatarUrl: u?.avatar_url,
      remoteUserId: u?.open_id ?? tok.open_id ?? 'unknown',
      meta: { username: creator?.creator_username }
    }
  },

  async check(ctx) {
    const c = await call<{ creator_nickname?: string }>(ctx, '/post/publish/creator_info/query/', {}, 'TikTok creator info')
    return { ok: true, name: c.creator_nickname }
  },

  async publish(ctx, account, { content }) {
    const o = content.options
    const file = content.media[0]
    const size = fileSize(file)
    const chunkSize = size < 5_000_000 ? size : CHUNK
    const count = size < 5_000_000 ? 1 : Math.floor(size / CHUNK)
    const source_info = { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count }
    const draft = o.mode === 'draft'

    let init: { publish_id: string; upload_url: string }
    if (draft) {
      init = await call(ctx, '/post/publish/inbox/video/init/', { source_info }, 'TikTok draft upload')
    } else {
      const creator = await call<{ privacy_level_options: string[]; max_video_post_duration_sec?: number; creator_username?: string }>(
        ctx,
        '/post/publish/creator_info/query/',
        {},
        'TikTok creator info'
      )
      const privacy = String(o.privacyLevel ?? '')
      if (!creator.privacy_level_options.includes(privacy))
        throw new ContentError(`TikTok allows only ${creator.privacy_level_options.join(', ')} for this account right now (you chose ${privacy || 'nothing'}).`)
      const commercial = String(o.commercial ?? 'none')
      init = await call(
        ctx,
        '/post/publish/video/init/',
        {
          post_info: {
            title: captionWithHashtags(content.caption, content.tags).slice(0, 2200),
            privacy_level: privacy,
            disable_comment: !o.allowComments,
            disable_duet: !o.allowDuet,
            disable_stitch: !o.allowStitch,
            video_cover_timestamp_ms: Math.round(Number(o.coverAtSec ?? 0) * 1000),
            brand_organic_toggle: commercial === 'own',
            brand_content_toggle: commercial === 'branded',
            is_aigc: content.aiGenerated
          },
          source_info
        },
        'TikTok post init'
      )
    }

    for (let i = 0; i < count; i++) {
      const start = i * chunkSize
      const end = i === count - 1 ? size - 1 : start + chunkSize - 1
      const res = await ctx.fetch(init.upload_url, {
        method: 'PUT',
        headers: { 'content-type': mimeOf(file), 'content-range': `bytes ${start}-${end}/${size}` },
        body: body(readChunk(file, start, end - start + 1)),
        signal: ctx.signal
      })
      if (!res.ok && res.status !== 206) await check(res, 'TikTok upload')
      ctx.progress((end + 1) / size, 'Uploading to TikTok')
    }

    // The upload is complete; from here TikTok owns it. Poll, and never re-send.
    const deadline = Date.now() + 15 * 60_000
    while (Date.now() < deadline) {
      await sleep(5000, ctx.signal)
      let st: { status: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }
      try {
        st = await call(ctx, '/post/publish/status/fetch/', { publish_id: init.publish_id }, 'TikTok status')
      } catch (e) {
        if (e instanceof RetryableError) continue
        throw new UnconfirmedError(`Uploaded, but could not read TikTok's status: ${(e as Error).message}`, init.publish_id)
      }
      if (st.status === 'FAILED') throw new ContentError(`TikTok rejected the video: ${st.fail_reason ?? 'no reason given'}`)
      if (st.status === 'SEND_TO_USER_INBOX')
        return { remoteId: init.publish_id, state: 'handoff', note: 'Sent to your TikTok inbox: open the TikTok app to finish posting.' }
      if (st.status === 'PUBLISH_COMPLETE') {
        const id = st.publicaly_available_post_id?.[0]
        const username = (account.meta.username as string) ?? ''
        return {
          remoteId: id ? String(id) : init.publish_id,
          url: id && username ? `https://www.tiktok.com/@${username}/video/${id}` : undefined,
          state: 'published',
          note: id ? undefined : 'Posted (private posts have no public link).'
        }
      }
    }
    throw new UnconfirmedError('TikTok is still processing after 15 minutes; check the app.', init.publish_id)
  },

  async stats(ctx, _account, remoteId) {
    const res = await ctx.fetch(`${API}/video/query/?fields=id,view_count,like_count,comment_count,share_count`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken(ctx)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ filters: { video_ids: [remoteId] } })
    })
    const j = (await res.json()) as TtEnvelope<{ videos?: Record<string, number | string>[] }>
    if (j.error?.code !== 'ok') raise(j.error, 'TikTok stats')
    const v = j.data.videos?.[0] ?? {}
    return Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'number')) as Record<string, number>
  },

  async disconnect(ctx) {
    const t = ctx.secrets.get<OAuthTokens>()
    const key = ctx.setting('clientKey')
    const secret = ctx.setting('clientSecret')
    if (t?.accessToken && key && secret) {
      await ctx
        .fetch(`${API}/oauth/revoke/`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form({ client_key: key, client_secret: secret, token: t.accessToken })
        })
        .catch(() => undefined)
    }
  }
}
