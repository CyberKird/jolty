// Any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, DigitalOcean Spaces). Path style:
// {endpoint}/{bucket}/{prefix}jolty-backup.enc, every request signed with SigV4. The backup is already encrypted.
import { tr } from '@shared/i18n'
import { encodeKey, signV4, uriEncode } from '../sigv4'
import { BackupError, FILE, type Config, type Provider } from '../types'

const TIMEOUT = 5 * 60_000

interface Target {
  base: URL
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
}

function target(cfg: Config): Target {
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'].map((k) => (cfg[k] ?? '').trim())
  if (![endpoint, region, bucket, accessKeyId, secretAccessKey].every(Boolean)) throw new BackupError(tr("Completează mai întâi câmpurile de conectare."))
  let base: URL
  try {
    base = new URL(endpoint)
  } catch {
    throw new BackupError(tr("Adresa (endpoint) nu e validă."))
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new BackupError(tr("Adresa (endpoint) nu e validă."))
  // a prefix is folder-like: no leading slash, one trailing slash, and no segments the URL parser would resolve away
  const prefix = (cfg.prefix ?? '').split('/').filter(Boolean)
  if (prefix.some((s) => s === '.' || s === '..')) throw new BackupError(tr("Prefixul nu poate conține «.» sau «..»."))
  return { base, region, bucket, prefix: prefix.map((s) => s.trim()).join('/') + (prefix.length ? '/' : ''), accessKeyId, secretAccessKey }
}

/** The request goes out as-is: a redirect (wrong region or endpoint) must reach us as a status, not be followed. */
async function call(cfg: Config, method: 'HEAD' | 'PUT' | 'GET', withKey: boolean, body?: Buffer): Promise<Response> {
  const t = target(cfg)
  const root = t.base.pathname.replace(/\/+$/, '')
  const url = new URL(`${t.base.origin}${root}/${uriEncode(t.bucket)}${withKey ? '/' + encodeKey(t.prefix + FILE) : ''}`)
  const signed = signV4({ method, url, body, headers: body ? { 'content-type': 'application/octet-stream' } : {}, region: t.region, accessKeyId: t.accessKeyId, secretAccessKey: t.secretAccessKey, date: new Date() })
  try {
    return await fetch(url, { method, headers: signed.headers, body: body ? new Uint8Array(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) })
  } catch {
    throw new BackupError(tr("Nu pot ajunge la {host}.", { host: url.host }))
  }
}

function fail(res: Response): never {
  const code = res.status
  if (code === 403) throw new BackupError(tr("Cheile sunt greșite sau nu au voie să folosească bucket-ul ({code}).", { code }))
  if (code === 404) throw new BackupError(tr("Bucket-ul nu există ({code}).", { code }))
  if (code === 400 || (code >= 300 && code < 400)) throw new BackupError(tr("Regiunea sau adresa nu se potrivesc cu bucket-ul ({code}).", { code }))
  throw new BackupError(tr("{provider} a răspuns cu eroarea {code}.", { provider: 'S3', code }))
}

export const s3: Provider = {
  id: 's3',
  info: () => ({
    id: 's3',
    name: 'S3 / R2 / B2 (S3-compatible)',
    kind: 'credentials',
    fields: [
      { key: 'endpoint', label: 'Endpoint', placeholder: 'https://s3.eu-central-1.amazonaws.com' },
      { key: 'region', label: 'Region', placeholder: 'eu-central-1 (auto for R2)' },
      { key: 'bucket', label: 'Bucket', placeholder: 'my-backups' },
      { key: 'accessKeyId', label: 'Access key ID' },
      { key: 'secretAccessKey', label: 'Secret access key', secret: true },
      { key: 'prefix', label: 'Folder (prefix)', placeholder: 'jolty/', optional: true }
    ],
    help: tr("Merge cu AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO și DigitalOcean Spaces. Creează un bucket și o cheie de acces cu drept de citire și scriere doar pe el, apoi lipește adresa (endpoint), regiunea (pentru R2: auto) și cheile.")
  }),

  async connect(cfg) {
    const t = target(cfg)
    const res = await call(cfg, 'HEAD', false)
    if (res.status !== 200) fail(res)
    return { sub: `${t.base.href.replace(/\/+$/, '')}|${t.bucket}|${t.prefix}|${t.accessKeyId}`, label: `${t.bucket} (${t.base.host})` }
  },

  async find(cfg) {
    const res = await call(cfg, 'HEAD', true)
    if (res.status === 404) return null
    if (res.status !== 200) fail(res)
    return { modifiedAt: Date.parse(res.headers.get('last-modified') ?? '') || Date.now(), bytes: Number(res.headers.get('content-length')) }
  },

  async put(cfg, data) {
    const res = await call(cfg, 'PUT', true, data)
    if (!res.ok) fail(res)
  },

  async get(cfg) {
    const res = await call(cfg, 'GET', true)
    if (res.status === 404) throw new BackupError(tr("Nu există niciun backup în acest loc."))
    if (!res.ok) fail(res)
    return Buffer.from(await res.arrayBuffer())
  }
}
