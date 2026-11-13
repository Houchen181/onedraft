// Studio: saved edit projects (human edits and Claude-generated videos) and their renders.
// Rendering of HTML compositions and speech synthesis need Electron/Windows, so they are injected.

import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { CompositionSpec, EditProject, EditSpec, MediaInfo } from '../shared/types'
import { renderEdit } from './edit'
import type { MediaTools } from './media'
import type { Store } from './store'

export interface Voice {
  name: string
  culture: string
  gender: string
}

export interface StudioPlatform {
  /** Render an HTML composition (with optional narration WAV) to `out`. */
  renderComposition(c: CompositionSpec, out: string, workDir: string, narration: string | undefined, onProgress: (f: number) => void, signal?: AbortSignal): Promise<MediaInfo>
  /** Text to speech → WAV. */
  speak(text: string, out: string, voice?: string, rate?: number): Promise<void>
  voices(): Promise<Voice[]>
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'video'

export class Studio {
  readonly editsDir: string
  readonly generatedDir: string
  private running = new Map<string, AbortController>()

  constructor(
    private store: Store,
    private tools: MediaTools,
    mediaDir: string,
    private platform: StudioPlatform | undefined,
    private onProgress: (projectId: string, fraction: number, note?: string) => void = () => undefined
  ) {
    this.editsDir = join(mediaDir, 'edits')
    this.generatedDir = join(mediaDir, 'generated')
  }

  list() {
    return this.store.listProjects()
  }

  get(id: string): EditProject {
    const p = this.store.getProject(id)
    if (!p) throw new Error(`Unknown project ${id}`)
    return p
  }

  /** Is this file AI-generated (rendered from a composition, or an edit that used one)? */
  isAiMedia = (path: string): boolean => {
    // Windows paths are case-insensitive: "c:/users/..." and "C:/Users/..." are the same file.
    const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
    const full = norm(path)
    if (full.startsWith(norm(this.generatedDir) + sep)) return true
    return this.store.listProjects().some((p) => p.aiGenerated && p.output && norm(p.output) === full)
  }

  saveEdit(p: { id?: string; name?: string; spec: EditSpec }): EditProject {
    const old = p.id ? this.get(p.id) : undefined
    return this.store.saveProject({
      id: p.id,
      name: p.name ?? old?.name ?? 'Untitled edit',
      kind: 'edit',
      spec: p.spec,
      output: old?.output,
      aiGenerated: p.spec.clips.some((c) => this.isAiMedia(c.src))
    })
  }

  saveGenerated(p: { id?: string; name?: string; prompt?: string; composition: CompositionSpec }): EditProject {
    const old = p.id ? this.get(p.id) : undefined
    return this.store.saveProject({
      id: p.id,
      name: p.name ?? old?.name ?? 'Generated video',
      kind: 'generated',
      composition: p.composition,
      prompt: p.prompt ?? old?.prompt,
      output: old?.output,
      aiGenerated: true
    })
  }

  remove(id: string) {
    this.running.get(id)?.abort()
    this.store.removeProject(id)
  }

  cancel(id: string) {
    this.running.get(id)?.abort()
  }

  async render(id: string): Promise<{ project: EditProject; info: MediaInfo }> {
    const p = this.get(id)
    if (this.running.has(id)) throw new Error('Already rendering.')
    const ac = new AbortController()
    this.running.set(id, ac)
    // Unique per render: two renders in the same second (or of two projects with one name) never share a file.
    const stamp = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${randomUUID().slice(0, 6)}`
    const work = join(this.editsDir, '.work', `${id}-${randomUUID().slice(0, 8)}`)
    try {
      let info: MediaInfo
      if (p.kind === 'edit') {
        if (!p.spec) throw new Error('This project has no edit yet.')
        const ai = p.spec.clips.some((c) => this.isAiMedia(c.src))
        const out = join(ai ? this.generatedDir : this.editsDir, `${slug(p.name)}-${stamp}.mp4`)
        this.onProgress(id, 0, 'Rendering')
        info = await renderEdit(this.tools, p.spec, out, work, (f) => this.onProgress(id, f, 'Rendering'), ac.signal)
      } else {
        if (!p.composition) throw new Error('This project has no composition yet.')
        if (!this.platform) throw new Error('Video generation needs the desktop app.')
        const c = p.composition
        let narration: string | undefined
        if (c.narration?.text.trim()) {
          this.onProgress(id, 0, 'Recording narration')
          narration = join(work, 'narration.wav')
          await this.platform.speak(c.narration.text, narration, c.narration.voice, c.narration.rate)
        }
        if (c.music?.src && !existsSync(c.music.src)) throw new Error(`Music file not found: ${c.music.src}`)
        const out = join(this.generatedDir, `${slug(p.name)}-${stamp}.mp4`)
        info = await this.platform.renderComposition(c, out, work, narration, (f) => this.onProgress(id, f, 'Rendering frames'), ac.signal)
      }
      this.onProgress(id, 1, 'Done')
      // Only record the output: the project may have been edited (or deleted) while it rendered.
      const project = this.store.setProjectOutput(id, info.path) ?? { ...p, output: info.path }
      return { project, info }
    } finally {
      this.running.delete(id)
      rmSync(work, { recursive: true, force: true })
    }
  }

  async voices(): Promise<Voice[]> {
    return this.platform ? this.platform.voices() : []
  }

  /** Synthesize speech on its own (so the assistant can time a composition to it). */
  async narration(text: string, voice?: string, rate?: number): Promise<string> {
    if (!this.platform) throw new Error('Speech needs the desktop app.')
    const out = join(this.generatedDir, 'narration', `${slug(text.slice(0, 30))}-${randomUUID().slice(0, 8)}.wav`)
    await this.platform.speak(text, out, voice, rate)
    return out
  }
}
