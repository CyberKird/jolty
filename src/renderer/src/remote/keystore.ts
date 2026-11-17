// The phone's key to the PC, kept in three places so that losing one never unpairs the phone: localStorage, IndexedDB, and
// the PC's own HttpOnly cookie (renewed from here after every connection). Safari may clear a site's storage after a week
// without a visit, a browser may evict one store under pressure; whichever copy is left restores the others. The key is
// forgotten only when the PC says this phone was revoked.

const KEY = 'jolty-remote-token'
const DB = 'jolty-remote'
const STORE = 'kv'

function db(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(undefined)
      req.onblocked = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

/** An IndexedDB step that gives up after a moment: Safari's IndexedDB can hang, and the page must not wait on it. */
function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const work = db().then(
    (d) =>
      new Promise<T | undefined>((resolve) => {
        if (!d) return resolve(undefined)
        try {
          const tx = d.transaction(STORE, mode)
          const req = run(tx.objectStore(STORE))
          tx.oncomplete = () => (d.close(), resolve(req ? req.result : undefined))
          tx.onerror = tx.onabort = () => (d.close(), resolve(undefined))
        } catch {
          d.close()
          resolve(undefined)
        }
      })
  )
  return Promise.race([work, new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500))])
}

function local(): string {
  try {
    return localStorage.getItem(KEY) || ''
  } catch {
    return ''
  }
}

/** The key, from whichever store still has it; a copy found in only one store is written back to the other. */
export async function loadKey(): Promise<string> {
  const a = local()
  if (a) {
    void idb('readwrite', (s) => void s.put(a, KEY))
    return a
  }
  const b = await idb<string>('readonly', (s) => s.get(KEY))
  if (typeof b === 'string' && b) {
    try {
      localStorage.setItem(KEY, b)
    } catch {
      // storage blocked: IndexedDB keeps it
    }
    return b
  }
  return ''
}

/** Keeps the key everywhere and asks the browser not to evict this site's storage. */
export async function saveKey(token: string): Promise<void> {
  if (!token) return
  try {
    localStorage.setItem(KEY, token)
  } catch {
    // the other copies hold it
  }
  await idb('readwrite', (s) => void s.put(token, KEY))
  void navigator.storage?.persist?.().catch(() => false)
}

/** Renews the PC's cookie with the key this phone holds (the cookie is the copy that survives Safari clearing the site's storage). */
export function renewCookie(token: string): void {
  if (!token) return
  void fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), cache: 'no-store', credentials: 'same-origin' }).catch(() => undefined)
}

/**
 * Asks the PC whether this phone is still paired, by its key or by the cookie: 'yes', 'revoked' (the only answer that
 * unpairs), 'no' (the PC does not know it: not paired yet, or the PC's list is gone), or 'unknown' (no answer, try later).
 */
export async function askPaired(token: string): Promise<'yes' | 'no' | 'revoked' | 'unknown'> {
  try {
    const res = token
      ? await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), cache: 'no-store', signal: AbortSignal.timeout(15000) })
      : await fetch('/api/session', { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    if (res.ok) return 'yes'
    // only this server's own answer counts: a gateway error (Tailscale while Jolty restarts) is "no answer"
    if (res.status !== 401) return 'unknown'
    const j = (await res.json().catch(() => ({}))) as { revoked?: boolean; ok?: boolean }
    if (j.ok !== false) return 'unknown'
    return j.revoked ? 'revoked' : 'no'
  } catch {
    return 'unknown'
  }
}

/** Forgets the key: only after the PC said this phone was revoked. */
export async function dropKey(): Promise<void> {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // nothing kept there
  }
  await idb('readwrite', (s) => void s.delete(KEY))
}
