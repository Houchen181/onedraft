// Built-in connectors, user plugins and MCP bridges.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
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
    const entry = join(dir, name, 'index.js')
    if (!statSync(join(dir, name)).isDirectory() || !existsSync(entry)) continue
    try {
      const req = createRequire(entry)
      delete req.cache[req.resolve(entry)]
      const mod = req(entry) as { connector?: unknown; default?: unknown }
      const c = mod.connector ?? mod.default
      if (!looksLikeConnector(c)) throw new Error('index.js must export `connector` with manifest, connect() and publish().')
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
      if (BUILTINS.some((b) => b.manifest.id === cfg.id)) throw new Error(`id "${cfg.id}" is taken by a built-in connector`)
      registry.register(makeBridge(cfg))
      loaded.push(cfg.id)
    } catch (e) {
      errors.push(`${cfg.id ?? '?'}: ${(e as Error).message}`)
    }
  }
  return { loaded, errors }
}
