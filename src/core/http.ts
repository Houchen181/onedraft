// Small fetch helpers that turn HTTP failures into the connector error types.

import { NeedsLoginError, RetryableError } from './connector'

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export async function readBody(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/** Throws typed errors for 401 / 429 / 5xx so the publisher can decide what to do. */
export async function check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res
  const body = await readBody(res)
  const short = body.slice(0, 600)
  if (res.status === 401) throw new NeedsLoginError(`${what}: not authorized (401). ${short}`)
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after')) || 900
    throw new RetryableError(`${what}: rate limited (429). ${short}`, after)
  }
  if (res.status >= 500) throw new RetryableError(`${what}: server error ${res.status}. ${short}`, 120)
  throw new HttpError(res.status, body, `${what} failed (${res.status}): ${short}`)
}

export async function getJson<T>(f: typeof fetch, url: string, init: RequestInit, what: string): Promise<T> {
  const res = await check(await f(url, init), what)
  return (await res.json()) as T
}

export const form = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined) p.set(k, v)
  return p
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Canceled'))
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('Canceled'))
    }
    // Remove the listener when the sleep ends: polling loops sleep hundreds of times on one signal.
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Seconds until the next midnight in Los Angeles, when YouTube's daily quota resets. */
export function secondsToPacificMidnight(now = new Date()): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  )
  const elapsed = (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)
  return Math.max(60, 86400 - elapsed)
}

/** Token bundle most OAuth connectors store as the account secret. */
export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  /** epoch ms */
  expiresAt?: number
  scope?: string
}

export const expiresSoon = (t: OAuthTokens, marginMs = 5 * 60_000) => !!t.expiresAt && t.expiresAt - Date.now() < marginMs
