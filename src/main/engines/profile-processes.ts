import { execFile, type ChildProcess } from 'child_process'
import { tr } from '../../shared/i18n'

/** Child processes that must release a profile's files before it can be removed. */
export class ProfileProcesses {
  private processes = new Map<string, Set<ChildProcess>>()

  track(id: string, child: ChildProcess): ChildProcess {
    let children = this.processes.get(id)
    if (!children) this.processes.set(id, children = new Set())
    children.add(child)
    const forget = (): void => {
      children.delete(child)
      if (!children.size && this.processes.get(id) === children) this.processes.delete(id)
    }
    child.once('close', forget)
    child.once('error', forget)
    return child
  }

  async stop(id: string): Promise<void> {
    await Promise.all([...this.processes.get(id) || []].map((child) => new Promise<void>((resolve, reject) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve()
      const timer = setTimeout(() => {
        child.removeListener('close', done)
        reject(new Error(tr("Procesul de autentificare nu s-a oprit.")))
      }, 10000)
      const done = (): void => {
        clearTimeout(timer)
        resolve()
      }
      child.once('close', done)
      if (process.platform === 'win32') {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {})
      } else child.kill('SIGTERM')
    })))
  }
}
