import type { Profile } from './types'
import { tr } from './i18n'

/**
 * Providers the welcome screen offers for "paste a key". Each key page and model name was opened and read at
 * the provider's own site; the model is only the starting value, the field stays editable.
 */
export const CONNECT_PROVIDERS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', model: 'deepseek/deepseek-chat', keyUrl: 'https://openrouter.ai/settings/keys' }
] as const

/** The one small request that proves a key works: the Anthropic-style messages call Claude Code itself makes. */
export function keyTestRequest(baseUrl: string, model: string, key: string): { url: string; init: RequestInit } {
  return {
    url: `${baseUrl.replace(/\/+$/, '')}/v1/messages`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] })
    }
  }
}

/** A sentence for a failed test request; `detail` is the provider's own message when it sent one. */
export function explainKeyFailure(status: number, detail: string, model: string): string {
  if (status === 401 || status === 403) return tr("Furnizorul a respins cheia. Verifică că ai copiat-o întreagă, fără spații.")
  if (status === 402) return tr("Contul nu are sold. Alimentează-l pe pagina furnizorului și încearcă din nou.")
  if (status === 429) return tr("Prea multe cereri sau limita contului a fost atinsă. Încearcă din nou peste puțin.")
  if (status === 400 || status === 404) return tr("Furnizorul nu a acceptat modelul „{model}”. Verifică numele lui în documentația furnizorului. {detail}", { model, detail })
  return tr("Furnizorul a răspuns cu eroarea HTTP {status}. {detail}", { status, detail })
}

/**
 * The quiet "bring your own key" suggestion: only once the user has had a chat and only while every profile is
 * OpenCode's free models. Dismissing it once ends it for good.
 */
export function wantsOwnKeyHint(profiles: Pick<Profile, 'engine'>[], sessionCount: number, dismissed?: boolean): boolean {
  return !dismissed && sessionCount > 0 && profiles.length > 0 && profiles.every((p) => p.engine === 'opencode')
}
