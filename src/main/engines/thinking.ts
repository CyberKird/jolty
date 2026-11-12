import type { EffortLevel, Options } from '@anthropic-ai/claude-agent-sdk'
import type { ModelOption, Profile } from '@shared/types'

/**
 * Thinking control of Anthropic-compatible endpoints, as each provider documents it (checked 2026-10-02):
 * DeepSeek takes `thinking` and `output_config.effort` (low, high, max; high by default), MiMo only
 * `thinking` enabled/disabled, Ollama `thinking` (a model has it when /api/show lists the capability).
 * NanoGPT takes `thinking` and `output_config.effort` on its Messages endpoint with the levels low to max (checked 2026-11-12); a level
 * in the model id (`:reasoning-effort/high`) is only a default that the explicit fields Claude Code sends override, so it is not used.
 * Any other provider gets no control: Jolty does not guess what its API accepts.
 */
export function endpointEfforts(profile: Profile, thinks = true): Pick<ModelOption, 'efforts' | 'defaultEffort'> {
  const url = profile.baseUrl || ''
  if (isNanoGpt(profile)) return { efforts: ['off', ...NANO_LEVELS] }
  if (/deepseek\.com/i.test(url)) return { efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' }
  if (/xiaomimimo\.com/i.test(url)) return { efforts: ['off', 'on'] }
  if (profile.local && thinks) return { efforts: ['off', 'on'] }
  return {}
}

const NANO_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const isNanoGpt = (profile: Profile): boolean => {
  try {
    return /(^|\.)nano-gpt\.com$/i.test(new URL(profile.baseUrl || '').hostname)
  } catch {
    return false
  }
}

/** The query options that carry the picked level to an endpoint; nothing when it is on "auto". */
export function endpointThinking(effort?: string, profile?: Profile): Partial<Options> {
  if (effort === 'off') return { thinking: { type: 'disabled' } }
  if (effort === 'on') return { thinking: { type: 'enabled', budgetTokens: 16000 } }
  const levels: readonly string[] = profile && isNanoGpt(profile) ? NANO_LEVELS : ['low', 'high', 'max']
  if (effort && levels.includes(effort)) return { effort: effort as EffortLevel, thinking: { type: 'enabled', budgetTokens: 16000 } }
  return {}
}
