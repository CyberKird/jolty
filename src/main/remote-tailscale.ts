import { execFile } from 'child_process'
import fs from 'fs'

const WIN_PATH = 'C:\Program Files\Tailscale\tailscale.exe'

function binary(): string {
  return process.platform === 'win32' && fs.existsSync(WIN_PATH) ? WIN_PATH : 'tailscale'
}

/** Runs the CLI. `refusal`: output that means it will wait for the user (Serve switched on in the account): stop at once and report it. */
function run(args: string[], timeout = 15000, refusal?: RegExp): Promise<{ out: string; err?: string }> {
  return new Promise((resolve) => {
    let done = false
    const finish = (r: { out: string; err?: string }): void => {
      if (!done) resolve(r)
      done = true
    }
    const child = execFile(binary(), args, { windowsHide: true, timeout, maxBuffer: 1 << 20 }, (error, stdout, stderr) =>
      // the CLI explains a refusal on stdout ("Serve is not enabled on your tailnet. To enable, visit: ...")
      finish({ out: String(stdout), err: error ? (String(stderr).trim() || String(stdout).trim() || error.message).slice(0, 500) : undefined })
    )
    if (refusal) {
      let seen = ''
      child.stdout?.on('data', (c: Buffer) => {
        seen += c
        if (refusal.test(seen)) {
          finish({ out: seen, err: seen.trim().slice(0, 500) })
          child.kill()
        }
      })
    }
  })
}

export interface TailscaleInfo {
  state: 'missing' | 'off' | 'ready'
  /** this PC's name on the tailnet, e.g. aron.tail1234.ts.net */
  dns?: string
}

export async function info(): Promise<TailscaleInfo> {
  const r = await run(['status', '--json'], 8000)
  if (!r.out.trim()) return { state: r.err && /ENOENT|not recognized|not found/i.test(r.err) ? 'missing' : 'off' }
  try {
    const j = JSON.parse(r.out) as { BackendState?: string; Self?: { DNSName?: string } }
    const dns = j.Self?.DNSName?.replace(/\.$/, '')
    return j.BackendState === 'Running' && dns ? { state: 'ready', dns } : { state: 'off' }
  } catch {
    return { state: 'off' }
  }
}

interface ServeStatus {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
}

async function webConfig(): Promise<ServeStatus['Web']> {
  const s = await run(['serve', 'status', '--json'], 8000)
  try {
    return (JSON.parse(s.out || '{}') as ServeStatus).Web || {}
  } catch {
    return {}
  }
}

/** The address this PC serves `port` on over HTTPS (tailscale serve), or undefined when it does not. */
export async function served(port: number): Promise<string | undefined> {
  const [i, web] = await Promise.all([info(), webConfig()])
  if (i.state !== 'ready' || !i.dns) return undefined
  for (const [host, cfg] of Object.entries(web || {})) {
    if (Object.values(cfg.Handlers || {}).some((h) => h.Proxy === `http://127.0.0.1:${port}`)) return `https://${host.replace(/:443$/, '')}`
  }
  return undefined
}

/** Makes `port` reachable at https://<this PC>.ts.net, only inside the tailnet. Throws the CLI's own message when Tailscale refuses. */
export async function serve(port: number): Promise<string> {
  const i = await info()
  if (i.state !== 'ready' || !i.dns) throw new Error(i.state === 'missing' ? 'Tailscale is not installed' : 'Tailscale is signed out')
  // never replace what the user already serves on 443 with something else
  const taken = Object.entries((await webConfig()) || {}).find(([host, cfg]) => host.endsWith(':443') && !Object.values(cfg.Handlers || {}).every((h) => h.Proxy === `http://127.0.0.1:${port}`))
  if (taken) throw new Error('Tailscale Serve already shares something else on port 443. Turn that off first (tailscale serve reset), or choose another way.')
  const r = await run(['serve', '--bg', '--yes', '--https=443', `http://127.0.0.1:${port}`], 20000, /https:\/\/login\.tailscale\.com\/\S+/)
  if (r.err) throw new Error(r.err)
  return `https://${i.dns}`
}

/** Stops sharing, but only what this app shared: the user's own Serve settings stay. */
export async function unserve(port: number): Promise<void> {
  if (await served(port)) await run(['serve', '--https=443', 'off'], 10000)
}
