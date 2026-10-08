// Remaining balance for Anthropic-compatible providers that document a balance endpoint.
// Only official endpoints, and the key only goes back to the host the profile already uses.
import type { Profile, ProviderBalance, TurnUsage } from '@shared/types'
import { tr } from '@shared/i18n'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Parsed = Omit<ProviderBalance, 'profileId' | 'updatedAt'> | undefined

interface Provider {
  host: RegExp
  url: (base: URL) => string
  parse: (json: any, base: URL) => Parsed
  /** true when the provider authenticates with browser cookies, not the API key (Xiaomi MiMo) */
  cookieAuth?: boolean
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
      return amount === undefined ? { note: tr("Cheia nu are limită. Soldul contului îl vezi pe openrouter.ai.") } : { amount, currency: 'USD' }
    }
  },
  // https://platform.xiaomimimo.com console: balance is cookie-only, not the API key
  {
    host: /^api\.xiaomimimo\.com$/,
    cookieAuth: true,
    url: () => 'https://platform.xiaomimimo.com/api/v1/balance',
    parse: (j) => {
      if (j?.code !== 0) return undefined
      const amount = num(j?.data?.balance)
      return amount === undefined ? undefined : { amount, currency: String(j.data.currency || 'CNY') }
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

export async function fetchBalance(profile: Profile, secret: string | undefined, cookie: string | undefined): Promise<ProviderBalance | undefined> {
  const found = providerOf(profile)
  if (!found) return undefined
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (found.provider.cookieAuth) {
    if (!cookie) return undefined
    headers.Cookie = cookie
    headers.Origin = 'https://platform.xiaomimimo.com'
    headers.Referer = 'https://platform.xiaomimimo.com/#/console/balance'
    headers['x-timeZone'] = 'UTC+01:00'
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
  } else {
    if (!secret) return undefined
    headers.Authorization = `Bearer ${secret}`
  }
  const res = await fetch(found.provider.url(found.base), {
    headers,
    signal: AbortSignal.timeout(10000)
  })
  if (!res.ok) throw new Error(tr("Soldul nu a putut fi citit (HTTP {status})", { status: res.status }))
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
