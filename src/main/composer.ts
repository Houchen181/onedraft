// Claude-generated video: the assistant writes an HTML page whose CSS/Web animations (or a
// window.onedraftSeek(t) hook for canvas/JS drawing) describe the video. OneDraft loads it in an
// offscreen, sandboxed, network-blocked window, seeks to every frame time, captures the pixels and
// pipes them into ffmpeg. Deterministic: the same HTML always gives the same video.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BrowserWindow, session } from 'electron'
import { frameFor, probe, type MediaTools } from '../core/media'
import type { CompositionSpec, MediaInfo } from '../shared/types'

const PARTITION = 'onedraft-render'
let sessionReady = false

function renderSession(mediaHandler: (req: Request) => Response | Promise<Response>) {
  const ses = session.fromPartition(PARTITION)
  if (!sessionReady) {
    // No network: compositions are self-contained (inline assets, file:// or onedraft-media:// paths).
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^(https?|wss?|ftp):/i.test(d.url) }))
    ses.protocol.handle('onedraft-media', mediaHandler)
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    sessionReady = true
  }
  return ses
}

const SEEK = `
window.__pcSeek = async (t) => {
  for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = t * 1000 } catch (e) {} }
  const vids = [...document.querySelectorAll('video')]
  await Promise.all(vids.map((v) => new Promise((r) => {
    v.muted = true; v.pause()
    const target = Math.min(t, isFinite(v.duration) ? Math.max(0, v.duration - 0.001) : t)
    if (Math.abs(v.currentTime - target) < 0.0005) return r()
    const done = () => { v.removeEventListener('seeked', done); r() }
    v.addEventListener('seeked', done); setTimeout(done, 1500); v.currentTime = target
  })))
  if (typeof window.onedraftSeek === 'function') await window.onedraftSeek(t)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  return true
}
window.__pcReady = async () => {
  await document.fonts.ready
  const imgs = [...document.images].filter((i) => !i.complete)
  await Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 5000) })))
  const vids = [...document.querySelectorAll('video')].filter((v) => v.readyState < 2)
  await Promise.all(vids.map((v) => new Promise((r) => { v.onloadeddata = v.onerror = r; setTimeout(r, 5000) })))
  if (typeof window.onedraftReady === 'function') await window.onedraftReady()
  return true
}
true
`

export function compositionSize(c: CompositionSpec) {
  const { w, h } = frameFor(c.aspect || '9:16', c.longSide ?? 1920)
  return { width: w, height: h }
}

/** Put the size/duration where the page can read it, and a reset so the page fills the frame. */
export function wrapHtml(c: CompositionSpec): string {
  const { width, height } = compositionSize(c)
  const head = `<script>window.ONEDRAFT=${JSON.stringify({ width, height, duration: c.durationSec, fps: c.fps ?? 30 })}</script>` +
    `<style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}</style>`
  if (/<head[^>]*>/i.test(c.html)) return c.html.replace(/<head[^>]*>/i, (m) => `${m}${head}`)
  if (/<!doctype[^>]*>/i.test(c.html)) return c.html.replace(/<!doctype[^>]*>/i, (m) => `${m}<head>${head}</head>`)
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${c.html}</body></html>`
}

export async function renderComposition(
  c: CompositionSpec,
  out: string,
  workDir: string,
  narration: string | undefined,
  deps: { tools: MediaTools; mediaHandler: (req: Request) => Response | Promise<Response> },
  onProgress: (f: number) => void,
  signal?: AbortSignal
): Promise<MediaInfo> {
  if (!(c.durationSec > 0 && c.durationSec <= 600)) throw new Error('durationSec must be between 0 and 600.')
  const fps = Math.min(60, Math.max(12, Math.round(c.fps ?? 30)))
  const { width: W, height: H } = compositionSize(c)
  mkdirSync(workDir, { recursive: true })
  mkdirSync(dirname(out), { recursive: true })
  const page = join(workDir, 'composition.html')
  writeFileSync(page, wrapHtml(c), 'utf8')

  renderSession(deps.mediaHandler)
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: PARTITION, backgroundThrottling: false }
  })
  win.setContentSize(W, H)
  win.webContents.setFrameRate(240)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  // ffmpeg: raw BGRA frames on stdin, plus narration/music, plus a silent bed so there's always audio.
  const args = ['-hide_banner', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${W}x${H}`, '-r', String(fps), '-i', 'pipe:0']
  const audio: string[] = []
  let idx = 1
  args.push('-f', 'lavfi', '-t', String(c.durationSec), '-i', 'anullsrc=r=48000:cl=stereo')
  audio.push(`[${idx++}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[bed]`)
  const mix = ['[bed]']
  if (narration) {
    args.push('-i', narration)
    audio.push(`[${idx++}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[nar]`)
    mix.push('[nar]')
  }
  if (c.music?.src) {
    args.push('-stream_loop', '-1', '-i', c.music.src)
    audio.push(`[${idx++}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${c.music.volume ?? (narration ? 0.15 : 0.6)}[mus]`)
    mix.push('[mus]')
  }
  const fade = Math.min(1, c.durationSec / 4)
  audio.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:normalize=0,afade=t=out:st=${Math.max(0, c.durationSec - fade)}:d=${fade}[aout]`)
  args.push(
    '-filter_complex', audio.join(';'),
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-t', String(c.durationSec), '-movflags', '+faststart', out
  )
  const ff = spawn(deps.tools.ffmpeg, args, { windowsHide: true })
  let ffErr = ''
  ff.stderr.on('data', (d) => (ffErr = (ffErr + d).slice(-4000)))
  const done = new Promise<void>((resolve, reject) => {
    ff.on('error', reject)
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${ffErr.trim().split('\n').slice(-4).join('\n')}`))))
  })
  done.catch(() => undefined) // awaited below; this only keeps an early ffmpeg exit from being an unhandled rejection
  ff.stdin.on('error', () => undefined) // writing after ffmpeg exits is reported through `done` and write()
  const write = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (ff.stdin.destroyed) return reject(new Error(`ffmpeg stopped: ${ffErr.slice(-300)}`))
      ff.stdin.write(buf, (e) => (e ? reject(e) : resolve()))
    })

  // A page that loops forever or never resolves its hooks must not hang the render: every step has a deadline,
  // and canceling stops a step that is stuck. Destroying the window afterwards kills the stuck page.
  const step = <T>(p: Promise<T>, ms: number, what: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s. Check the page's script.`)), ms)
      const onAbort = () => reject(new Error('Canceled.'))
      signal?.addEventListener('abort', onAbort, { once: true })
      p.then(resolve, reject).finally(() => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      })
    })
  const js = <T = unknown>(code: string, ms: number, what: string) => step(win.webContents.executeJavaScript(code) as Promise<T>, ms, what)

  try {
    if (signal?.aborted) throw new Error('Canceled.')
    await step(win.loadFile(page), 30_000, 'Loading the page')
    await js(SEEK, 10_000, 'Starting the page')
    await js('window.__pcReady()', 30_000, 'Getting the page ready (fonts, images, onedraftReady)')
    const total = Math.round(c.durationSec * fps)
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new Error('Canceled.')
      await js(`window.__pcSeek(${i / fps})`, 10_000, `Drawing frame ${i + 1} (onedraftSeek)`)
      let img = await step(win.webContents.capturePage(), 10_000, `Capturing frame ${i + 1}`)
      const s = img.getSize()
      if (s.width !== W || s.height !== H) img = img.resize({ width: W, height: H })
      const bmp = img.toBitmap()
      if (bmp.length !== W * H * 4) throw new Error(`Captured frame has the wrong size (${img.getSize().width}×${img.getSize().height}).`)
      await write(bmp)
      if (i % 5 === 0) onProgress(i / total)
    }
    ff.stdin.end()
    await done
  } catch (e) {
    ff.kill()
    throw new Error(`Could not render the video: ${(e as Error).message}`)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
  onProgress(1)
  return probe(deps.tools, out)
}
