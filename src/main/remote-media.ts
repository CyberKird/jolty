import crypto from 'crypto'

// A conversation kept on the PC can weigh tens of megabytes, nearly all of it pictures pasted or captured along the way
// (a real one: 35 MB, 30 of them screenshots). The phone gets the conversation with each picture replaced by a link to a
// smaller copy, loaded only when it scrolls into view, and with very long tool output shortened. The links are random,
// handed only to paired phones over their connection, and work only while this Jolty runs.

/** what a phone needs to read a tool's output; the whole of it stays on the PC */
const TOOL_TEXT = 6000
const PREFIX = '/api/img/'
const RASTER = /^data:image\/(png|jpeg|webp|gif);base64,/

/** Turns a picture into a smaller one for a phone screen; the PC wires in Electron's image tools. */
export type Shrink = (data: Buffer, mime: string) => { data: Buffer; mime: string } | undefined

function cut(text: string): string {
  if (text.length <= TOOL_TEXT) return text
  return `${text.slice(0, 2000)}\n…\n${text.slice(-(TOOL_TEXT - 2000))}`
}

/** Long strings anywhere in a tool's input (a file written whole) are shortened the same way. */
function cutDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return cut(v)
  if (depth > 4 || !v || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => cutDeep(x, depth + 1))
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutDeep(x, depth + 1)]))
}

export class PhoneMedia {
  private secret = crypto.randomBytes(16)
  /** link id -> the picture as the PC keeps it */
  private byId = new Map<string, string>()
  /** smaller copies already made, by link id */
  private small = new Map<string, { data: Buffer; mime: string }>()
  private smallBytes = 0

  constructor(private shrink?: Shrink) {}

  useShrink(shrink: Shrink): void {
    this.shrink = shrink
  }

  /** The link that stands for a data: URL (the same picture always gets the same link while Jolty runs, so the phone's cache works). */
  link(dataUrl: string): string {
    // raster pictures only: an SVG served from this origin could run script if opened on its own
    if (!RASTER.test(dataUrl) || dataUrl.length < 4096) return dataUrl
    const id = crypto.createHmac('sha256', this.secret).update(dataUrl).digest('base64url').slice(0, 32)
    // re-inserted to keep the newest at the end
    this.byId.delete(id)
    this.byId.set(id, dataUrl)
    if (this.byId.size > 4000) this.byId.delete(this.byId.keys().next().value as string)
    return PREFIX + id
  }

  /** A chat item as a phone gets it: pictures as links, very long tool text shortened. */
  item<T>(item: T): T {
    if (!item || typeof item !== 'object') return item
    const it = item as Record<string, unknown>
    if (it.kind === 'user' && Array.isArray(it.images) && it.images.length) {
      return { ...it, images: (it.images as Array<{ name: string; dataUrl: string }>).map((i) => ({ ...i, dataUrl: typeof i?.dataUrl === 'string' ? this.link(i.dataUrl) : i?.dataUrl })) } as T
    }
    if (it.kind === 'tool') {
      const out: Record<string, unknown> = { ...it }
      if (Array.isArray(it.images)) out.images = (it.images as unknown[]).map((x) => (typeof x === 'string' ? this.link(x) : x))
      if (typeof it.output === 'string') out.output = cut(it.output)
      if (it.input !== undefined) out.input = cutDeep(it.input)
      if (Array.isArray(it.diffs)) out.diffs = (it.diffs as Array<{ diff?: unknown }>).map((d) => (typeof d?.diff === 'string' && d.diff.length > TOOL_TEXT * 4 ? { ...d, diff: `${d.diff.slice(0, TOOL_TEXT * 4)}\n…` } : d))
      return out as T
    }
    return item
  }

  /** An event on its way to the phones (a new or updated chat item carries pictures and output too). */
  event(channel: string, data: unknown): unknown {
    if (channel !== 'jolty:event' || !data || typeof data !== 'object') return data
    const e = data as { type?: string; item?: unknown }
    return e.type === 'item' && e.item ? { ...e, item: this.item(e.item) } : data
  }

  /** What a call returns to a phone: a conversation's history comes in the phone's form. */
  result(channel: string, value: unknown): unknown {
    return channel === 'sessions:history' && Array.isArray(value) ? value.map((x) => this.item(x)) : value
  }

  /** Serves a linked picture, smaller; undefined when the link is not (or no longer) known. */
  serve(pathname: string): { data: Buffer; mime: string } | undefined {
    if (!pathname.startsWith(PREFIX)) return undefined
    const id = pathname.slice(PREFIX.length)
    const url = this.byId.get(id)
    if (!url) return undefined
    const hit = this.small.get(id)
    if (hit) return hit
    const m = /^data:(image\/[\w+.-]+);base64,/.exec(url)
    if (!m) return undefined
    const raw = Buffer.from(url.slice(m[0].length), 'base64')
    let out: { data: Buffer; mime: string } = { data: raw, mime: m[1] }
    try {
      const s = this.shrink?.(raw, m[1])
      if (s && s.data.length < raw.length) out = s
    } catch {
      // the picture as it is
    }
    this.small.set(id, out)
    this.smallBytes += out.data.length
    for (const [k, v] of this.small) {
      if (this.smallBytes <= 64 * 1024 * 1024) break
      this.small.delete(k)
      this.smallBytes -= v.data.length
    }
    return out
  }
}
