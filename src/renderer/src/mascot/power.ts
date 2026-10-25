/**
 * The light mode for weak PCs: the app marks it with the `low-power` class on <html> (read defensively, it may be
 * absent). He then draws at 24 fps (12 when nothing moves), at pixel ratio 1, without the glow pass, with fewer
 * particles.
 */
export const lowPower = (): boolean => document.documentElement.classList.contains('low-power')

/** calls back when the class appears or goes; returns the way to stop watching */
export function watchPower(fn: (low: boolean) => void): () => void {
  let was = lowPower()
  const mo = new MutationObserver(() => {
    const now = lowPower()
    if (now === was) return
    was = now
    fn(now)
  })
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => mo.disconnect()
}
