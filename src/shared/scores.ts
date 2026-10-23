// Intelligence and speed shown next to every model in the picker.
// Intelligence = Artificial Analysis Intelligence Index (higher is better), speed = their median output tokens/s.
// Snapshot of artificialanalysis.ai/leaderboards/models taken 2026-10-03, at effort "high" where the model has levels.
// Refresh the table when a new model shows up in the picker without a score. The same data is published as
// scores.json at the repo root; the app fetches that file and uses it before this table, so a refresh needs no release.
import type { ModelOption, Profile } from './types'
import { tr } from './i18n'

export interface ModelScore {
  iq: number
  /** measured output tokens per second; undefined for local models (their speed is the user's PC) */
  tps?: number
  speed?: 'rapid' | 'mediu' | 'lent'
  /** what was measured, for the tooltip */
  note: string
}

// [pattern on "id label", index, tokens/s, note]; first match wins, so the longer names come first
const SCORES: [RegExp, number, number | undefined, string][] = [
  [/fable/, 51, 54, tr("Fable 5.1 la efort high (46 la low, 53 la max)")],
  [/opus/, 54, 74, tr("Opus 5.5 la efort high (42 la low, 58 la max)")],
  [/sonnet/, 47, 102, tr("Sonnet 5.5 la efort high (36 la low, 56 la max)")],
  [/haiku/, 17, 108, tr("Haiku 4.5 cu raționament")],
  [/gpt-6\.1-sol/, 50, 58, tr("GPT-6.1 Sol la efort high (42 la low, 52 la max)")],
  [/gpt-6-astra/, 51, 45, tr("GPT-6 Astra la efort high (46 la low, 53 la max)")],
  [/gpt-6-sol/, 42, 87, tr("GPT-6 Sol la efort high (34 la low, 48 la max)")],
  [/gpt-6-luna/, 33, 135, tr("GPT-6 Luna la efort high (22 la low, 38 la max)")],
  [/gpt-5\.6-sol/, 42, 76, tr("GPT-5.6 Sol la efort high (33 la low, 47 la max)")],
  [/gpt-5\.6-terra/, 34, 85, tr("GPT-5.6 Terra la efort high (27 la low, 42 la max)")],
  [/gpt-5\.6-luna/, 32, 109, tr("GPT-5.6 Luna la efort high (21 la low, 37 la max)")],
  [/gpt-5\.5/, 37, 87, tr("GPT-5.5 la efort high (31 la low, 38 la xhigh)")],
  [/deepseek.*pro/, 36, 107, tr("DeepSeek V4 Pro 0813 la efort max")],
  [/deepseek.*flash/, 39, 209, tr("DeepSeek V4.1 Flash la efort max")],
  [/mimo-v2\.6-pro-ultraspeed/, 46, undefined, tr("MiMo V2.6 Pro; viteza serviciului ultraspeed nu e măsurată")],
  [/mimo-v2\.6-pro/, 46, 46, 'MiMo V2.6 Pro'],
  [/mimo-v2\.6-flash/, 38, 51, 'MiMo V2.6 Flash'],
  [/mimo-v2\.5-pro/, 26, 34, 'MiMo V2.5 Pro'],
  [/mimo-v2\.5$/, 25, 58, 'MiMo V2.5'],
  [/gemma-?4/, 15, undefined, tr("Gemma 4 (variantele de 12B-31B)")],
  [/qwen3\.5[-:]27b/, 23, undefined, 'Qwen3.5 27B'],
  [/qwen3\.5/, 13, undefined, 'Qwen3.5 9B'],
  [/qwen3\.6/, 21, undefined, 'Qwen3.6 27B'],
  [/gpt-oss/, 12, undefined, 'gpt-oss 120B']
]

/** One line of scores.json: every `match` text must appear in "id label" (lowercase substrings, never patterns). */
export interface RemoteScore {
  match: string[]
  iq: number
  tps?: number
  note: string
}

const MAX_ENTRIES = 200
const MAX_MATCH = 4
const MAX_TEXT = 64
const MAX_NOTE = 200

/** scores.json is untrusted: anything off in an entry drops that entry, a file that is not an object or has too many entries is dropped whole. */
export function parseRemoteScores(raw: unknown): RemoteScore[] | undefined {
  const list = (raw as { entries?: unknown } | null)?.entries
  if (!Array.isArray(list) || list.length > MAX_ENTRIES) return undefined
  const out: RemoteScore[] = []
  for (const e of list) {
    const { match, iq, tps, note } = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
    if (!Array.isArray(match) || match.length < 1 || match.length > MAX_MATCH) continue
    const texts = match.map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
    if (texts.some((t) => !t || t.length > MAX_TEXT)) continue
    if (typeof iq !== 'number' || !Number.isFinite(iq) || iq < 0 || iq > 100) continue
    if (tps !== undefined && (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0 || tps > 5000)) continue
    // eslint-disable-next-line no-control-regex
    if (typeof note !== 'string' || !note.trim() || note.length > MAX_NOTE || /[\u0000-\u001f]/.test(note)) continue
    out.push({ match: texts, iq, tps, note })
  }
  return out.length ? out : undefined
}

let remote: RemoteScore[] = []

/** The table fetched from the repo (main process only; the renderer gets the finished score on each ModelOption). */
export function setRemoteScores(entries: RemoteScore[]): void {
  remote = entries
}

function toScore(profile: Profile, iq: number, measured: number | undefined, note: string): ModelScore {
  const tps = profile.local ? undefined : measured
  return { iq, tps, speed: tps === undefined ? undefined : tps >= 100 ? 'rapid' : tps >= 60 ? 'mediu' : 'lent', note }
}

export function modelScore(profile: Profile, m: ModelOption): ModelScore | undefined {
  if (m.score) return m.score
  const text = `${m.id} ${m.label}`.toLowerCase()
  const r = remote.find((e) => e.match.every((t) => text.includes(t)))
  // the notes in scores.json are the same Romanian texts as the table, so they translate the same way
  if (r) return toScore(profile, r.iq, r.tps, tr(r.note))
  const hit = SCORES.find(([re]) => re.test(text))
  return hit ? toScore(profile, hit[1], hit[2], hit[3]) : undefined
}
