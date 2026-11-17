// What the phone tells the PC about the screen stream, so the PC can fit it to the link (main/remote-screen-adapt.ts):
// an ack with the newest chunk number as soon as a chunk arrives (at most every 40 ms, at once for a whole picture), and
// once a second how many pictures were decoded and drawn and how long decoding took. Also reads the chunk heads.
// No DOM here: the link test drives the same code from Node.

export const BIN_JPEG = 1
export const BIN_VIDEO = 2
export const BIN_AUDIO = 3

export interface Chunk {
  kind: number
  /** a whole picture (video) */
  key: boolean
  /** microseconds (video, sound) */
  ts: number
  seq: number
  /** pointer as a fraction of the display, -1 when it is elsewhere (JPEG) */
  cx: number
  cy: number
  data: Uint8Array
}

/** The head of a binary message from the PC (see main/remote-screen.ts for the layout). */
export function parseChunk(buf: ArrayBuffer): Chunk | undefined {
  if (buf.byteLength < 1) return undefined
  const v = new DataView(buf)
  const kind = v.getUint8(0)
  if (kind === BIN_VIDEO && buf.byteLength >= 14) return { kind, key: v.getUint8(1) === 1, ts: v.getFloat64(2, true), seq: v.getUint32(10, true), cx: -1, cy: -1, data: new Uint8Array(buf, 14) }
  if (kind === BIN_AUDIO && buf.byteLength >= 13) return { kind, key: true, ts: v.getFloat64(1, true), seq: v.getUint32(9, true), cx: -1, cy: -1, data: new Uint8Array(buf, 13) }
  if (kind === BIN_JPEG && buf.byteLength >= 9) {
    const x = v.getUint16(1, true)
    const y = v.getUint16(3, true)
    return { kind, key: true, ts: 0, seq: v.getUint32(5, true), cx: x === 65535 ? -1 : x / 65534, cy: y === 65535 ? -1 : y / 65534, data: new Uint8Array(buf, 9) }
  }
  return undefined
}

/** What the phone measured over the last second, for the small indicator. */
export interface LocalStats {
  /** pictures drawn per second */
  fps: number
  /** kilobits per second received */
  kbps: number
  /** average decode time, ms */
  decMs: number
  /** chunks received */
  rx: number
}

const ACK_GAP = 40

export class Feedback {
  private acked = -1
  private newest = -1
  private lastAck = -Infinity
  private timer?: ReturnType<typeof setTimeout>
  private bytes = 0
  private drawn = 0
  private decoded = 0
  private decTotal = 0
  private maxQ = 0
  private clock?: ReturnType<typeof setInterval>
  /** the last second, as measured here */
  local: LocalStats = { fps: 0, kbps: 0, decMs: 0, rx: 0 }
  private rx = 0

  constructor(
    private send: (m: Record<string, unknown>) => void,
    private now: () => number = () => performance.now(),
    /** how often the report goes, ms (0: never by itself, the caller calls report()) */
    every = 1000
  ) {
    if (every > 0) this.clock = setInterval(() => this.report(), every)
  }

  /** A chunk arrived. `now`: answer at once (whole pictures, and pictures that were just shown). */
  got(seq: number, bytes: number, now = false): void {
    this.bytes += bytes
    this.rx++
    if (seq > this.newest || this.newest - seq > 2 ** 31) this.newest = seq
    const t = this.now()
    if (now || t - this.lastAck >= ACK_GAP) return this.ack()
    this.timer ??= setTimeout(() => this.ack(), Math.max(0, this.lastAck + ACK_GAP - t))
  }

  private ack(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.newest === this.acked) return
    this.acked = this.newest
    this.lastAck = this.now()
    this.send({ op: 'ack', seq: this.newest })
  }

  decodedOne(ms: number, queue: number): void {
    this.decoded++
    this.decTotal += ms
    this.maxQ = Math.max(this.maxQ, queue)
  }

  drawnOne(): void {
    this.drawn++
  }

  /** Once a second: to the PC, and kept for the indicator. */
  report(): LocalStats {
    const decMs = this.decoded ? Math.round((this.decTotal / this.decoded) * 10) / 10 : 0
    this.local = { fps: this.drawn, kbps: Math.round((this.bytes * 8) / 1000), decMs, rx: this.rx }
    this.send({ op: 'stats', fps: this.drawn, dec: this.decoded, decMs, q: this.maxQ })
    this.bytes = this.drawn = this.decoded = this.decTotal = this.maxQ = this.rx = 0
    return this.local
  }

  /** A new stream (another display, a reconnect): numbers start again from the PC. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.acked = this.newest = -1
    this.lastAck = -Infinity
  }

  close(): void {
    this.reset()
    if (this.clock) clearInterval(this.clock)
  }
}
