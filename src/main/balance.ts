// Remaining balance for Anthropic-compatible providers that document a balance endpoint.
// Only official endpoints, and the key only goes back to the host the profile already uses.
import type { Profile, ProviderBalance, TurnUsage } from '@shared/types'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Parsed = Omit<ProviderBalance, 'profileId' | 'updatedAt'> | undefined

interface Provider {
  host: RegExp
  url: (base: URL) => string
  parse: (json: any, base: URL) => Parsed
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

const PROVIDERS: Provider[] = [
  // https://api-docs.deepseek.com/api/get-user-balance
  {
    host: /^api\.deepseek\.com$/,
    url: () => 'https://api.deepseek.com/user/balance',
    parse: (j) => {
      const list: any[] = Array.isArray(j?.balance_infos) ? j.balance_infos : []
      const b = list.find((x) => x?.currency === 'USD') || list[0]
      const amount = num(b?.total_balance)
      return amount === undefined ? undefined : { amount, currency: String(b.currency || 'USD'), note: j?.is_available === false ? 'Sold insuficient' : undefined }
    }
  },
  // https://platform.kimi.ai/docs/api/balance
  {
    host: /^api\.moonshot\.(ai|cn)$/,
    url: (base) => `https://${base.host}/v1/users/me/balance`,
    parse: (j, base) => {
      const amount = num(j?.data?.available_balance)
      return amount === undefined ? undefined : { amount, currency: base.host.endsWith('.cn') ? 'CNY' : 'USD' }
    }
  },
  // https://openrouter.ai/docs/api-reference/limits: a regular key only knows its own limit
  {
    host: /^openrouter\.ai$/,
    url: () => 'https://openrouter.ai/api/v1/key',
    parse: (j) => {
      if (!j?.data) return undefined
      const amount = num(j.data.limit_remaining)
      return amount === undefined ? { note: 'Cheia nu are limită. Soldul contului îl vezi pe openrouter.ai.' } : { amount, currency: 'USD' }
    }
  }
]

function providerOf(profile: Profile): { provider: Provider; base: URL } | undefined {
  if (profile.auth !== 'endpoint' || profile.local || !profile.baseUrl) return undefined
  try {
    const base = new URL(profile.baseUrl)
    if (base.protocol !== 'https:') return undefined
    const provider = PROVIDERS.find((p) => p.host.test(base.hostname))
    return provider && { provider, base }
  } catch {
    return undefined
  }
}

export function hasBalance(profile: Profile): boolean {
  return Boolean(providerOf(profile))
}

export async function fetchBalance(profile: Profile, secret: string): Promise<ProviderBalance | undefined> {
  const found = providerOf(profile)
  if (!found) return undefined
  const res = await fetch(found.provider.url(found.base), {
    headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  })
  if (!res.ok) throw new Error(`Soldul nu a putut fi citit (HTTP ${res.status})`)
  const parsed = found.provider.parse(await res.json(), found.base)
  return parsed && { profileId: profile.id, ...parsed, updatedAt: Date.now() }
}

/**
 * What a turn cost on a third-party endpoint, from the prices the user entered ($ per 1M tokens).
 * Claude Code prices every model as an Anthropic one, so without prices there is no cost at all.
 */
export function endpointCost(u: TurnUsage, profile: Profile): number | undefined {
  if (profile.local) return 0
  const p = profile.price
  if (!p) return undefined
  const cacheRead = p.cacheRead ?? p.input
  return (u.inputTokens * p.input + u.cacheWriteTokens * p.input + u.cacheReadTokens * cacheRead + u.outputTokens * p.output) / 1e6
}
