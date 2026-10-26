// WebDAV (Nextcloud, ownCloud, Synology, pCloud, Koofr...): the backup is one file in a folder the user points at,
// with HTTP Basic auth (an app password).
import { tr } from '@shared/i18n'
import { BackupError, FILE, type Config, type Provider, type Who } from '../types'

export const PRIVATE_HOST = /^(localhost|\[::1\]|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+|[^/]+\.local)$/i

/** The folder address with a trailing slash; plain http only where the password stays in the house. */
function folderUrl(cfg: Config): URL {
  let u: URL
  try {
    u = new URL((cfg.url ?? '').trim())
  } catch {
    throw new BackupError(tr("Adresa nu e validă."))
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && PRIVATE_HOST.test(u.hostname))) throw new BackupError(tr("Parola ar circula necriptat. Folosește https:// (http merge doar în rețeaua locală)."))
  if (!u.pathname.endsWith('/')) u.pathname += '/'
  u.hash = ''
  return u
}

async function dav(cfg: Config, url: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit }, accept: number[] = []): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: { authorization: `Basic ${Buffer.from(`${cfg.user ?? ''}:${cfg.password ?? ''}`).toString('base64')}`, ...init.headers },
      signal: AbortSignal.timeout(180_000)
    })
  } catch {
    throw new BackupError(tr("Nu m-am putut conecta la server."))
  }
  if (res.ok || accept.includes(res.status)) return res
  if (res.status === 401 || res.status === 403) throw new BackupError(tr("Utilizatorul sau parola nu sunt corecte."))
  throw new BackupError(tr("{provider} a răspuns cu eroarea {code}.", { provider: 'WebDAV', code: res.status }))
}

const PROPS = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'
const propfind = (cfg: Config, url: string): Promise<Response> =>
  dav(cfg, url, { method: 'PROPFIND', headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' }, body: PROPS }, [404])

/** The prefix of the DAV namespace varies (d:, D:, none), so only the local name counts. */
const prop = (xml: string, name: string): string | undefined => new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</`, 'i').exec(xml)?.[1]

export const webdav: Provider = {
  id: 'webdav',
  info: () => ({
    id: 'webdav',
    name: 'WebDAV',
    kind: 'credentials',
    fields: [
      { key: 'url', label: 'Folder address', placeholder: 'https://cloud.example.com/remote.php/dav/files/me/Jolty/' },
      { key: 'user', label: 'User' },
      { key: 'password', label: 'Password', secret: true }
    ],
    help: tr("Adresa unui folder care există deja, de pildă la Nextcloud https://gazda/remote.php/dav/files/UTILIZATOR/Jolty/ (la fel la ownCloud, Synology, pCloud, Koofr). Folosește o parolă de aplicație, nu parola contului.")
  }),

  async connect(cfg): Promise<Who> {
    const u = folderUrl(cfg)
    let res = await propfind(cfg, u.href)
    if (res.status === 404) {
      // the folder is missing: one try to create it before giving up
      const made = await dav(cfg, u.href, { method: 'MKCOL' }, [403, 405, 409])
      if (made.status !== 201) throw new BackupError(tr("Folderul nu există și nu am putut să-l creez."))
      res = await propfind(cfg, u.href)
    }
    if (res.status !== 207) throw new BackupError(tr("{provider} a răspuns cu eroarea {code}.", { provider: 'WebDAV', code: res.status }))
    const user = cfg.user ?? ''
    return { sub: `${(u.origin + u.pathname).toLowerCase()}|${user.toLowerCase()}`, label: `${user}@${u.host}`, name: user }
  },

  async find(cfg) {
    const res = await propfind(cfg, new URL(FILE, folderUrl(cfg)).href)
    if (res.status === 404) return null
    const xml = await res.text()
    const at = Date.parse(prop(xml, 'getlastmodified') ?? '')
    return { modifiedAt: Number.isNaN(at) ? Date.now() : at, bytes: Number(prop(xml, 'getcontentlength') ?? 0) }
  },

  async put(cfg, data) {
    await dav(cfg, new URL(FILE, folderUrl(cfg)).href, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(data) })
  },

  async get(cfg) {
    const res = await dav(cfg, new URL(FILE, folderUrl(cfg)).href, { method: 'GET' }, [404])
    if (res.status === 404) throw new BackupError(tr("Nu există niciun backup în acest loc."))
    return Buffer.from(await res.arrayBuffer())
  }
}
