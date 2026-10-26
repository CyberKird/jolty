// OAuth 2.0 for the providers that sign in through the browser: authorization code with PKCE (S256) on a loopback
// port that only this call listens on, once, for a state it made up. Tokens are kept in the keychain under the
// provider's id; a refresh token that the provider rotates is replaced as it arrives.
import { createHash, randomBytes } from 'crypto'
import http from 'http'
import type { ProviderId } from '@shared/backup'
import { tr } from '@shared/i18n'
import { getSecret, setSecret } from '../store'
import { BackupError, type Opener } from './types'

export interface OAuthSpec {
  id: ProviderId
  /** shown in errors */
  name: string
  authUrl: string
  tokenUrl: string
  scope: string
  clientId: string
  clientSecret?: string
  /** Box has no PKCE: only the secret proves the client */
  noPkce?: boolean
  extraAuth?: Record<string, string>
  /** the loopback address in the redirect: `localhost` for Microsoft, 127.0.0.1 otherwise */
  host?: string
  /** a fixed port, for providers that need the exact redirect registered; 0 or unset picks a free one */
  port?: number
}

const CONNECT_TIMEOUT = 5 * 60 * 1000
const refreshKey = (id: ProviderId): string => `backup:${id}:refresh`
const b64url = (b: Buffer): string => b.toString('base64url')
const cache = new Map<ProviderId, { token: string; exp: number }>()

export const hasToken = (id: ProviderId): boolean => !!getSecret(refreshKey(id))
/** Removes the tokens here; with `revokeUrl` the provider is also told to drop the refresh token (best effort). */
export async function forgetToken(id: ProviderId, revokeUrl?: string): Promise<void> {
  const refresh = getSecret(refreshKey(id))
  setSecret(refreshKey(id), undefined)
  cache.delete(id)
  if (refresh && revokeUrl) await fetch(`${revokeUrl}?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => undefined)
}

const PAGE = (title: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Jolty</title><body style="font:16px system-ui;background:#0b0b0b;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><p>${title}</p>`

async function form(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body) })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw Object.assign(new BackupError(String(json.error_description || json.error || res.status)), { code: String(json.error || '') })
  return json
}

function keep(id: ProviderId, t: Record<string, unknown>): void {
  if (typeof t.refresh_token === 'string') setSecret(refreshKey(id), t.refresh_token)
  cache.set(id, { token: String(t.access_token), exp: Date.now() + Number(t.expires_in || 3600) * 1000 })
}

/** Opens the provider's sign-in and waits for the answer on the loopback port; stores the tokens. */
export async function oauthConnect(spec: OAuthSpec, open: Opener): Promise<void> {
  const verifier = b64url(randomBytes(32))
  const state = b64url(randomBytes(16))
  const server = http.createServer()
  let timer: NodeJS.Timeout | undefined
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', (e) => reject((e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? new BackupError(tr("Portul {port} e ocupat.", { port: spec.port ?? 0 })) : e))
      server.listen(spec.port ?? 0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    const redirect = `http://${spec.host ?? '127.0.0.1'}:${port}/`
    const code = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new BackupError(tr("Conectarea a durat prea mult."))), CONNECT_TIMEOUT)
      server.on('request', (req, res) => {
        const u = new URL(req.url || '/', redirect)
        // anything but the provider's own answer (a favicon, a scan of the port) is ignored
        if (u.pathname !== '/' || u.searchParams.get('state') !== state) return void res.writeHead(404).end()
        const err = u.searchParams.get('error')
        const got = u.searchParams.get('code')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(err || !got ? tr("Conectarea a eșuat. Poți închide fereastra.") : tr("Gata, te poți întoarce în Jolty.")))
        if (err || !got) reject(new BackupError(tr("Conectarea a fost refuzată.")))
        else resolve(got)
      })
      const url = new URL(spec.authUrl)
      const params: Record<string, string> = { client_id: spec.clientId, redirect_uri: redirect, response_type: 'code', scope: spec.scope, state, ...spec.extraAuth }
      if (!spec.noPkce) Object.assign(params, { code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' })
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
      Promise.resolve(open(url.toString())).catch(reject)
    })
    const body: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: spec.clientId }
    if (!spec.noPkce) body.code_verifier = verifier
    if (spec.clientSecret) body.client_secret = spec.clientSecret
    const t = await form(spec.tokenUrl, body)
    if (!t.refresh_token || !t.access_token) throw new BackupError(tr("Nu am primit acces de lungă durată. Încearcă din nou."))
    keep(spec.id, t)
  } finally {
    if (timer) clearTimeout(timer)
    server.close()
  }
}

async function accessToken(spec: OAuthSpec): Promise<string> {
  const hit = cache.get(spec.id)
  if (hit && hit.exp > Date.now() + 60_000) return hit.token
  const refresh = getSecret(refreshKey(spec.id))
  if (!refresh) throw new BackupError(tr("Contul nu e conectat."))
  try {
    const body: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refresh, client_id: spec.clientId }
    if (spec.clientSecret) body.client_secret = spec.clientSecret
    const t = await form(spec.tokenUrl, body)
    keep(spec.id, t)
    return String(t.access_token)
  } catch (e) {
    cache.delete(spec.id)
    if ((e as { code?: string }).code === 'invalid_grant') {
      void forgetToken(spec.id)
      throw new BackupError(tr("Conexiunea a expirat. Conectează-te din nou."))
    }
    throw e
  }
}

/** A call with the access token; one retry with a new token when the first is refused. Statuses in `accept` come back instead of throwing (a 404 for "no backup yet"). */
export async function oauthFetch(spec: OAuthSpec, url: string, init: RequestInit = {}, accept: number[] = []): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await accessToken(spec)}` } })
    if (res.status === 401 && attempt === 0) {
      cache.delete(spec.id)
      continue
    }
    if (!res.ok && !accept.includes(res.status)) throw new BackupError(tr("{provider} a răspuns cu eroarea {code}.", { provider: spec.name, code: res.status }))
    return res
  }
}
