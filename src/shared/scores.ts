// Intelligence and speed shown next to every model in the picker.
// Intelligence = Artificial Analysis Intelligence Index (higher is better), speed = their median output tokens/s.
// This table is the fallback. The real one is scores.json at the repo root, rebuilt every day from the leaderboard by
// .github/workflows/scores.yml; the app fetches it and uses it before this table, so new models need no release.
import type { ModelOption, Profile } from './types'
import { tr } from './i18n'

export interface ModelScore {
  iq: number
  /** measured output tokens per second; undefined for local models (their speed is the user's PC) */
  tps?: number
  speed?: 'rapid' | 'mediu' | 'lent'
  /** what was measured, for the tooltip */
  note: string
  /** set when the measurement is of an older version of this model ("5.1"): the number is shown as an estimate, not as this model's */
  measured?: string
  /** intelligence at each thinking level the benchmark measured ("low" -> 46); `iq` is the one at `base` */
  levels?: Record<string, number>
  base?: string
}

export const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/** The levels written in a note: "· high (medium 31, low 26)" or "la efort high (46 la low, 53 la max)", in any language the note was put in. */
export function levelsIn(note: string, iq: number): { levels: Record<string, number>; base: string } | undefined {
  const levels: Record<string, number> = {}
  const rest = note
    .replace(/\b(minimal|low|medium|high|xhigh|max)\s+(\d{1,3})(?![\d.])/gi, (_, l: string, n: string) => ((levels[l.toLowerCase()] = Number(n)), ' '))
    .replace(/(?<![\d.])(\d{1,3})(?![\d.])\s+(?:\p{L}+\s+)?(minimal|low|medium|high|xhigh|max)\b/giu, (_, n: string, l: string) => ((levels[l.toLowerCase()] = Number(n)), ' '))
  const base = /\b(minimal|low|medium|high|xhigh|max)\b/i.exec(rest)?.[1]?.toLowerCase()
  if (!base) return undefined
  levels[base] = iq
  return { levels, base }
}

/** Intelligence at a thinking level: measured when the benchmark has it, else between the two nearest measured levels, else the score itself. */
export function iqAt(s: ModelScore, effort?: string): number {
  const lv = s.levels
  if (!lv || !effort) return s.iq
  const e = effort.toLowerCase()
  if (lv[e] !== undefined) return lv[e]
  const idx = EFFORT_ORDER.indexOf(e as (typeof EFFORT_ORDER)[number])
  if (idx < 0) return s.iq
  const known = EFFORT_ORDER.map((l, i) => ({ i, v: lv[l] })).filter((k) => k.v !== undefined) as { i: number; v: number }[]
  const lo = [...known].reverse().find((k) => k.i < idx)
  const hi = known.find((k) => k.i > idx)
  if (lo && hi) return Math.round(lo.v + ((hi.v - lo.v) * (idx - lo.i)) / (hi.i - lo.i))
  return (lo ?? hi)?.v ?? s.iq
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
  [/glm-5\.3-flash/, 42, 69, 'GLM-5.3-Flash'],
  [/glm-5\.3/, 45, 85, 'GLM-5.3 (max)'],
  [/beam/, 30, 337, 'Reflection Beam 1.0'],
  [/nemotron.*super/, 26, 453, 'Nemotron 3.5 Super VL'],
  [/nemotron.*ultra/, 23, 154, 'Nemotron 3 Ultra'],
  [/nemotron.*bolt/, 21, undefined, 'Nemotron 3.5 Bolt 74B-A9B'],
  [/nemotron.*lightning/, 13, 288, 'Nemotron 3.5 Lightning'],
  [/4[ -]argon/, 53, 80, 'Gemini 4 Argon (high)'],
  [/3\.8[ -]flash/, 41, 129, 'Gemini 3.8 Flash (high)'],
  [/3\.6[ -]flash/, 34, 194, 'Gemini 3.6 Flash (high)'],
  [/3\.5[ -]flash-lite/, 22, 403, 'Gemini 3.5 Flash-Lite'],
  [/3\.1[ -]pro/, 30, 132, 'Gemini 3.1 Pro Preview'],
  [/gemma-?4/, 15, undefined, tr("Gemma 4 (variantele de 12B-31B)")],
  [/qwen3\.5[-:]27b/, 23, undefined, 'Qwen3.5 27B'],
  [/qwen3\.5/, 13, undefined, 'Qwen3.5 9B'],
  [/qwen3\.6/, 21, undefined, 'Qwen3.6 27B'],
  [/gpt-oss/, 12, undefined, 'gpt-oss 120B']
]

/** Letters and digits only: "gpt-6.1-sol", "gpt-6-1-sol" and "GPT 6.1 Sol" are the same name. */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** One line of scores.json: every `match` text must appear in "id label" (substrings of the letters and digits, never patterns). */
export interface RemoteScore {
  match: string[]
  iq: number
  tps?: number
  note: string
}

const MAX_ENTRIES = 600
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
    if (texts.some((t) => !squash(t) || t.length > MAX_TEXT)) continue
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

function toScore(profile: Profile, iq: number, measured: number | undefined, note: string, raw = note): ModelScore {
  const tps = profile.local ? undefined : measured
  return { iq, tps, speed: tps === undefined ? undefined : tps >= 100 ? 'rapid' : tps >= 60 ? 'mediu' : 'lent', note, ...levelsIn(raw, iq) }
}

/** The first version number in a name or a note: "Claude Fable 5.1 · high" -> "5.1", "claude-fable-5-2" -> "5.2". */
export function versionIn(text: string): string | undefined {
  const v = /(\d+(?:[.-]\d+)?)/.exec(text)?.[1]
  return v?.replace('-', '.')
}

/** A score measured on another version of the model is an estimate until the new one is measured (scores.json follows the benchmark by itself). */
function forVersion(m: ModelOption, s: ModelScore): ModelScore {
  const own = versionIn(m.label) ?? versionIn(m.id)
  const measured = versionIn(s.note)
  return own && measured && own !== measured ? { ...s, measured } : s
}

export function modelScore(profile: Profile, m: ModelOption): ModelScore | undefined {
  if (m.score) return m.score
  const text = `${m.id} ${m.label}`.toLowerCase()
  const flat = squash(text)
  const r = remote.find((e) => e.match.every((t) => flat.includes(squash(t))))
  // the notes in scores.json are the same Romanian texts as the table, so they translate the same way
  if (r) return forVersion(m, toScore(profile, r.iq, r.tps, tr(r.note), r.note))
  const hit = SCORES.find(([re]) => re.test(text))
  return hit ? forVersion(m, toScore(profile, hit[1], hit[2], hit[3])) : undefined
}
