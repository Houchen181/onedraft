// X (Twitter) via API v2: OAuth 2.0 PKCE (native app, no secret), chunked media upload, threads.

import { NeedsLoginError, RetryableError, UnconfirmedError, type Connector, type ConnectorContext } from '../core/connector'
import { check, expiresSoon, form, getJson, HttpError, sleep, type OAuthTokens } from '../core/http'
import { weightedLength } from '../core/validate'
import type { Comment } from '../shared/types'
import { fileSize, isVideo, mimeOf, readChunk, requireSetting, singleFlight, splitThread } from './util'

const API = 'https://api.x.com/2'
const SEGMENT = 4 * 1024 * 1024

async function accessToken(ctx: ConnectorContext): Promise<string> {
  const t = ctx.secrets.get<OAuthTokens>()
  if (!t?.accessToken) throw new NeedsLoginError()
  if (!expiresSoon(t)) return t.accessToken
  if (!t.refreshToken) throw new NeedsLoginError()
  const refreshToken = t.refreshToken
  return singleFlight(`x:${refreshToken}`, async () => {
  const res = await ctx.fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: requireSetting(ctx.setting, 'clientId', 'the X client ID') })
  })
  if (res.status === 400 || res.status === 401) throw new NeedsLoginError('X refused the saved login; reconnect.')
  const j = (await (await check(res, 'Refresh X token')).json()) as { access_token: string; refresh_token?: string; expires_in: number }
  const next: OAuthTokens = {
    ...t,
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? t.refreshToken,
    expiresAt: Date.now() + j.expires_in * 1000
  }
  ctx.secrets.set(next)
  return next.accessToken
  })
}

async function api<T>(ctx: ConnectorContext, path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(ctx)
  return getJson<T>(ctx.fetch, `${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }, 'X')
}

async function uploadMedia(ctx: ConnectorContext, path: string, index: number, total: number): Promise<string> {
  const size = fileSize(path)
  const video = isVideo(path)
  const category = video ? 'tweet_video' : mimeOf(path) === 'image/gif' ? 'tweet_gif' : 'tweet_image'
  const init = await api<{ data: { id: string } }>(ctx, '/media/upload/initialize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ media_type: mimeOf(path), total_bytes: size, media_category: category })
  })
  const id = init.data.id
  for (let seg = 0, off = 0; off < size; seg++, off += SEGMENT) {
    const fd = new FormData()
    fd.set('segment_index', String(seg))
    fd.set('media', new Blob([new Uint8Array(readChunk(path, off, Math.min(SEGMENT, size - off)))]), 'chunk')
    await check(
      await ctx.fetch(`${API}/media/upload/${id}/append`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await accessToken(ctx)}` },
        body: fd,
        signal: ctx.signal
      }),
      'X media append'
    )
    ctx.progress((index + Math.min(1, (off + SEGMENT) / size)) / total, 'Uploading media to X')
  }
  type Processing = { state: 'pending' | 'in_progress' | 'succeeded' | 'failed'; check_after_secs?: number; error?: { message?: string } }
  const fin = await api<{ data: { id: string; processing_info?: Processing } }>(ctx, `/media/upload/${id}/finalize`, { method: 'POST' })
  let info = fin.data.processing_info
  const deadline = Date.now() + 15 * 60_000
  while (info && info.state !== 'succeeded') {
    if (info.state === 'failed') throw new Error(`X could not process ${path}: ${info.error?.message ?? 'unknown error'}`)
    if (Date.now() > deadline) throw new RetryableError('X media processing timed out.')
    await sleep((info.check_after_secs ?? 5) * 1000, ctx.signal)
    const st = await api<{ data: { processing_info?: Processing } }>(ctx, `/media/upload?command=STATUS&media_id=${id}`)
    info = st.data.processing_info
  }
  return id
}

export const x: Connector = {
  manifest: {
    id: 'x',
    name: 'X',
    kind: 'api',
    color: '#71767b',
    source: 'builtin',
    docsUrl: 'https://docs.x.com/x-api/posts/create-post',
    // Replies are found with recent search, which covers the last 7 days.
    capabilities: { video: true, image: true, text: true, nativeSchedule: false, comments: true, commentsPerPost: { days: 7 }, reply: true, stats: true },
    constraints: {
      caption: { max: 280, unit: 'weighted', overflow: 'thread' },
      tags: { style: 'hashtags' },
      video: { maxSec: 140, maxBytes: 512e6 },
      image: { maxCount: 4, maxBytes: 5e6, formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
      media: { required: false, mixed: false, maxVideos: 1 }
    },
    settings: [
      {
        key: 'clientId',
        label: 'OAuth 2.0 client ID',
        type: 'text',
        required: true,
        help: 'console.x.com → your app → User authentication → type "Native App", callback http://127.0.0.1:53682/callback, scopes tweet.read tweet.write users.read media.write offline.access.'
      },
      { key: 'redirectPort', label: 'Callback port', type: 'number', default: 53682, help: 'Must match the callback URL registered on X.' },
      { key: 'premium', label: 'Account has X Premium (long posts)', type: 'boolean', default: false }
    ],
    connectFields: [],
    options: [
      { key: 'thread', label: 'Split long text into a thread', type: 'boolean', default: true, help: 'Otherwise text over the limit is an error.' }
    ],
    notes: [
      'X bills per post (about $0.015), and about $0.20 when the post contains a link.',
      'Video limit here is 2 min 20 s (longer needs Premium).'
    ]
  },

  validate(content) {
    return /https?:\/\//.test(content.caption)
      ? [{ level: 'warning', field: 'caption', message: 'X bills about $0.20 for a post with a link (vs ~$0.015 without).' }]
      : []
  },

  async connect(ctx) {
    const clientId = requireSetting(ctx.setting, 'clientId', 'the X client ID')
    const port = Number(ctx.setting('redirectPort') || 53682)
    const r = await ctx.oauthLoopback({
      port,
      host: '127.0.0.1',
      path: '/callback',
      authorizeUrl: ({ redirectUri, state, codeChallenge }) =>
        'https://x.com/i/oauth2/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: 'tweet.read tweet.write users.read media.write offline.access',
          state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256'
        })
    })
    // X expires the code after 30 s, so exchange immediately.
    const tok = await getJson<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }>(
      ctx.fetch,
      `${API}/oauth2/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ grant_type: 'authorization_code', code: r.code, redirect_uri: r.redirectUri, code_verifier: r.codeVerifier, client_id: clientId })
      },
      'X token exchange'
    )
    ctx.secrets.set({ accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + tok.expires_in * 1000, scope: tok.scope })
    const me = await api<{ data: { id: string; name: string; username: string; profile_image_url?: string } }>(
      ctx,
      '/users/me?user.fields=profile_image_url'
    )
    return {
      name: me.data.name,
      handle: `@${me.data.username}`,
      avatarUrl: me.data.profile_image_url,
      remoteUserId: me.data.id,
      meta: { userId: me.data.id, username: me.data.username }
    }
  },

  async check(ctx) {
    const me = await api<{ data: { name: string } }>(ctx, '/users/me')
    return { ok: true, name: me.data.name }
  },

  applySettings(setting) {
    // Premium accounts can post up to 25,000 characters, so long text needn't become a thread.
    const premium = setting('premium') === 'true'
    this.manifest.constraints.caption = { max: premium ? 25000 : 280, unit: 'weighted', overflow: 'thread' }
  },

  async publish(ctx, account, { content }) {
    const max = ctx.setting('premium') === 'true' ? 25000 : 280
    const hashtags = content.tags.map((t) => `#${t.replace(/^#|\s+/g, '')}`).filter((t) => t.length > 1 && !content.caption.includes(t))
    const text = [content.caption.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n')
    const parts = content.options.thread === false ? [text] : splitThread(text, max, weightedLength)
    if (weightedLength(parts[0]) > max) throw new Error(`Text is ${weightedLength(parts[0])} characters; X allows ${max}.`)

    const mediaIds: string[] = []
    for (const [i, m] of content.media.entries()) mediaIds.push(await uploadMedia(ctx, m, i, content.media.length))

    let firstId: string | undefined
    let previous: string | undefined
    for (const [i, part] of parts.entries()) {
      const payload: Record<string, unknown> = { text: part }
      if (i === 0 && mediaIds.length) payload.media = { media_ids: mediaIds }
      if (previous) payload.reply = { in_reply_to_tweet_id: previous }
      if (content.aiGenerated) payload.made_with_ai = true
      try {
        const token = await accessToken(ctx)
        let res: Response
        try {
          res = await ctx.fetch(`${API}/tweets`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: ctx.signal
          })
        } catch (e) {
          // The request may have reached X before the connection dropped: never post it again automatically.
          throw new UnconfirmedError(`Lost the connection while posting to X (${(e as Error).message}). Check your profile before retrying.`, firstId)
        }
        if (res.status >= 500)
          throw new UnconfirmedError(`X answered ${res.status} while posting; it may have gone out. Check your profile before retrying.`, firstId)
        const r = (await (await check(res, 'X')).json()) as { data: { id: string } }
        previous = r.data.id
        firstId ??= r.data.id
      } catch (e) {
        // Once the first post is out, never re-run the whole thing.
        if (firstId) throw new UnconfirmedError(`Thread stopped after ${i} of ${parts.length} posts: ${(e as Error).message}`, firstId)
        throw e
      }
    }
    const username = (account.meta.username as string) ?? 'i'
    return { remoteId: firstId, url: `https://x.com/${username}/status/${firstId}`, state: 'published', note: parts.length > 1 ? `Posted as a ${parts.length}-part thread` : undefined }
  },

  async listComments(ctx, account, { remoteId, limit = 50, sinceId }) {
    if (!remoteId) return []
    type Found = { data?: { id: string; text: string; author_id: string; created_at?: string; public_metrics?: { like_count: number; reply_count: number } }[]; includes?: { users?: { id: string; username: string }[] } }
    // X bills every post read, so ask only for replies newer than the ones OneDraft has (since_id).
    const search = (since?: string) =>
      api<Found>(
        ctx,
        `/tweets/search/recent?query=${encodeURIComponent(`conversation_id:${remoteId}`)}&max_results=${Math.max(10, Math.min(100, limit))}&tweet.fields=created_at,public_metrics,author_id&expansions=author_id${since ? `&since_id=${encodeURIComponent(since)}` : ''}`
      )
    let r: Found
    try {
      r = await search(sinceId)
    } catch (e) {
      // since_id must be inside search's 7-day window; an older one is refused, so ask without it.
      if (!(sinceId && e instanceof HttpError && e.status === 400 && /since_id/i.test(e.body))) throw e
      r = await search()
    }
    const users = new Map((r.includes?.users ?? []).map((u) => [u.id, u.username]))
    const me = String(account.meta.userId ?? '')
    return (r.data ?? []).map(
      (t): Comment => ({
        id: t.id,
        author: `@${users.get(t.author_id) ?? t.author_id}`,
        text: t.text,
        publishedAt: t.created_at,
        likeCount: t.public_metrics?.like_count,
        replyCount: t.public_metrics?.reply_count,
        postRemoteId: remoteId,
        url: `https://x.com/i/status/${t.id}`,
        // The thread's own later parts and the account's replies come back too.
        mine: !!me && t.author_id === me
      })
    )
  },

  async reply(ctx, _account, { commentId, text }) {
    const r = await api<{ data: { id: string } }>(ctx, '/tweets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: commentId } })
    })
    return { id: r.data.id }
  },

  async stats(ctx, _account, remoteId) {
    const r = await api<{ data: { public_metrics?: Record<string, number> } }>(ctx, `/tweets/${remoteId}?tweet.fields=public_metrics`)
    return r.data.public_metrics ?? {}
  }
}
