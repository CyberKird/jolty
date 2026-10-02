import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ModelOption, Profile } from '@shared/types'

/**
 * Thinking control of Anthropic-compatible endpoints, as each provider documents it (checked 2026-10-02):
 * DeepSeek takes `thinking` and `output_config.effort` (low, high, max; high by default), MiMo only
 * `thinking` enabled/disabled, Ollama `thinking` (a model has it when /api/show lists the capability).
 * Any other provider gets no control: Jolty does not guess what its API accepts.
 */
export function endpointEfforts(profile: Profile, thinks = true): Pick<ModelOption, 'efforts' | 'defaultEffort'> {
  const url = profile.baseUrl || ''
  if (/deepseek\.com/i.test(url)) return { efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' }
  if (/xiaomimimo\.com/i.test(url)) return { efforts: ['off', 'on'] }
  if (profile.local && thinks) return { efforts: ['off', 'on'] }
  return {}
}

/** The query options that carry the picked level to an endpoint; nothing when it is on "auto". */
export function endpointThinking(effort?: string): Partial<Options> {
  if (effort === 'off') return { thinking: { type: 'disabled' } }
  if (effort === 'on') return { thinking: { type: 'enabled', budgetTokens: 16000 } }
  if (effort === 'low' || effort === 'high' || effort === 'max') return { effort, thinking: { type: 'enabled', budgetTokens: 16000 } }
  return {}
}
