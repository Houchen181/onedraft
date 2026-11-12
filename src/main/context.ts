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
      exec: (command, args, opts = {}) =>
        new Promise((resolve, reject) => {
          if (opts.newConsole) {
            // Its own console window (for interactive CLIs like `biliup login`).
            const p = spawn(command, args, { cwd: opts.cwd, detached: true, stdio: 'ignore', windowsHide: false, signal: abort })
            const t = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : undefined
            p.on('error', reject)
            p.on('exit', (code) => {
              if (t) clearTimeout(t)
              resolve({ code: code ?? -1, stdout: '', stderr: '' })
            })
            return
          }
          const p = spawn(command, args, { cwd: opts.cwd, windowsHide: true, signal: abort })
          let stdout = ''
          let stderr = ''
          let buf = ''
          const t = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : undefined
          const onData = (d: Buffer, which: 'out' | 'err') => {
            const s = d.toString('utf8')
            if (which === 'out') stdout = (stdout + s).slice(-200_000)
            else stderr = (stderr + s).slice(-200_000)
            buf += s
            const lines = buf.split(/\r?\n|\r/)
            buf = lines.pop() ?? ''
            for (const l of lines) if (l.trim()) opts.onLine?.(l)
          }
          p.stdout.on('data', (d: Buffer) => onData(d, 'out'))
          p.stderr.on('data', (d: Buffer) => onData(d, 'err'))
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
