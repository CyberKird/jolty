/**
 * A web image whose address could be carrying data out: an injected page can ask the model to "show" an image whose URL holds
 * what it read. Ordinary image links have a short query or none, so those load by themselves; the rest wait for a click.
 */
export function needsClick(src: string): boolean {
  if (!/^https:\/\//i.test(src)) return false
  try {
    const u = new URL(src)
    if (u.username || u.password) return true
    if (u.search.length > 80 || u.hash.length > 1) return true
    return u.pathname.split('/').some((seg) => seg.length > 120)
  } catch {
    return true
  }
}

/** What an answer may embed as an image: https, or an absolute path to an image file on this PC. */
export function embeddable(src: string): boolean {
  return /^https:\/\//i.test(src) || /^(?:file:\/\/\/?|\/)?[a-z]:[\\/].*\.(png|jpe?g|gif|webp)$/i.test(src)
}
