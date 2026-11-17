// Updates from GitHub Releases (electron-updater). The installed app looks for a newer version at start and every
// few hours, downloads it in the background (checked against the SHA-512 in the release's latest.yml), and installs
// it when you press "Restart to update", or the next time you quit. Development runs never update.

import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

/** electron-updater's errors can carry a whole HTTP response; the first line says what went wrong. */
const brief = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0].trim().slice(0, 300)

export class Updater {
  status: UpdateStatus

  constructor(
    private o: {
      onChange: (s: UpdateStatus) => void
      /** Is something publishing right now? Restarting would interrupt it. */
      busy: () => boolean
      log: (level: 'info' | 'warn' | 'error', message: string) => void
      /** Called before quitting to install (lets the window really close). */
      beforeQuit: () => void
    }
  ) {
    this.status = { state: app.isPackaged ? 'idle' : 'dev', current: app.getVersion() }
    if (!app.isPackaged) return
    // For trying a release before publishing it: a folder served over http with latest.yml and the installer.
    const feed = process.env.ONEDRAFT_UPDATE_URL
    if (feed && /^https?:\/\//.test(feed)) autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'none', checkedAt: new Date().toISOString(), version: undefined, error: undefined }))
    autoUpdater.on('update-available', (info) => {
      this.set({ state: 'downloading', version: info.version, progress: 0, error: undefined })
      this.o.log('info', `OneDraft ${info.version} is out; downloading it.`)
    })
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', progress: Math.min(1, p.percent / 100) }))
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ state: 'ready', version: info.version, progress: 1, checkedAt: new Date().toISOString() })
      this.o.log('info', `OneDraft ${info.version} is ready: it installs when you restart OneDraft.`)
    })
    autoUpdater.on('error', (e) => {
      this.set({ state: 'error', error: brief(e), checkedAt: new Date().toISOString() })
      this.o.log('warn', `Update: ${brief(e)}`)
    })
  }

  private set(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch }
    this.o.onChange(this.status)
  }

  /** Look for a newer version now (quietly does nothing in development). */
  check(): UpdateStatus {
    if (!app.isPackaged) return this.status
    if (this.status.state === 'checking' || this.status.state === 'downloading' || this.status.state === 'ready') return this.status
    autoUpdater
      .checkForUpdates()
      // A failed download is reported through the 'error' event; don't leave its promise rejected and unhandled.
      .then((r) => void r?.downloadPromise?.catch(() => undefined))
      .catch((e) => this.set({ state: 'error', error: brief(e), checkedAt: new Date().toISOString() }))
    return this.status
  }

  /** Quit and install the downloaded version, then start it again. */
  install(): void {
    if (this.status.state !== 'ready') throw new Error('No update is ready yet.')
    if (this.o.busy()) throw new Error('A post is publishing right now. Restart to update once it has finished.')
    this.o.beforeQuit()
    // Silent install, then OneDraft starts again.
    autoUpdater.quitAndInstall(true, true)
  }
}
