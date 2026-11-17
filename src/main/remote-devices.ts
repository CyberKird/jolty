import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { RemoteDevice } from '@shared/remote'
import { dataDir } from './store'

// The paired phones, kept in remote.json. A phone must never be unpaired by the PC having trouble reading this file (Jolty
// starting after an update while the file is held, a crash that left it half written, a data folder on a drive that is not
// mounted yet): such a moment answers "unavailable, try again", never "this phone is unknown". Writes are flushed to disk
// before they replace the file, and the last good copy is kept beside it as remote.json.bak. Only a revoke at the PC
// leaves a record ("revoked") that tells the phone to forget its key.

export const DEFAULT_PORT = 47821
/** how many revoked keys are remembered, so a phone revoked while it was away still learns it was revoked */
const TOMBSTONES = 200

export interface Stored {
  enabled: boolean
  port: number
  devices: Array<RemoteDevice & { hash: string }>
  /** the wake agent: where, and the secret shared with it */
  wake?: { url: string; token: string }
  /** hashes of keys revoked at the PC */
  revoked?: string[]
}

/** A paired phone, a key revoked at the PC, a key never seen, or the list cannot be read right now. */
export type Who = { id: string } | 'revoked' | 'unknown' | 'unavailable'

export const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')

export function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function parse(text: string): Stored {
  const j = JSON.parse(text) as Partial<Stored>
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object')
  return {
    enabled: j.enabled === true,
    port: Number(j.port) || DEFAULT_PORT,
    devices: Array.isArray(j.devices) ? j.devices.filter((d) => d && typeof d.hash === 'string' && typeof d.id === 'string') : [],
    wake: j.wake && typeof j.wake.token === 'string' ? j.wake : undefined,
    revoked: Array.isArray(j.revoked) ? j.revoked.filter((h) => typeof h === 'string').slice(-TOMBSTONES) : undefined
  }
}

/** Writes and flushes a temporary file, then puts it in place: a crash leaves the old file or the new one, never a torn one. */
function writeDurable(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // on Windows a reader holding the file for a moment makes the rename fail: wait a little and try again
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (e) {
      if (attempt >= 5) {
        fs.rmSync(tmp, { force: true })
        throw e
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

export class DeviceStore {
  /** the last list that was read whole */
  private good?: Stored
  /** the file is there but could not be read (nor its copy): nothing may be decided about a phone, and nothing is written over it */
  degraded = false

  file(): string {
    return path.join(dataDir(), 'remote.json')
  }

  private read(file: string): Stored | 'missing' | 'bad' {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return parse(fs.readFileSync(file, 'utf8'))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
        // held by another process for a moment, or being replaced
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      }
    }
    return 'bad'
  }

  load(): Stored {
    const file = this.file()
    const main = this.read(file)
    if (typeof main === 'object') {
      this.degraded = false
      return (this.good = main)
    }
    // the main file is torn or gone: the copy beside it is the last good list
    const bak = this.read(`${file}.bak`)
    if (typeof bak === 'object') {
      this.degraded = false
      return (this.good = bak)
    }
    // nothing was ever paired: no file, no copy, and the folder itself is there (a data folder on a drive not mounted yet is not "nothing")
    if (main === 'missing' && bak === 'missing' && fs.existsSync(dataDir())) {
      this.degraded = false
      return { enabled: false, port: this.good?.port ?? DEFAULT_PORT, devices: [] }
    }
    this.degraded = true
    return this.good ?? { enabled: false, port: DEFAULT_PORT, devices: [] }
  }

  save(s: Stored): void {
    // a list that could not be read is never replaced by a guess: that is how phones would be lost
    if (this.degraded && !this.good) throw new Error('The list of paired phones cannot be read right now. Try again in a moment.')
    const file = this.file()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const text = JSON.stringify(s, null, 2)
    writeDurable(file, text)
    try {
      writeDurable(`${file}.bak`, text)
    } catch {
      // the main file is written; the copy is refreshed next time
    }
    this.good = s
    this.degraded = false
  }

  /** Who a key belongs to. A paired phone's last visit is noted at most once an hour, and a failed note changes nothing. */
  who(token: string): Who {
    if (!token) return 'unknown'
    const s = this.load()
    if (this.degraded && !this.good) return 'unavailable'
    const hash = sha(token)
    const d = s.devices.find((x) => same(x.hash, hash))
    if (d) {
      if (!d.lastSeen || Date.now() - d.lastSeen > 3_600_000) {
        d.lastSeen = Date.now()
        try {
          this.save(s)
        } catch {
          // only the "last seen" time is lost
        }
      }
      return { id: d.id }
    }
    if (s.revoked?.some((h) => same(h, hash))) return 'revoked'
    return this.degraded ? 'unavailable' : 'unknown'
  }

  /** The first of the keys the phone holds that the PC accepts; otherwise the strongest answer about them. */
  whoOf(tokens: Array<string | undefined>): Who {
    let worst: Who = 'unknown'
    for (const t of new Set(tokens.filter((x): x is string => typeof x === 'string' && x.length > 0))) {
      const w = this.who(t)
      if (typeof w === 'object') return w
      if (w === 'unavailable' || (w === 'revoked' && worst === 'unknown')) worst = w
    }
    return worst
  }

  add(name: string): { token: string; id: string } {
    const s = this.load()
    const token = crypto.randomBytes(32).toString('base64url')
    const id = crypto.randomBytes(6).toString('hex')
    s.devices.push({ id, name, created: Date.now(), lastSeen: Date.now(), hash: sha(token) })
    this.save(s)
    return { token, id }
  }

  /** Removes a phone and remembers its key as revoked: the phone is told so the next time it tries, even days later. */
  revoke(id: string): void {
    const s = this.load()
    const gone = s.devices.filter((d) => d.id === id).map((d) => d.hash)
    this.save({ ...s, devices: s.devices.filter((d) => d.id !== id), revoked: [...(s.revoked ?? []), ...gone].slice(-TOMBSTONES) })
  }
}
