import { CONNECT_PROVIDERS, explainKeyFailure, keyTestRequest, modelListUrls } from '@shared/setup'
import { parseProviderList } from './model-watch-core'
import * as store from './store'
import { opencodeOnce } from './engines/opencode-runtime'
import { tr } from '@shared/i18n'

/** Sends the one small request that proves a key works; throws a sentence the welcome screen shows as it is. */
export async function testKey(baseUrl: unknown, model: unknown, key: unknown): Promise<void> {
  // the key only ever goes to a provider the welcome screen offers
  if (typeof baseUrl !== 'string' || !CONNECT_PROVIDERS.some((p) => p.baseUrl === baseUrl)) throw new Error(tr("Furnizor necunoscut"))
  if (typeof model !== 'string' || !model.trim()) throw new Error(tr("Scrie numele modelului."))
  if (typeof key !== 'string' || !key.trim()) throw new Error(tr("Lipește cheia API."))
  const { url, init } = keyTestRequest(baseUrl, model.trim(), key.trim())
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) })
  } catch (e) {
    throw new Error(tr("Nu am putut ajunge la furnizor: {reason}", { reason: e instanceof Error ? e.message : String(e) }))
  }
  const body = await res.text()
  if (!res.ok) {
    let detail = ''
    try { detail = String(JSON.parse(body)?.error?.message ?? '') } catch { /* the body was not JSON */ }
    throw new Error(explainKeyFailure(res.status, detail.slice(0, 160), model.trim()))
  }
}

/**
 * The model ids a provider publishes, for the picker in the profile form. The key (typed, else the one saved for the
 * profile when its address is on the same host) goes only to the host of `baseUrl`, and only over https.
 */
export async function providerModels(baseUrl: unknown, typedKey: unknown, profileId: unknown): Promise<string[]> {
  let host: string
  try {
    const url = new URL(String(baseUrl))
    if (url.protocol !== 'https:') throw new Error('http')
    host = url.host
  } catch {
    throw new Error(tr("Furnizor necunoscut"))
  }
  let key = typeof typedKey === 'string' ? typedKey.trim() : ''
  if (!key && typeof profileId === 'string') {
    const saved = store.loadProfiles().find((p) => p.id === profileId)
    if (saved?.baseUrl && new URL(saved.baseUrl).host === host) key = store.getSecret(profileId) ?? ''
  }
  const headers: Record<string, string> = { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }
  for (const url of modelListUrls(String(baseUrl))) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' })
      if (!res.ok) continue
      const text = await res.text()
      if (text.length > 8_000_000) continue
      const ids = parseProviderList(JSON.parse(text)).map((m) => m.id)
      if (ids.length) return ids
    } catch {
      // not the list's address, try the next one
    }
  }
  throw new Error(tr("Furnizorul nu a dat o listă de modele. Scrie numele lor cu mâna."))
}

/** One real prompt to a free OpenCode model, so "it works" means an answer came back. */
export async function testFree(model: unknown): Promise<void> {
  if (typeof model !== 'string' || !/^[\w.\-/:]+$/.test(model)) throw new Error(tr("Model necunoscut"))
  await opencodeOnce('Reply with the single word OK.', model)
}
