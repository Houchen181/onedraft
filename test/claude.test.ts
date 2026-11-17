// Finding Claude Code: the path set in Settings, `claude` on PATH, the standard install, or the copy inside the
// Claude desktop app (which people who use Claude Code in the app have, without any `claude` command).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { desktopAppClaude, findClaude } from '../src/main/claude-code'

const root = mkdtempSync(join(tmpdir(), 'onedraft-claude-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const touch = (p: string) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, '')
  return p
}

describe.skipIf(process.platform !== 'win32')('finding Claude Code', () => {
  const local = join(root, 'Local')
  const store = join(local, 'Claude-Data', 'claude_pzs8sxrjxfjjc', 'claude-code')
  touch(join(store, '2.0.99', 'claude.exe'))
  touch(join(store, '2.1.300', 'a1b2c3', 'claude.exe'))
  const newest = touch(join(store, '2.1.325', '806e0a45e6f5', 'claude.exe'))
  mkdirSync(join(store, '2.2.0', 'unfinished'), { recursive: true }) // a version still downloading: no exe yet
  const env = { LOCALAPPDATA: local, APPDATA: join(root, 'Roaming'), USERPROFILE: join(root, 'home'), PATH: '' }

  it('finds the newest Claude Code inside the Claude desktop app', () => {
    expect(desktopAppClaude(env)).toBe(newest)
    expect(desktopAppClaude({ ...env, LOCALAPPDATA: join(root, 'nothing') })).toBeUndefined()
  })

  it('prefers the configured path, then PATH, then the standard install, then the desktop app', () => {
    expect(findClaude(undefined, env)).toBe(newest)
    const installed = touch(join(root, 'home', '.local', 'bin', 'claude.exe'))
    expect(findClaude(undefined, env)).toBe(installed)
    const onPath = touch(join(root, 'tools', 'claude.exe'))
    expect(findClaude(undefined, { ...env, PATH: join(root, 'tools') })).toBe(onPath)
    const configured = touch(join(root, 'mine', 'claude.exe'))
    expect(findClaude(configured, { ...env, PATH: join(root, 'tools') })).toBe(configured)
    expect(findClaude(join(root, 'missing.exe'), { ...env, PATH: join(root, 'tools') })).toBe(onPath)
  })
})
