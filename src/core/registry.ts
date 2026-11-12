// Holds every connector the app knows: built-ins, user plugins and MCP bridges.

import type { PlatformManifest } from '../shared/types'
import type { Connector } from './connector'

export class Registry {
  private connectors = new Map<string, Connector>()

  register(c: Connector) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(c.manifest.id)) throw new Error(`Bad connector id "${c.manifest.id}"`)
    this.connectors.set(c.manifest.id, c)
  }

  unregister(id: string) {
    this.connectors.delete(id)
  }

  get(id: string): Connector {
    const c = this.connectors.get(id)
    if (!c) throw new Error(`No connector for platform "${id}". Is its plugin installed?`)
    return c
  }

  has(id: string) {
    return this.connectors.has(id)
  }

  manifests(): PlatformManifest[] {
    return [...this.connectors.values()].map((c) => c.manifest)
  }
}
