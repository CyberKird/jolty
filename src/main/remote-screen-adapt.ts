// How much of the PC's screen a phone gets, decided from what its link and the phone itself show, not from guesses.
// Every picture and sound chunk carries a number; the phone answers with the newest number it has (an ack). From that:
//   latency  = how long the newest acked chunk took from leaving the PC to the phone answering
//   base     = the smallest latency of the last 10 s (the link with nothing queued)
//   goodput  = bytes acked per second
// A queue building up shows as latency above the base. Then the quality steps down at once (several steps when goodput says
// the link is far below the step), and comes back one step at a time only after a calm hold that doubles each time a step
// up fails. Bytes in the air are kept under a window sized from the step and the base, so a slow link never piles up more
// than a fraction of a second of pictures: what does not fit is dropped and the phone gets a whole picture later instead.
// Pure: time comes in as arguments, so tests drive it with their own clock.

export interface Step {
  name: string
  fps: number
  /** long edge of the video picture, in pixels (never more than the display's own, nor than the phone decodes) */
  edge: number
  /** long edge of a JPEG picture, for phones without video (a JPEG costs far more per pixel than video) */
  jpegEdge: number
  bps: number
  /** seconds between whole pictures when nothing asks for one */
  gopSec: number
  /** the PC's sound is sent at this step */
  audio: boolean
  /** pointer updates per second */
  cursorHz: number
  /** JPEG quality for phones without video */
  jpegQ: number
  /** every picture is a whole one, sent only when the last one arrived: the floor for the worst links */
  keyOnly?: boolean
}

// What the phone reads is mostly text, so a step keeps pixels and gives up pictures per second first. Measured on a 4K
// desktop with the PC's hardware encoder (PSNR against the screen itself, a still screen / one scrolling 400 px/s):
//   4K60 12 Mbit/s 44.4 scrolling (8 Mbit/s falls apart at 4K60: 23.5)   where 1080p60 8 Mbit/s was 31.0 / 31.1
//   4K30 4 Mbit/s 43.6 / 39.4        where 1080p30 was 31.0 / 31.0
//   1440p30 2 Mbit/s 34.2 / 32.1     where 720p was 28.2 / 28.1
//   1080p20 1 Mbit/s 31.0 / 30.3     where 540p was 26.8 / 27.1
//   720p15 500k 28.2 / 27.8, 540p10 220k 26.8 / 27.1   where 480p and 360p were 26.5 / 26.6 and 25.7 / 26.0
// A smaller picture blown up on the phone was the blur, not the bits: a still screen costs a video encoder almost
// nothing whatever its size. Below 1 Mbit/s a bigger picture than this loses while scrolling, so the sizes stop there.
export const LADDER: readonly Step[] = [
  { name: '60/2160p', fps: 60, edge: 3840, jpegEdge: 1920, bps: 12_000_000, gopSec: 8, audio: true, cursorHz: 60, jpegQ: 72 },
  { name: '30/2160p', fps: 30, edge: 3840, jpegEdge: 1920, bps: 4_000_000, gopSec: 8, audio: true, cursorHz: 30, jpegQ: 68 },
  { name: '30/1440p', fps: 30, edge: 2560, jpegEdge: 1280, bps: 2_000_000, gopSec: 8, audio: true, cursorHz: 30, jpegQ: 64 },
  { name: '20/1080p', fps: 20, edge: 1920, jpegEdge: 960, bps: 1_000_000, gopSec: 8, audio: true, cursorHz: 20, jpegQ: 60 },
  { name: '15/720p', fps: 15, edge: 1280, jpegEdge: 854, bps: 500_000, gopSec: 8, audio: false, cursorHz: 15, jpegQ: 55 },
  { name: '10/540p', fps: 10, edge: 960, jpegEdge: 640, bps: 220_000, gopSec: 8, audio: false, cursorHz: 10, jpegQ: 50 },
  { name: '5/540p', fps: 5, edge: 960, jpegEdge: 640, bps: 110_000, gopSec: 10, audio: false, cursorHz: 8, jpegQ: 45 },
  { name: 'slideshow', fps: 1, edge: 640, jpegEdge: 640, bps: 50_000, gopSec: 1, audio: false, cursorHz: 5, jpegQ: 40, keyOnly: true }
]

/** A new phone starts low (a bad link is not flooded by the first pictures) and climbs fast until the link first pushes back. */
export const START_LEVEL = 5
const UP_BASE = 1500
/** the hold between steps up before the first sign of congestion */
const UP_START = 600
const UP_MAX = 30_000

/** What the phone says about itself once a second. */
export interface PhoneReport {
  /** pictures drawn per second */
  fps?: number
  /** pictures decoded per second */
  dec?: number
  /** average decode time, ms */
  decMs?: number
  /** largest decode queue seen */
  q?: number
}

export interface AdaptStats {
  level: number
  step: string
  /** ms, newest chunks */
  lat: number
  /** ms, the link with nothing queued */
  rtt: number
  /** acked kilobits per second */
  kbps: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The highest step whose bitrate fits in `bps`. */
export function stepFor(bps: number): number {
  const i = LADDER.findIndex((s) => s.bps <= bps)
  return i < 0 ? LADDER.length - 1 : i
}

export class Adapt {
  level: number
  /** the PC is busy: the best step allowed (0 = everything) */
  floor = 0
  private flights: Array<{ seq: number; bytes: number; at: number; clean: boolean }> = []
  private inflight = 0
  private lats: Array<{ at: number; ms: number; small: boolean }> = []
  private acks: Array<{ at: number; bytes: number }> = []
  private firstAck = -1
  private busy: boolean[] = []
  private lastChange: number
  private lastDown = -Infinity
  private lastUp = -Infinity
  private lastCongest = -Infinity
  private lastDecay: number
  private upHold = UP_BASE
  private everCongested = false
  private baseAtBackoff = Infinity
  private lastAckAt = -Infinity
  private inCut = false
  private cutUntil = -Infinity
  private overload = 0
  private lastKeyAsk = -Infinity
  /** the phone's last word on itself */
  lastReport: PhoneReport = {}
  private refusals: number[] = []
  private queued = 0
  private cutStepped = false

  /** ms to wait after a calm spell before the next step up (doubles after each failed try) */
  get holdUp(): number {
    return this.upHold
  }

  constructor(now: number, level = START_LEVEL) {
    this.level = level
    this.lastChange = now
    this.lastDecay = now
  }

  get step(): Step {
    return LADDER[this.level]
  }

  /** bytes sent and not yet acked */
  get inFlight(): number {
    return this.inflight
  }

  /** ms the oldest unanswered chunk has been out, 0 when none */
  oldest(now: number): number {
    return this.flights.length ? now - this.flights[0].at : 0
  }

  /** The phone will never answer for what is out (it hid the page): start counting again. */
  forget(): void {
    this.flights = []
    this.inflight = 0
  }

  sent(seq: number, bytes: number, now: number): void {
    // clean: a small chunk with no big one ahead of it; its delay is the link's, not a whole picture's squeeze
    const small = this.smallChunk()
    this.flights.push({ seq, bytes, at: now, clean: bytes <= small && this.flights.every((f) => f.bytes <= small) })
    this.inflight += bytes
  }

  /** The phone has everything up to `seq` (acks are cumulative: the connection keeps order). */
  acked(seq: number, now: number): void {
    let newest: { seq: number; bytes: number; at: number; clean: boolean } | undefined
    let bytes = 0
    while (this.flights.length && this.flights[0].seq <= seq) {
      newest = this.flights.shift()!
      bytes += newest.bytes
    }
    if (!newest) return
    this.inflight -= bytes
    if (this.firstAck < 0) this.firstAck = now
    this.lastAckAt = now
    this.acks.push({ at: now, bytes })
    const ms = now - newest.at
    // only small chunks tell the link's own delay: a big one also counts the time it took to squeeze through
    // what waited out a cut tells nothing about the link now
    if (this.inCut) {
      this.inCut = false
      this.cutUntil = now
      this.refusals = []
    }
    this.lats.push({ at: now, ms, small: newest.clean && newest.at >= this.cutUntil })
    while (this.lats.length && now - this.lats[0].at > 10_000) this.lats.shift()
    while (this.acks.length && now - this.acks[0].at > 2000) this.acks.shift()
  }

  report(r: PhoneReport): void {
    const frame = 1000 / this.step.fps
    const slow = (r.dec ?? 0) > 0 && (r.decMs ?? 0) > frame * 0.85
    this.overload = slow || (r.q ?? 0) > 3 ? this.overload + 1 : 0
    this.lastReport = r
  }

  /** May a chunk of `bytes` go now? Nothing in the air: always. Otherwise only inside the window. A whole picture (`key`)
   *  gets room for itself: a sharp 4K one can be several times the step's usual whole picture, and the phone is waiting for it. */
  canSend(bytes: number, now: number, key = false): boolean {
    if (!this.flights.length) return true
    if (this.step.keyOnly) return false
    // a link that stopped answering gets nothing more until it does
    // before the first answer nothing is known of the link: one chunk at a time. After it, the oldest chunk in the air
    // must not be older than the link's delay, the tolerated queue and its own time to squeeze through: that is what
    // keeps the queue (and so the delay of everything behind, the pointer included) within the tolerance
    const first = this.flights[0]
    const rate = Math.max(this.step.bps, this.goodput(now)) / 8 / 1000
    const due = this.base(now) + this.allowance(now) + 50 + first.bytes / rate
    const room = this.window(now) + (key ? Math.max(0, bytes - this.minWindow(this.level)) : 0)
    const ok = this.firstAck >= 0 && now - first.at <= due && this.inflight + bytes <= room
    // a picture that does not fit is a picture the phone loses: that is congestion too, even when latency looks fine
    if (!ok) this.refused(now)
    return ok
  }

  /** A whole picture is asked for at most this often: on a weak link each one costs. */
  askKey(now: number): boolean {
    if (now - this.lastKeyAsk < Math.max(1000, 2 * this.base(now))) return false
    this.lastKeyAsk = now
    return true
  }

  /** Called a few times a second. Returns true when the step changed. */
  tick(now: number): boolean {
    this.busy.push(this.flights.length > 0)
    if (this.busy.length > 8) this.busy.shift()
    const lat = this.median(now)
    const least = this.recentMin(now)
    const base = this.base(now)
    const allow = this.allowance(now)
    // the oldest chunk still out, among those sent since the last cut ended (what waited out a cut is the cut's)
    const fresh = this.flights.find((f) => f.at >= this.cutUntil)
    const stall = fresh ? now - fresh.at : 0
    const overloaded = this.overload >= 2
    while (this.refusals.length && now - this.refusals[0] > 1000) this.refusals.shift()
    const refusing = this.refusals.length >= Math.max(3, this.step.fps * 0.25)
    // queued: even the quickest chunk of the last second took too long, twice in a row (a lost segment that TCP sends
    // again delays a few chunks; a queue delays all of them)
    this.queued = least > base + allow ? this.queued + 1 : 0
    // nothing at all came back for a while: the link is cut, not slow. On a link known to work that is no reason to send
    // less afterwards (the window already stops sending into it); on a new one it may be a huge first queue: one step
    // a slow link still answers, only later; a cut one does not answer at all for a good while
    const silent = Math.max(1000, 2 * (base + allow), 2000 / this.step.fps)
    const cut = this.flights.length > 0 && now - this.lastAckAt > silent && this.oldest(now) > silent
    if (!cut) this.cutStepped = false
    if (cut) this.inCut = true
    if (cut && this.baseKnown(now)) {
      this.queued = 0
      this.refusals = []
      return false
    }
    const congested = this.queued >= 2 || stall > Math.max(base + allow + 600, silent + 250) || refusing || overloaded
    if (congested) {
      this.lastCongest = now
      this.everCongested = true
    }
    // the link got much quicker (another network): the caution learned on the old one does not apply
    if (this.upHold > UP_BASE && this.baseKnown(now) && base < this.baseAtBackoff * 0.5) this.upHold = UP_BASE
    if (this.upHold > UP_BASE && now - this.lastCongest > 15_000 && now - this.lastDecay > 15_000) {
      this.upHold = Math.max(UP_BASE, this.upHold / 2)
      this.lastDecay = now
    }
    if (this.level < this.floor) return this.set(this.floor, now)
    if (congested && !(cut && this.cutStepped) && now - this.lastDown >= clamp(lat * 1.5, 1000, 3000)) {
      this.why = this.queued >= 2 ? 'queue' : refusing ? 'dropped' : overloaded ? 'phone' : cut ? 'cut' : 'stall'
      let target = this.level + 1
      // the link was kept busy, so what got through is what it can carry: go straight to a step that fits
      const gp = this.goodput(now, 1000)
      const busyFrac = this.busy.filter(Boolean).length / this.busy.length
      // only on a heavy queue: a stream that sends less than the link carries also shows a small goodput
      if (!overloaded && !cut && gp > 0 && busyFrac >= 0.5 && least > base + 2 * allow) target = Math.max(target, stepFor(gp * 0.7))
      target = Math.min(LADDER.length - 1, target)
      if (target === this.level) return false
      // a step up that brought this on: wait longer before the next try
      if (now - this.lastUp < 6000) {
        this.upHold = Math.min(UP_MAX, this.upHold * 2)
        this.baseAtBackoff = base
      }
      if (cut) this.cutStepped = true
      this.lastDown = now
      this.overload = 0
      this.refusals = []
      return this.set(target, now)
    }
    const hold = this.everCongested ? this.upHold : UP_START
    const calm = now - this.lastCongest >= hold && now - this.lastChange >= hold && lat <= base + allow / 2 && stall <= base + allow && this.baseKnown(now)
    if (!congested && calm && this.level > this.floor) {
      this.lastUp = now
      return this.set(this.level - 1, now)
    }
    return false
  }

  /** the controller's insides, for tests and JOLTY_DEBUG_ENC */
  /** why the step last went down (queue, dropped, phone, cut, stall) */
  why = ''

  debug(now: number): Record<string, number | string> {
    return { why: this.why, overload: this.overload, level: this.level, med: Math.round(this.median(now)), base: Math.round(this.base(now)), stall: Math.round(this.oldest(now)), refusals: this.refusals.length, window: this.window(now), inflight: this.inflight, gp: Math.round(this.goodput(now) / 1000), hold: this.upHold }
  }

  stats(now: number): AdaptStats {
    return { level: this.level, step: this.step.name, lat: Math.round(this.latency(now)), rtt: Math.round(this.base(now)), kbps: Math.round(this.goodput(now) / 1000) }
  }

  // ---------------------------------------------------------------- measures

  /** ms: the middle of the last second's samples (the newest one when there are none) */
  median(now: number): number {
    const recent = this.lats.filter((l) => now - l.at <= 1000).map((l) => l.ms).sort((a, b) => a - b)
    return recent.length ? recent[recent.length >> 1] : this.lats.length ? this.lats[this.lats.length - 1].ms : 0
  }

  /** ms: the quickest of the last half second's samples */
  private recentMin(now: number): number {
    const recent = this.lats.filter((l) => l.small && now - l.at <= 500)
    // no clean answer lately says nothing yet (a slow link still answers; a cut is told apart by its silence)
    return recent.length ? Math.min(...recent.map((l) => l.ms)) : 0
  }

  /** ms, as shown to the user: the newest samples, and never less than how long the oldest unanswered chunk has been out */
  latency(now: number): number {
    return Math.max(this.median(now), this.oldest(now))
  }

  base(now: number): number {
    let min = Infinity
    let all = Infinity
    for (const l of this.lats) {
      if (now - l.at > 10_000) continue
      if (l.small && l.ms < min) min = l.ms
      if (l.ms < all) all = l.ms
    }
    return min !== Infinity ? min : all !== Infinity ? all : 250
  }

  /** the base comes from small chunks (until then, nothing is risked by going up) */
  private baseKnown(now: number): boolean {
    return this.lats.some((l) => l.small && now - l.at <= 10_000)
  }

  private smallChunk(): number {
    const s = LADDER[this.level]
    return Math.max(3000, Math.round((1.5 * s.bps) / 8 / s.fps))
  }

  /** A picture that did not fit in the window: counted toward congestion. (Pictures skipped afterwards while the
   *  phone waits for a whole one are not counted again: with ffmpeg a whole picture takes a restart, up to 1.8 s.) */
  /** A picture skipped while the phone waits for a whole one, `waiting` ms after that began. Within the encoder's own
   *  delay for a whole picture (`grace`) it is expected; past it, the link is not carrying the step. */
  skipped(now: number, waiting: number, grace: number): void {
    if (waiting > grace) this.refused(now)
  }

  private refused(now: number): void {
    // not during a cut nor just after it (that is the cut's doing), and only while answers still come: a full link
    // answers slowly, a link that went silent may be cut (told apart later)
    const answering = now - this.lastAckAt <= Math.max(500, 2 * this.base(now))
    if (answering && !this.inCut && now - this.cutUntil > 1000 + this.base(now)) this.refusals.push(now)
  }

  /** how much queue is tolerated above the base before it counts as congestion */
  private allowance(now: number): number {
    return clamp(this.base(now) * 0.5, 150, 450)
  }

  /** bits per second acked over the last `ms` (2 s by default) */
  goodput(now: number, ms = 2000): number {
    if (this.firstAck < 0) return 0
    const span = Math.min(ms, now - this.firstAck)
    if (span < 500) return 0
    const bytes = this.acks.filter((a) => now - a.at <= ms).reduce((n, a) => n + a.bytes, 0)
    return (bytes * 8 * 1000) / span
  }

  private minWindow(level: number): number {
    const s = LADDER[level]
    // room for a whole picture and the change behind it: less makes every whole picture cost the next ones
    return Math.max(4000, Math.round((7 * s.bps) / 8 / s.fps))
  }

  /** Bytes allowed in the air: a whole picture, plus what the step sends while a chunk goes there and back with the
   *  tolerated queue. The base counts only once it comes from small chunks (a big first picture would inflate it). */
  window(now: number): number {
    const s = LADDER[this.level]
    const base = this.baseKnown(now) ? this.base(now) : Math.min(this.base(now), 300)
    // the rate part never runs more than half again ahead of what the link has delivered: a step up grows into it
    const gp = this.goodput(now)
    const rate = gp > 0 ? Math.min(s.bps * 1.25, Math.max(gp * 1.5, LADDER[LADDER.length - 1].bps)) : s.bps * 1.25
    return this.minWindow(this.level) + Math.round((rate / 8) * ((base + this.allowance(now) + 50) / 1000))
  }

  private set(level: number, now: number): boolean {
    if (level === this.level) return false
    this.level = level
    this.lastChange = now
    return true
  }
}

/** The PC's own load: when it is busy, 60 fps is the first thing given up, then 1080p. Fed with os.cpus() snapshots. */
export class LoadWatch {
  floor = 0
  private last?: { idle: number; total: number }
  private hot = 0
  private cool = 0

  sample(cpus: Array<{ times: { idle: number; user: number; nice: number; sys: number; irq: number } }>): number {
    const idle = cpus.reduce((n, c) => n + c.times.idle, 0)
    const total = cpus.reduce((n, c) => n + c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq, 0)
    const prev = this.last
    this.last = { idle, total }
    if (!prev || total <= prev.total) return this.floor
    const busy = 1 - (idle - prev.idle) / (total - prev.total)
    if (busy > 0.85) {
      this.cool = 0
      if (++this.hot >= 2) this.floor = Math.max(this.floor, busy > 0.95 ? 2 : 1)
    } else if (busy < 0.7) {
      this.hot = 0
      if (++this.cool >= 5) this.floor = 0
    }
    return this.floor
  }
}
