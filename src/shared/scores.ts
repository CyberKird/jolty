// Intelligence and speed shown next to every model in the picker.
// Intelligence = Artificial Analysis Intelligence Index (higher is better), speed = their median output tokens/s.
// Snapshot of artificialanalysis.ai/leaderboards/models taken 2026-10-03, at effort "high" where the model has levels.
// Refresh the table when a new model shows up in the picker without a score.
import type { ModelOption, Profile } from './types'

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
  [/fable/, 51, 54, 'Fable 5.1 la efort high (46 la low, 53 la max)'],
  [/opus/, 54, 74, 'Opus 5.5 la efort high (42 la low, 58 la max)'],
  [/sonnet/, 47, 102, 'Sonnet 5.5 la efort high (36 la low, 56 la max)'],
  [/haiku/, 17, 108, 'Haiku 4.5 cu raționament'],
  [/gpt-6\.1-sol/, 50, 58, 'GPT-6.1 Sol la efort high (42 la low, 52 la max)'],
  [/gpt-6-astra/, 51, 45, 'GPT-6 Astra la efort high (46 la low, 53 la max)'],
  [/gpt-6-sol/, 42, 87, 'GPT-6 Sol la efort high (34 la low, 48 la max)'],
  [/gpt-6-luna/, 33, 135, 'GPT-6 Luna la efort high (22 la low, 38 la max)'],
  [/gpt-5\.6-sol/, 42, 76, 'GPT-5.6 Sol la efort high (33 la low, 47 la max)'],
  [/gpt-5\.6-terra/, 34, 85, 'GPT-5.6 Terra la efort high (27 la low, 42 la max)'],
  [/gpt-5\.6-luna/, 32, 109, 'GPT-5.6 Luna la efort high (21 la low, 37 la max)'],
  [/gpt-5\.5/, 37, 87, 'GPT-5.5 la efort high (31 la low, 38 la xhigh)'],
  [/deepseek.*pro/, 36, 107, 'DeepSeek V4 Pro 0813 la efort max'],
  [/deepseek.*flash/, 39, 209, 'DeepSeek V4.1 Flash la efort max'],
  [/mimo-v2\.6-pro-ultraspeed/, 46, undefined, 'MiMo V2.6 Pro; viteza serviciului ultraspeed nu e măsurată'],
  [/mimo-v2\.6-pro/, 46, 46, 'MiMo V2.6 Pro'],
  [/mimo-v2\.6-flash/, 38, 51, 'MiMo V2.6 Flash'],
  [/mimo-v2\.5-pro/, 26, 34, 'MiMo V2.5 Pro'],
  [/mimo-v2\.5$/, 25, 58, 'MiMo V2.5'],
  [/gemma-?4/, 15, undefined, 'Gemma 4 (variantele de 12B-31B)'],
  [/qwen3\.5[-:]27b/, 23, undefined, 'Qwen3.5 27B'],
  [/qwen3\.5/, 13, undefined, 'Qwen3.5 9B'],
  [/qwen3\.6/, 21, undefined, 'Qwen3.6 27B'],
  [/gpt-oss/, 12, undefined, 'gpt-oss 120B']
]

export function modelScore(profile: Profile, m: ModelOption): ModelScore | undefined {
  const hit = SCORES.find(([re]) => re.test(`${m.id} ${m.label}`.toLowerCase()))
  if (!hit) return undefined
  const [, iq, measured, note] = hit
  const tps = profile.local ? undefined : measured
  return { iq, tps, speed: tps === undefined ? undefined : tps >= 100 ? 'rapid' : tps >= 60 ? 'mediu' : 'lent', note }
}
