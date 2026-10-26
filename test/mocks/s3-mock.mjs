// Just enough of S3 for the backup tests: path-style HEAD bucket and HEAD/PUT/GET object, with the SigV4 Authorization
// header of every request recomputed here with an implementation of its own (not src/main/backup/sigv4.ts), so a
// signer bug fails the tests instead of being copied into the mock. Used by test/backup-providers/s3-test.ts.
import crypto from 'node:crypto'
import http from 'node:http'

export const REGION = 'eu-test-1'
export const A = { bucket: 'bucket-a', accessKeyId: 'AKIAAAAAAAAAAAAAAAAA', secretAccessKey: 'secret-a/xyz+123' }
export const B = { bucket: 'bucket-b', accessKeyId: 'AKIABBBBBBBBBBBBBBBB', secretAccessKey: 'secret-b/abc+987' }
/** exists, but in another region: every request gets 301 like AWS does */
export const MOVED = 'bucket-moved'

const H = (algo, data, enc) => crypto.createHash(algo).update(data).digest(enc)
const MAC = (key, data) => crypto.createHmac('sha256', key).update(data).digest()

/** Percent-encodes every byte except A-Z a-z 0-9 - _ . ~ (S3 encodes a path once and keeps the slashes). */
function enc(text) {
  let out = ''
  for (const byte of Buffer.from(text, 'utf8')) {
    const c = String.fromCharCode(byte)
    out += /[A-Za-z0-9\-_.~]/.test(c) ? c : '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

/** Returns '' when the request is signed correctly by one of `accounts`, otherwise the reason it is not. */
function check(req, body, accounts) {
  const auth = req.headers.authorization || ''
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(auth)
  if (!m) return 'malformed Authorization'
  const [, keyId, day, region, signedList, given] = m
  const account = accounts.find((a) => a.accessKeyId === keyId)
  if (!account) return 'unknown access key'
  if (region !== REGION) return `wrong region ${region}`
  const stamp = req.headers['x-amz-date'] || ''
  if (!stamp.startsWith(day) || !/^\d{8}T\d{6}Z$/.test(stamp)) return 'bad x-amz-date'
  const t = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15))
  if (Math.abs(Date.now() - t) > 15 * 60_000) return 'clock skew'
  const claimed = req.headers['x-amz-content-sha256']
  if (claimed !== H('sha256', body, 'hex')) return 'payload hash does not match the body'
  const names = signedList.split(';')
  for (const must of ['host', 'x-amz-date', 'x-amz-content-sha256']) if (!names.includes(must)) return `${must} not signed`
  if (names.join(';') !== [...names].sort().join(';')) return 'signed headers not sorted'

  const raw = req.url.split('?')
  const uri = raw[0].split('/').map((seg) => enc(decodeURIComponent(seg))).join('/')
  const query = (raw[1] || '').split('&').filter(Boolean).map((p) => p.split('=')).map(([k, v = '']) => `${enc(decodeURIComponent(k))}=${enc(decodeURIComponent(v))}`).sort().join('&')
  const headers = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/ +/g, ' ')}\n`).join('')
  const canonical = `${req.method}\n${uri}\n${query}\n${headers}\n${signedList}\n${claimed}`
  const scope = `${day}/${region}/s3/aws4_request`
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${H('sha256', canonical, 'hex')}`
  let key = Buffer.from('AWS4' + account.secretAccessKey)
  for (const part of [day, region, 's3', 'aws4_request']) key = MAC(key, part)
  const want = crypto.createHmac('sha256', key).update(toSign).digest('hex')
  const a = Buffer.from(want)
  const b = Buffer.from(given)
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? '' : 'signature mismatch'
}

/** `objects` is "bucket/key" -> {data, modified}; `log` has one line per request, with the verdict on the signature. */
export async function startS3Mock() {
  const objects = new Map()
  const accounts = [A, B]
  const log = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const send = (code, headers = {}, payload) => {
      res.writeHead(code, headers)
      res.end(req.method === 'HEAD' ? undefined : payload)
    }
    const bad = check(req, body, accounts)
    log.push(`${req.method} ${req.url} ${bad || 'ok'}`)
    if (bad) return send(403, { 'content-type': 'application/xml' }, `<Error><Code>SignatureDoesNotMatch</Code><Message>${bad}</Message></Error>`)

    const path = decodeURIComponent(req.url.split('?')[0]).slice(1)
    const slash = path.indexOf('/')
    const bucket = slash < 0 ? path : path.slice(0, slash)
    const key = slash < 0 ? '' : path.slice(slash + 1)
    const keyId = /Credential=([^/]+)\//.exec(req.headers.authorization)[1]
    if (bucket === MOVED) return send(301, { 'x-amz-bucket-region': 'us-east-1' }, '<Error><Code>PermanentRedirect</Code></Error>')
    const owner = accounts.find((a) => a.bucket === bucket)
    if (!owner) return send(404, {}, '<Error><Code>NoSuchBucket</Code></Error>')
    if (owner.accessKeyId !== keyId) return send(403, {}, '<Error><Code>AccessDenied</Code></Error>')
    if (!key) return req.method === 'HEAD' ? send(200, { 'x-amz-bucket-region': REGION }) : send(405)

    const id = `${bucket}/${key}`
    if (req.method === 'PUT') {
      objects.set(id, { data: body, modified: new Date(Math.floor(Date.now() / 1000) * 1000) })
      return send(200, { etag: `"${H('md5', body, 'hex')}"` })
    }
    const o = objects.get(id)
    if (!o) return send(404, {}, '<Error><Code>NoSuchKey</Code></Error>')
    if (req.method === 'HEAD' || req.method === 'GET') return send(200, { 'content-length': o.data.length, 'last-modified': o.modified.toUTCString(), 'content-type': 'application/octet-stream' }, o.data)
    return send(405)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}`, objects, log, close: () => server.close() }
}
