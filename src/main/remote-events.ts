import crypto from 'crypto'

// What the PC tells the phones, made to survive a bad line:
// - every event gets a number; the last few thousand are kept, so a phone that lost its line (a tunnel, a locked screen, iOS
//   closing the tab) asks for what it missed by number and gets exactly that, nothing lost and nothing twice, instead of
//   reloading whole conversations;
// - streamed text comes token by token: for each phone the chunks of one message are joined and sent together, more
//   often when its line keeps up and less often when it does not (one message per ~60 ms instead of one per token);
// - an action the phone sent (a message, a yes) carries its own id: when the answer was lost with the line, the phone
//   sends it again and the PC answers from what it already did instead of doing it twice.

type Ev = { seq: number; channel: string; data: unknown; size: number }

/** Kept for phones that come back: this many events, or this many bytes, whichever is reached first. */
const LOG_EVENTS = 5000
const LOG_BYTES = 8 * 1024 * 1024
/** one message at most carries this much, so a phone that missed a lot still gets it in pieces it can show */
const BATCH_BYTES = 192 * 1024
/** a phone this far behind (the line is dead, or far too slow for what is sent) is cut, and catches up on its next connection */
export const CUT_BACKLOG = 16 * 1024 * 1024

export interface Sink {
  send(text: string): void
  backlog(): number
}

function isDelta(channel: string, data: unknown): data is { type: 'delta'; sessionId: string; itemId: string; delta: string } {
  return channel === 'jolty:event' && !!data && typeof data === 'object' && (data as { type?: string }).type === 'delta'
}

/** [channel, data, number] */
export type Entry = [string, unknown, number]

function isDraft(channel: string, data: unknown): data is { type: 'draft'; sessionId: string; toolId: string; done: boolean } {
  return channel === 'jolty:event' && !!data && typeof data === 'object' && (data as { type?: string }).type === 'draft'
}

/** Text that streams: sent in batches, not one message per token. */
export const streams = (channel: string, data: unknown): boolean => isDelta(channel, data) || (isDraft(channel, data) && !data.done)

/**
 * Joins the streamed chunks of one message that follow each other into one (numbered as the last of them). A file being
 * written arrives whole each time: only its newest state is kept.
 */
export function coalesce(list: Entry[]): Entry[] {
  const out: Entry[] = []
  const latest = new Map<string, number>()
  const key = (d: { sessionId: string; toolId: string }): string => `${d.sessionId}|${d.toolId}`
  list.forEach(([channel, data], i) => isDraft(channel, data) && latest.set(key(data), i))
  for (let i = 0; i < list.length; i++) {
    const [channel, data, seq] = list[i]
    if (isDraft(channel, data) && latest.get(key(data)) !== i) {
      // its number still counts: the newer state carries the later one
      continue
    }
    const last = out[out.length - 1]
    if (last && isDelta(channel, data) && isDelta(last[0], last[1]) && last[1].sessionId === data.sessionId && last[1].itemId === data.itemId) {
      out[out.length - 1] = [channel, { ...last[1], delta: last[1].delta + data.delta }, seq]
    } else out.push([channel, data, seq])
  }
  return out
}

export class EventLog {
  /** a new number for each start of Jolty: numbers from before a restart mean nothing now */
  readonly epoch = crypto.randomBytes(6).toString('hex')
  seq = 0
  private log: Ev[] = []
  private bytes = 0

  add(channel: string, data: unknown, size: number): Ev {
    const ev = { seq: ++this.seq, channel, data, size }
    this.log.push(ev)
    this.bytes += size
    while (this.log.length > LOG_EVENTS || (this.bytes > LOG_BYTES && this.log.length > 1)) this.bytes -= this.log.shift()!.size
    return ev
  }

  /** What happened after `seq` in this run, or undefined when that is no longer known (another run, or too long ago). */
  since(epoch: unknown, seq: unknown): Ev[] | undefined {
    if (epoch !== this.epoch || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > this.seq) return undefined
    const first = this.log[0]?.seq ?? this.seq + 1
    if (seq + 1 < first) return undefined
    return this.log.slice(Math.max(0, seq + 1 - first))
  }
}

/** One phone's outgoing events: queued, joined, and sent at a pace its line can take. */
export class Outbox {
  private queue: Entry[] = []
  private timer?: ReturnType<typeof setTimeout>

  constructor(readonly sink: Sink) {}

  push(ev: Ev): void {
    this.queue.push([ev.channel, ev.data, ev.seq])
    // anything but streamed text goes at once (after the text before it): a status or a question must not wait
    if (!streams(ev.channel, ev.data)) return this.flush()
    this.timer ??= setTimeout(() => this.flush(), this.pace())
  }

  /** ~60 ms when the line keeps up; up to a second when what was sent before is still on its way */
  private pace(): number {
    return Math.min(1000, 60 + Math.round(this.sink.backlog() / 1024))
  }

  flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.queue.length) return
    const list = coalesce(this.queue)
    this.queue = []
    send(this.sink, list)
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.queue = []
  }
}

/** Sends events as one message, or as several when they are many; each message carries the number of its last event. */
export function send(sink: Sink, list: Entry[]): void {
  if (list.length === 1) return sink.send(JSON.stringify({ t: 'ev', channel: list[0][0], data: list[0][1], s: list[0][2] }))
  let part: Entry[] = []
  let size = 0
  const out = (): void => sink.send(JSON.stringify({ t: 'evs', list: part.map(([c, d]) => [c, d]), s: part[part.length - 1][2] }))
  for (const e of list) {
    const n = JSON.stringify(e[1])?.length ?? 4
    if (part.length && size + n > BATCH_BYTES) {
      out()
      part = []
      size = 0
    }
    part.push(e)
    size += n
  }
  out()
}

/** The phone's own id on an action, remembered for a while with its answer: the same action sent again is answered, not run again. */
export class Once {
  private done = new Map<string, { at: number; result: Promise<unknown> }>()

  run(key: unknown, work: () => Promise<unknown>): Promise<unknown> {
    if (typeof key !== 'string' || !/^[\w-]{8,64}$/.test(key)) return work()
    const now = Date.now()
    for (const [k, v] of this.done) if (now - v.at > 15 * 60_000 || this.done.size > 500) this.done.delete(k)
    else break
    const hit = this.done.get(key)
    if (hit) return hit.result
    const result = work()
    this.done.set(key, { at: now, result })
    // a failed action may be tried again
    result.catch(() => this.done.delete(key))
    return result
  }
}
