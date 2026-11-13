// Built-in connectors, user plugins and MCP bridges.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import type { Connector } from '../core/connector'
import type { Registry } from '../core/registry'
import { bilibili } from './bilibili'
import { instagram } from './instagram'
import { makeBridge, type BridgeConfig } from './mcp-bridge'
import { rednote } from './rednote'
import { tiktok } from './tiktok'
import { x } from './x'
import { youtube } from './youtube'

export const BUILTINS: Connector[] = [youtube, bilibili, rednote, instagram, tiktok, x]

function looksLikeConnector(c: unknown): c is Connector {
  const k = c as Connector
  return !!k && typeof k === 'object' && !!k.manifest?.id && typeof k.connect === 'function' && typeof k.publish === 'function'
}

/**
 * Load plugins from <dir>/<name>/index.js (CommonJS). Each exports `connector` (or default) implementing
 * the Connector interface from src/core/connector.ts. Returns load errors for the UI.
 */
export function loadPlugins(registry: Registry, dir: string): { loaded: string[]; errors: string[] } {
  const loaded: string[] = []
  const errors: string[] = []
  if (!existsSync(dir)) return { loaded, errors }
  for (const name of readdirSync(dir)) {
    const folder = join(dir, name)
    const entry = join(folder, 'index.js')
    try {
      if (!statSync(folder).isDirectory() || !existsSync(entry)) continue
      const req = createRequire(entry)
      // Forget every module of this plugin so a reload picks up edits to its helper files too.
      for (const key of Object.keys(req.cache)) if (key.startsWith(folder + sep)) delete req.cache[key]
      const mod = req(entry) as { connector?: unknown; default?: unknown }
      const c = mod.connector ?? mod.default
      if (!looksLikeConnector(c)) throw new Error('index.js must export `connector` with manifest, connect() and publish().')
      // A plugin may not take over a built-in platform (it would receive that platform's logins).
      if (BUILTINS.some((b) => b.manifest.id === c.manifest.id)) throw new Error(`id "${c.manifest.id}" is taken by a built-in connector`)
      if (registry.has(c.manifest.id)) throw new Error(`id "${c.manifest.id}" is already used by another plugin`)
      c.manifest.source = 'plugin'
      c.manifest.kind = c.manifest.kind ?? 'plugin'
      registry.register(c)
      loaded.push(c.manifest.id)
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`)
    }
  }
  return { loaded, errors }
}

export function loadBridges(registry: Registry, json: string | undefined): { loaded: string[]; errors: string[] } {
  const loaded: string[] = []
  const errors: string[] = []
  if (!json?.trim()) return { loaded, errors }
  let list: BridgeConfig[]
  try {
    list = JSON.parse(json) as BridgeConfig[]
    if (!Array.isArray(list)) throw new Error('must be a JSON array')
  } catch (e) {
    return { loaded, errors: [`MCP bridges: ${(e as Error).message}`] }
  }
  for (const cfg of list) {
    try {
      if (!cfg || typeof cfg !== 'object' || !cfg.id) throw new Error('each bridge needs an "id"')
      if (BUILTINS.some((b) => b.manifest.id === cfg.id)) throw new Error(`id "${cfg.id}" is taken by a built-in connector`)
      if (registry.has(cfg.id)) throw new Error(`id "${cfg.id}" is already used by a plugin or another bridge`)
      registry.register(makeBridge(cfg))
      loaded.push(cfg.id)
    } catch (e) {
      errors.push(`${cfg?.id ?? '?'}: ${(e as Error).message}`)
    }
  }
  return { loaded, errors }
}
