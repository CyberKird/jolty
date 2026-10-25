// Picks the model of a started session from what Jolty has: every usable account and provider, scored like the
// model picker. Hard jobs go to the strongest model, simple ones to the fastest that is still good enough.
import type { EngineKind, ModelOption, Profile } from '@shared/types'
import { modelScore } from '@shared/scores'

export interface Candidate {
  profileId: string
  model: string
  label: string
  iq: number
  tps?: number
}

/** Below this the model is too weak to hand a job to, however fast it is. */
export const MIN_IQ_SIMPLE = 30
/** An account this full is left out: the job would stop on its limit. */
export const FULL_PERCENT = 95

export function candidates(profile: Profile, models: ModelOption[]): Candidate[] {
  const out: Candidate[] = []
  for (const m of models) {
    const s = modelScore(profile, m)
    if (s) out.push({ profileId: profile.id, model: m.id, label: m.label, iq: s.iq, tps: s.tps })
  }
  return out
}

export function pickAuto(kind: 'simple' | 'hard', list: Candidate[]): Candidate | undefined {
  const speed = (c: Candidate): number => c.tps ?? 0
  if (kind === 'hard') return [...list].sort((a, b) => b.iq - a.iq || speed(b) - speed(a))[0]
  return list.filter((c) => c.iq >= MIN_IQ_SIMPLE && c.tps !== undefined).sort((a, b) => speed(b) - speed(a) || b.iq - a.iq)[0]
}

/** One model that could do a small job (a chat title, a rewritten message) and how to reach it. */
export interface HelperEntry {
  /** profile id + model id, what a failure is remembered by */
  key: string
  engine: EngineKind
  model: string
  iq?: number
  tps?: number
}

/** Seconds a call costs before the first word: Claude Code and Codex start a process, OpenCode also loads a long system prompt. */
const START_SECONDS: Record<EngineKind, number> = { claude: 3.5, codex: 3, opencode: 5, hermes: 5 }
const FAST_NAME = /mini|flash|haiku|lite|nano|small|luna|instant|turbo|\bair\b|fast/i
/** A helper below this writes titles and rewrites too badly to trust. */
export const MIN_IQ_HELPER = 15

/**
 * The models for small jobs, best first: the shortest guess of "start + 300 output tokens", and among near equals the cheaper one.
 * A model with no score is only trusted when its name says it is a small one, unless nothing else is left.
 */
export function rankHelpers(list: HelperEntry[], blocked: (key: string) => boolean): HelperEntry[] {
  const open = list.filter((e) => !blocked(e.key))
  const good = open.filter((e) => (e.iq !== undefined ? e.iq >= MIN_IQ_HELPER : FAST_NAME.test(e.model)))
  const seconds = (e: HelperEntry): number =>
    START_SECONDS[e.engine] + 300 / (e.tps ?? (FAST_NAME.test(e.model) ? 120 : 40)) + (e.iq ?? 20) * 0.05
  return [...(good.length ? good : open)].sort((a, b) => seconds(a) - seconds(b))
}
