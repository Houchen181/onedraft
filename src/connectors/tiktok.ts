// TikTok via the official Content Posting API (send-to-drafts or direct post), Login Kit for Desktop.
// A personal app stays in TikTok's Sandbox (TikTok doesn't approve personal tools), where direct posts can only be
// SELF_ONLY on a private account, so sending to the TikTok app's drafts is the default.

import { ContentError, NeedsLoginError, RetryableError, UnconfirmedError, type Connector, type ConnectorContext } from '../core/connector'
import { check, expiresSoon, form, sleep, type OAuthTokens } from '../core/http'
import { captionWithHashtags } from '../core/validate'
import { body, explain, fileSize, mimeOf, readChunk, requireSetting, singleFlight } from './util'

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
  const refreshToken = t.refreshToken
  return singleFlight(`tiktok:${refreshToken}`, async () => {
  const res = await ctx.fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      client_key: requireSetting(ctx.setting, 'clientKey', 'the TikTok client key'),
      client_secret: requireSetting(ctx.setting, 'clientSecret', 'the TikTok client secret'),
      grant_type: 'refresh_token',
      refresh_token: refreshToken
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
  })
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
        pattern: '^sbaw\\w+$',
        mismatch: 'Sandbox client keys start with “sbaw”. Check the toggle next to the app name says Sandbox, then copy the key shown there.'
      },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
      {
        key: 'redirectPort',
        label: 'Redirect port',
        type: 'number',
        default: 53682,
        help: 'Only if another program uses 53682. Change the Desktop redirect URI on TikTok to match (http://127.0.0.1:<port>/callback/).'
      }
    ],
    signIn:
      'Your browser opens TikTok. Sign in with the TikTok account you added as a target user and press **Authorize**. Then come back here.',
    guide: {
      why: 'TikTok only lets apps post through its API, and every app needs its own key. You make a developer app of your own, once. TikTok approves apps only for companies, so yours stays in its “Sandbox”: OneDraft sends each video to your TikTok drafts, and you post it from the TikTok app.',
      need: ['An email address for a TikTok for Developers account (it’s separate from your TikTok login)', 'Your TikTok account and its password'],
      time: 'about 15 minutes',
      steps: [
        {
          text: 'Sign up for TikTok for Developers with your email: press **Send code to email**, type the code and finish signing up.',
          link: { label: 'Open TikTok for Developers sign-up', url: 'https://developers.tiktok.com/signup' }
        },
        {
          text: 'Make the app: press **Connect an app**, choose your own (individual) account as the owner, name it **OneDraft** and press **Confirm**. If it asks for an app type, choose **Other**.',
          link: { label: 'Open Manage apps', url: 'https://developers.tiktok.com/apps/' },
          copy: [{ label: 'App name', value: 'OneDraft' }]
        },
        {
          text: 'Switch the toggle next to the app name to **Sandbox**, press **Create Sandbox**, name it **OneDraft** and press **Confirm**. Do every step below in the Sandbox.'
        },
        {
          text: 'Fill in the app details. App icon: OneDraft’s icon (button below) or any square picture. Category: **Productivity**, or the closest. Paste the description and the addresses below. Under Platforms tick **Desktop** and paste the website address there.',
          icon: 1024,
          copy: [
            { label: 'Description', value: 'OneDraft is a desktop app I use to post my own videos to my own TikTok account.' },
            { label: 'Terms of Service URL', value: 'https://github.com/Houchen181/onedraft/blob/main/docs/terms.md' },
            { label: 'Privacy Policy URL', value: 'https://github.com/Houchen181/onedraft/blob/main/docs/privacy.md' },
            { label: 'Desktop website', value: 'https://github.com/Houchen181/onedraft' }
          ]
        },
        {
          text: 'Under Products press **Add products**, add **Login Kit** and **Content Posting API**, then **Done**. In Login Kit open **Redirect URI**, choose the **Desktop** tab and paste the address below exactly, with the / at the end. In Content Posting API turn on **Direct Post**.',
          copy: [{ label: 'Redirect URI', value: 'http://127.0.0.1:{redirectPort}/callback/' }]
        },
        {
          text: 'Under Scopes press **Add scopes** and turn on all four: **user.info.basic**, **video.upload**, **video.publish** and **video.list**.'
        },
        {
          text: 'Under Sandbox settings → **Target users** press **Add account** and sign in with your TikTok account. Then press **Apply changes**.',
          detail: 'It can take up to an hour before TikTok lets that account sign in.'
        },
        {
          text: 'Under **Credentials** press the eye icons and copy the **Client key** and the **Client secret** into the boxes below. The toggle must still say Sandbox: Sandbox keys start with “sbaw”.',
          fields: ['clientKey', 'clientSecret']
        }
      ],
      trouble: [
        { problem: 'TikTok says the client_key is wrong', fix: 'You copied the Production keys. Switch the toggle next to the app name to Sandbox and copy the Client key and Client secret shown there.' },
        {
          problem: 'TikTok says the redirect_uri doesn’t match',
          fix: 'In Login Kit → Redirect URI → Desktop the address must be exactly http://127.0.0.1:{redirectPort}/callback/, with the / at the end. Press Apply changes after fixing it.'
        },
        {
          problem: 'TikTok won’t let your account sign in, or says the app isn’t authorized for it',
          fix: 'Add your TikTok account under Sandbox settings → Target users, press Apply changes, and wait up to an hour.'
        },
        {
          problem: '“unaudited_client_can_only_post_to_private_accounts”',
          fix: 'That post was set to “Post directly”: a Sandbox app can only post that way to a private account, visible only to you. Choose “Send to my TikTok drafts” for the post and finish it in the TikTok app.'
        },
        {
          problem: 'The draft never shows up in the TikTok app',
          fix: 'Check the TikTok app’s inbox notifications. If nothing arrives, set your account to private for a moment and send it again: TikTok’s Sandbox is unreliable with public accounts.'
        }
      ]
    },
    connectFields: [],
    options: [
      {
        key: 'mode',
        label: 'How to post',
        type: 'select',
        default: 'draft',
        options: [
          { value: 'draft', label: 'Send to my TikTok drafts, I finish in the app' },
          { value: 'direct', label: 'Post directly (only “Only me” until TikTok approves your app)' }
        ],
        help: 'Your own TikTok app stays in Sandbox, where posting directly is visible only to you and needs a private account. Drafts you can post publicly from the TikTok app.'
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
      'OneDraft sends videos to your TikTok drafts: open the TikTok app (inbox notifications) to add sounds and post. Up to 5 can wait there per day.',
      'Posting directly works only for “Only me” posts on a private account until TikTok approves your app.',
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
    if (!tok.access_token)
      throw explain(new Error(`TikTok sign-in failed: ${tok.error_description ?? 'no token'}`), {
        client_key: 'TikTok doesn’t accept this Client key: it’s probably the Production one. Switch the toggle next to the app name to Sandbox and copy the Client key and Client secret shown there.',
        client_secret: 'TikTok doesn’t accept this Client secret. Copy it again from Credentials (with the toggle on Sandbox).',
        redirect_uri: `The redirect URI on TikTok doesn’t match. In Login Kit → Redirect URI → Desktop it must be exactly ${r.redirectUri} (with the / at the end); press Apply changes.`
      })
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
    // TikTok: chunks are 5–64 MB except the last (which takes the remainder, up to 128 MB); a file up to 64 MB
    // may go as one chunk. So: one chunk up to 64 MB, else 10 MB chunks with the remainder in the last.
    const single = size <= 64_000_000
    const chunkSize = single ? size : CHUNK
    const count = single ? 1 : Math.floor(size / CHUNK)
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
