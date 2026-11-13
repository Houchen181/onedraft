// Optional "public media host": some APIs (Instagram images, TikTok photos) fetch media from a public
// URL instead of accepting an upload. A desktop app has no public server, so the user can point
// OneDraft at any S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2, MinIO) with a public URL.
// Files are uploaded just before publishing and deleted afterwards.

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

export interface MediaHostConfig {
  endpoint: string // e.g. https://<account>.r2.cloudflarestorage.com
  bucket: string
  region: string // 'auto' for R2
  accessKeyId: string
  secretAccessKey: string
  publicBaseUrl: string // e.g. https://pub-xxxx.r2.dev
}

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex')
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest()

/** AWS Signature V4 presigned URL (path-style). */
export function presign(cfg: MediaHostConfig, method: 'PUT' | 'DELETE' | 'GET', key: string, expiresSec = 900, at = new Date()): string {
  const url = new URL(cfg.endpoint)
  const amzDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const date = amzDate.slice(0, 8)
  const scope = `${date}/${cfg.region}/s3/aws4_request`
  const path = `/${[cfg.bucket, ...key.split('/')].map(enc).join('/')}`
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSec)],
    ['X-Amz-SignedHeaders', 'host']
  ]
  const canonicalQuery = query
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = [method, path, canonicalQuery, `host:${url.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n')
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, date)
  const kSigning = hmac(hmac(hmac(kDate, cfg.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex')
  return `${url.protocol}//${url.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime'
}

export class MediaHost {
  constructor(
    private cfg: MediaHostConfig,
    private f: typeof fetch = fetch
  ) {}

  static fromSettings(get: (k: string) => string | undefined, f?: typeof fetch): MediaHost | undefined {
    const cfg = {
      endpoint: get('mediaHost.endpoint') ?? '',
      bucket: get('mediaHost.bucket') ?? '',
      region: get('mediaHost.region') || 'auto',
      accessKeyId: get('mediaHost.accessKeyId') ?? '',
      secretAccessKey: get('mediaHost.secretAccessKey') ?? '',
      publicBaseUrl: (get('mediaHost.publicBaseUrl') ?? '').replace(/\/+$/, '')
    }
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.publicBaseUrl) return undefined
    return new MediaHost(cfg, f)
  }

  /** Upload a local file; returns its public URL and key (for deletion). */
  async put(path: string): Promise<{ url: string; key: string }> {
    const ext = extname(path).slice(1).toLowerCase()
    const key = `onedraft/${randomUUID()}-${basename(path).replace(/[^\w.-]+/g, '_')}`
    const res = await this.f(presign(this.cfg, 'PUT', key), {
      method: 'PUT',
      body: readFileSync(path),
      headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' }
    })
    if (!res.ok) throw new Error(`Media host upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    return { url: `${this.cfg.publicBaseUrl}/${key.split('/').map(enc).join('/')}`, key }
  }

  async remove(key: string): Promise<void> {
    await this.f(presign(this.cfg, 'DELETE', key), { method: 'DELETE' }).catch(() => undefined)
  }
}
