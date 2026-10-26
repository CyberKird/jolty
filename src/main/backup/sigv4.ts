// AWS Signature Version 4 for the S3 REST API, header style, no SDK. Pure: the time comes in as an argument.
import { createHash, createHmac } from 'node:crypto'

const sha256 = (d: string | Buffer): string => createHash('sha256').update(d).digest('hex')
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest()

/** RFC 3986 unreserved characters stay, everything else becomes %XX in capitals (encodeURIComponent also keeps !'()*). */
export const uriEncode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** A key as a URL path: every segment encoded once, '/' kept (S3 does not normalize or double encode). */
export const encodeKey = (key: string): string => key.split('/').map(uriEncode).join('/')

export interface SignRequest {
  method: string
  url: URL
  /** the headers to send besides the ones added here; all of them are signed */
  headers?: Record<string, string>
  body?: Buffer
  region: string
  service?: string
  accessKeyId: string
  secretAccessKey: string
  date: Date
}

export interface Signed {
  /** what to send: lowercase names, without host (the HTTP client sets it from the URL) */
  headers: Record<string, string>
  canonicalRequest: string
  stringToSign: string
  signature: string
}

const byKey = (a: [string, string], b: [string, string]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)

export function signV4(r: SignRequest): Signed {
  const service = r.service ?? 's3'
  const stamp = r.date.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const day = stamp.slice(0, 8)
  const payload = sha256(r.body ?? '')

  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(r.headers ?? {})) h[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ')
  h.host = r.url.host
  h['x-amz-date'] = stamp
  h['x-amz-content-sha256'] = payload
  const names = Object.keys(h).sort()
  const signedHeaders = names.join(';')

  const uri = r.url.pathname.split('/').map((s) => uriEncode(decodeURIComponent(s))).join('/')
  const query = [...r.url.searchParams].map(([k, v]): [string, string] => [uriEncode(k), uriEncode(v)]).sort(byKey).map(([k, v]) => `${k}=${v}`).join('&')
  const canonicalRequest = [r.method, uri, query, names.map((n) => `${n}:${h[n]}\n`).join(''), signedHeaders, payload].join('\n')

  const scope = `${day}/${r.region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonicalRequest)].join('\n')
  const key = hmac(hmac(hmac(hmac('AWS4' + r.secretAccessKey, day), r.region), service), 'aws4_request')
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex')

  const { host: _host, ...send } = h
  send.authorization = `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`
  return { headers: send, canonicalRequest, stringToSign, signature }
}
