// OAuth for a desktop app: PKCE + a one-shot loopback HTTP server that catches the redirect.

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LoopbackOptions, LoopbackResult } from './connector'

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkcePair(method: 'S256' | 'S256-hex' = 'S256') {
  const verifier = b64url(randomBytes(48)) // 64 chars, within RFC 7636's 43-128
  const digest = createHash('sha256').update(verifier).digest()
  return { verifier, challenge: method === 'S256-hex' ? digest.toString('hex') : b64url(digest) }
}

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0f1115;color:#e8e8ea">
<div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`

export function oauthLoopback(
  opts: LoopbackOptions,
  openExternal: (url: string) => Promise<void>,
  signal?: AbortSignal
): Promise<LoopbackResult> {
  const host = opts.host ?? '127.0.0.1'
  const path = opts.path ?? '/callback'
  const state = b64url(randomBytes(16))
  const { verifier, challenge } = pkcePair(opts.challengeMethod)

  return new Promise((resolve, reject) => {
    let redirectUri = ''
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${host}`)
      const norm = (p: string) => p.replace(/\/+$/, '')
      if (norm(url.pathname) !== norm(path)) {
        res.writeHead(404).end()
        return
      }
      const params = Object.fromEntries(url.searchParams)
      const done = (ok: boolean, msg: string) => {
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE(ok ? 'Connected' : 'Sign-in failed', msg))
        cleanup()
      }
      if (params.state !== state) {
        done(false, 'State mismatch. Please try connecting again from Polycast.')
        reject(new Error('OAuth state mismatch'))
        return
      }
      if (params.error) {
        done(false, params.error_description ?? params.error)
        reject(new Error(`Sign-in was declined: ${params.error_description ?? params.error}`))
        return
      }
      if (!params.code) {
        done(false, 'No authorization code was returned.')
        reject(new Error('No authorization code returned'))
        return
      }
      done(true, 'You can close this tab and return to Polycast.')
      resolve({ code: params.code, redirectUri, codeVerifier: verifier, params })
    })

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Sign-in timed out after 5 minutes.'))
    }, opts.timeoutMs ?? 5 * 60_000)
    const onAbort = () => {
      cleanup()
      reject(new Error('Sign-in canceled.'))
    }
    signal?.addEventListener('abort', onAbort)
    function cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      server.close()
    }

    server.on('error', (e: NodeJS.ErrnoException) => {
      cleanup()
      reject(
        e.code === 'EADDRINUSE'
          ? new Error(`Port ${opts.port} is busy. Close the other program or change the redirect port in Settings.`)
          : e
      )
    })
    server.listen(opts.port ?? 0, host, () => {
      const port = (server.address() as AddressInfo).port
      redirectUri = `http://${host}:${port}${path}`
      const url = opts.authorizeUrl({ redirectUri, state, codeChallenge: challenge })
      openExternal(url).catch((e) => {
        cleanup()
        reject(e)
      })
    })
  })
}
