// Example OneDraft plugin: Bluesky (AT Protocol). Copy this folder to %APPDATA%\onedraft\connectors\bluesky
// and press Settings → Connectors → Reload. Uses an app password (bsky.app → Settings → App passwords).
// Example code: not yet tried against a live account.

const fs = require('fs')
const path = require('path')

const PDS = 'https://bsky.social/xrpc'
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

async function session(ctx) {
  const s = ctx.secrets.get()
  if (!s) throw Object.assign(new Error('Not connected'), { name: 'NeedsLoginError' })
  const r = await ctx.fetch(`${PDS}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: s.handle, password: s.appPassword })
  })
  if (r.status === 401) throw Object.assign(new Error('Bluesky rejected the app password'), { name: 'NeedsLoginError' })
  if (!r.ok) throw new Error(`Bluesky login failed: ${r.status} ${await r.text()}`)
  return r.json() // { accessJwt, did, handle }
}

exports.connector = {
  manifest: {
    id: 'bluesky',
    name: 'Bluesky',
    kind: 'plugin',
    color: '#1185fe',
    capabilities: { video: false, image: true, text: true, nativeSchedule: false, comments: false, reply: false, stats: false },
    constraints: { caption: { max: 300 }, tags: { style: 'hashtags' }, image: { maxCount: 4, maxBytes: 1e6, formats: ['jpg', 'jpeg', 'png', 'webp'] } },
    settings: [],
    connectFields: [
      { key: 'handle', label: 'Handle', type: 'text', required: true, placeholder: 'you.bsky.social' },
      { key: 'appPassword', label: 'App password', type: 'secret', required: true, help: 'bsky.app → Settings → Privacy and security → App passwords' }
    ],
    options: [],
    notes: ['Example plugin. Posts text and up to 4 images (≤ 1 MB each).']
  },

  async connect(ctx, input) {
    ctx.secrets.set({ handle: input.handle.trim(), appPassword: input.appPassword.trim() })
    const s = await session(ctx)
    return { name: s.handle, handle: '@' + s.handle, remoteUserId: s.did }
  },

  async publish(ctx, account, { content }) {
    const s = await session(ctx)
    const auth = { authorization: `Bearer ${s.accessJwt}` }
    const images = []
    for (const p of content.media) {
      const r = await ctx.fetch(`${PDS}/com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: { ...auth, 'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' },
        body: new Uint8Array(fs.readFileSync(p))
      })
      if (!r.ok) throw new Error(`Image upload failed: ${r.status} ${await r.text()}`)
      images.push({ image: (await r.json()).blob, alt: '' })
    }
    const tags = content.tags.map((t) => '#' + t.replace(/^#|\s+/g, '')).filter((t) => t.length > 1 && !content.caption.includes(t))
    const text = [content.caption.trim(), tags.join(' ')].filter(Boolean).join('\n\n')
    const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), langs: ['en'] }
    if (images.length) record.embed = { $type: 'app.bsky.embed.images', images }
    if (content.aiGenerated) record.labels = { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'ai-generated' }] }
    const r = await ctx.fetch(`${PDS}/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ repo: s.did, collection: 'app.bsky.feed.post', record })
    })
    if (!r.ok) {
      const body = await r.text()
      throw Object.assign(new Error(`Bluesky post failed: ${r.status} ${body}`), { name: r.status >= 500 ? 'RetryableError' : 'ContentError' })
    }
    const { uri } = await r.json()
    const rkey = uri.split('/').pop()
    return { remoteId: uri, url: `https://bsky.app/profile/${s.handle}/post/${rkey}`, state: 'published' }
  }
}
