// Builds the ConnectorContext each connector call receives: settings, encrypted secrets, logging,
// progress, network (Chromium's stack, so system proxies work), OAuth, browser profiles, processes.

import { spawn } from 'node:child_process'
import { net, shell } from 'electron'
import type { ConnectorContext } from '../core/connector'
import type { ContextFactory } from '../core/engine'
import { oauthLoopback } from '../core/oauth'
import type { Store } from '../core/store'
import type { Account } from '../shared/types'
import type { BrowserManager } from './browser'
import { qrDataUrl } from './qr'

/** One argument on a Windows command line, quoted the way programs split it back (CommandLineToArgvW). */
export function winQuote(a: string): string {
  if (a && !/[\s"]/.test(a)) return a
  let out = '"'
  let slashes = 0
  for (const ch of a) {
    if (ch === '\\') {
      slashes++
      continue
    }
    out += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`
}

export interface Paths {
  data: string
  profiles: string
  tools: string
  temp: string
  media: string
  plugins: string
}

export function settingString(store: Store, key: string): string | undefined {
  const v = store.getSetting(key)
  if (v === undefined || v === null) return undefined
  return typeof v === 'string' ? v : String(v)
}

export function makeContextFactory(deps: {
  store: Store
  browsers: BrowserManager
  paths: Paths
  onProgress: (scope: string | undefined, fraction: number, note?: string) => void
  /** Something for the Connect window to show while signing in (a QR code to scan). */
  onConnect?: (platform: string, show: { qr?: string; note?: string }) => void
}): ContextFactory {
  const { store, browsers, paths } = deps
  return (platform: string, account: Account | undefined, scope?: string, signal?: AbortSignal) => {
    let pending: unknown
    const abort = signal ?? new AbortController().signal
    let lastLogged = -1
    const ctx: ConnectorContext & { pendingSecrets(): unknown } = {
      setting: (key) => settingString(store, `${platform}.${key}`),
      globalSetting: (key) => settingString(store, key),
      secrets: {
        get: <T>() => (account ? store.getAccountSecret<T>(account.id) : (pending as T | undefined)),
        set: (value) => {
          if (account) store.setAccountSecret(account.id, value)
          else pending = value
        }
      },
      pendingSecrets: () => pending,
      log: (message, level = 'info') => store.log(level, `[${platform}] ${message}`, scope),
      progress: (fraction, note) => {
        deps.onProgress(scope, fraction, note)
        const step = Math.floor(fraction * 4)
        if (step !== lastLogged && fraction < 1) {
          lastLogged = step
          if (step > 0) store.log('info', `[${platform}] ${note ?? 'Progress'} ${Math.round(fraction * 100)}%`, scope)
        }
      },
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        net.fetch(input instanceof URL ? input.toString() : input, { ...init, signal: init?.signal ?? abort } as RequestInit)) as typeof fetch,
      oauthLoopback: (opts) => oauthLoopback(opts, (url) => shell.openExternal(url), abort),
      openExternal: (url) => shell.openExternal(url),
      browser: (key, opts) => browsers.lease(key, opts),
      signInWindow: (key, url, signedIn) => browsers.signIn(key, url, signedIn, abort),
      forgetBrowser: (key) => browsers.forget(key),
      showQr: (text, note) => deps.onConnect?.(platform, { qr: qrDataUrl(text), note }),
      connectStatus: (note) => deps.onConnect?.(platform, { note }),
      exec: (command, args, opts = {}) =>
        new Promise((resolve, reject) => {
          if (opts.newConsole) {
            // A console window of its own with a real terminal, which interactive programs need: started by
            // PowerShell's Start-Process (a child spawned with its input and output redirected has no terminal).
            // In single-quoted PowerShell text any of its four single quotes ends the string: each is doubled.
            const q = (s: string) => `'${s.replace(/['‘’‚‛]/g, (c) => c + c)}'`
            // Batch files would have cmd.exe re-read the arguments (& | > and the like run as commands).
            if (/\.(bat|cmd)$/i.test(command)) return reject(new Error('A console window of its own is only for programs (.exe), not batch files.'))
            const line = args.map(winQuote).join(' ')
            // -WorkingDirectory takes wildcards: [ and ] in a folder name must be escaped.
            const cwd = opts.cwd ? ` -WorkingDirectory ([Management.Automation.WildcardPattern]::Escape(${q(opts.cwd)}))` : ''
            // A program that can't start is an error (exit 9009 and the reason), not a silent success.
            const script = [
              "$ErrorActionPreference = 'Stop'",
              `try { $p = Start-Process -FilePath ${q(command)}${line ? ` -ArgumentList ${q(line)}` : ''}${cwd} -PassThru } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 9009 }`,
              '$null = $p.Handle',
              '$p.WaitForExit()',
              'exit $p.ExitCode'
            ].join('; ')
            if (abort.aborted) return reject(new Error('Canceled.'))
            const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
            let stderr = ''
            let timedOut = false
            p.stderr.setEncoding('utf8')
            p.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-4000)))
            p.stdout.resume()
            // The program runs under PowerShell: ending PowerShell's process tree ends it and its console window too,
            // however early Cancel comes.
            const stop = () => {
              if (p.pid) spawn('taskkill', ['/T', '/F', '/PID', String(p.pid)], { windowsHide: true }).on('error', () => p.kill())
              else p.kill()
            }
            const onAbort = () => {
              stop()
              reject(new Error('Canceled.'))
            }
            abort.addEventListener('abort', onAbort, { once: true })
            const t = opts.timeoutMs
              ? setTimeout(() => {
                  timedOut = true
                  stop()
                }, opts.timeoutMs)
              : undefined
            p.on('error', reject)
            p.on('exit', (code) => {
              if (t) clearTimeout(t)
              abort.removeEventListener('abort', onAbort)
              resolve({ code: code ?? -1, stdout: '', stderr: timedOut ? `Timed out after ${Math.round(opts.timeoutMs! / 1000)} s.` : stderr.trim() })
            })
            return
          }
          const p = spawn(command, args, { cwd: opts.cwd, windowsHide: true, signal: abort })
          let stdout = ''
          let stderr = ''
          let buf = ''
          const t = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : undefined
          const onData = (s: string, which: 'out' | 'err') => {
            if (which === 'out') stdout = (stdout + s).slice(-200_000)
            else stderr = (stderr + s).slice(-200_000)
            buf += s
            const lines = buf.split(/\r?\n|\r/)
            buf = lines.pop() ?? ''
            for (const l of lines) if (l.trim()) opts.onLine?.(l)
          }
          // Decode as a stream so a character split across two chunks is not garbled.
          p.stdout.setEncoding('utf8')
          p.stderr.setEncoding('utf8')
          p.stdout.on('data', (d: string) => onData(d, 'out'))
          p.stderr.on('data', (d: string) => onData(d, 'err'))
          p.on('error', reject)
          p.on('close', (code) => {
            if (t) clearTimeout(t)
            if (buf.trim()) opts.onLine?.(buf)
            resolve({ code: code ?? -1, stdout, stderr })
          })
        }),
      paths: { data: paths.data, profiles: paths.profiles, tools: paths.tools, temp: paths.temp },
      signal: abort
    }
    return ctx
  }
}
