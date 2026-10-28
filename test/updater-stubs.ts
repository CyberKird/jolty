// electron and electron-updater stand-ins for test/updater-test.ts
import { EventEmitter } from 'node:events'

export const shown: string[] = []
export const app = { getVersion: () => '0.5.3', isPackaged: false, on: () => undefined }
export class Notification {
  constructor(private o: { title: string }) {}
  static isSupported(): boolean {
    return true
  }
  on(): void {}
  show(): void {
    shown.push(this.o.title)
  }
}
class Updater extends EventEmitter {
  logger: unknown = undefined
  autoDownload = false
  autoInstallOnAppQuit = false
  installs = 0
  next: () => Promise<unknown> = () => Promise.resolve(null)
  checkForUpdates(): Promise<unknown> {
    return this.next()
  }
  quitAndInstall(): void {
    this.installs++
  }
  /** the version downloadUpdate() reports as downloaded */
  pending = ''
  downloads = 0
  async downloadUpdate(): Promise<void> {
    this.downloads++
    this.emit('update-downloaded', { version: this.pending })
  }
}
export const autoUpdater = new Updater()
export default { autoUpdater }
