import { CONNECT_PROVIDERS, explainKeyFailure, keyTestRequest } from '@shared/setup'
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

/** One real prompt to a free OpenCode model, so "it works" means an answer came back. */
export async function testFree(model: unknown): Promise<void> {
  if (typeof model !== 'string' || !/^[\w.\-/:]+$/.test(model)) throw new Error(tr("Model necunoscut"))
  await opencodeOnce('Reply with the single word OK.', model)
}
