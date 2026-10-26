export const KOFI_URL = 'https://ko-fi.com/joltarise'
export const CONTACT = 'contact@joltarise.com'

/** Links the app may open outside: web pages, and mail only to Jolty's own address. */
export function openableUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' || (u.protocol === 'mailto:' && decodeURIComponent(u.pathname) === CONTACT)
  } catch {
    return false
  }
}

/** The bug report mail: what the user wrote, then the facts that help find the problem. Windows caps mailto URLs, so the text is cut. */
export function bugReportUrl(text: string, facts: string): string {
  const body = `${text.trim().slice(0, 1200)}\n\n---\n${facts}`
  return `mailto:${CONTACT}?subject=${encodeURIComponent('Jolty: bug report')}&body=${encodeURIComponent(body)}`
}

export const REPORTS_PER_HOUR = 3
const MIN_REPORT = 15

/** Spam brake for the in-app report: a few words at least, no link lists, and a few reports per hour (`sent` = past send times in ms). */
export function reportCheck(text: string, sent: number[], now: number): 'ok' | 'short' | 'links' | 'wait' {
  const t = text.trim()
  if (t.length < MIN_REPORT) return 'short'
  if ((t.match(/https?:\/\//gi) ?? []).length > 2) return 'links'
  return sent.filter((at) => now - at < 36e5).length >= REPORTS_PER_HOUR ? 'wait' : 'ok'
}
