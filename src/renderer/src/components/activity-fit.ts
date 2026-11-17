// The names under and over the activity board's orbs must never touch and never leave the board, at any width and in any language
// (French "Navigateur" next to "Sous-agents" is the longest pair). Measured only when the board or a name changes size, never per frame:
// - when two neighbours in a row would come within 4 px, that row staggers its names on two lines (every second one moves out);
// - a name that would run past the board's left or right edge is pulled back inside it.
import { useLayoutEffect, type RefObject } from 'react'

const GAP = 4

export function useLabelFit(box: RefObject<HTMLDivElement | null>, deps: unknown[]): void {
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    let raf = 0
    const fit = (): void => {
      raf = 0
      const b = el.getBoundingClientRect()
      if (!b.width) return
      for (const row of ['top', 'bottom']) {
        const labels = [...el.querySelectorAll<HTMLElement>(`.ag-node.${row} .ag-label`)]
        // measure where they would be without any correction
        labels.forEach((l) => (l.style.translate = ''))
        const text = labels.map((l) => {
          const r = l.getBoundingClientRect()
          return { l, left: r.left, right: r.right }
        })
        // inside the board
        for (const t of text) {
          const over = t.right - b.right
          const under = b.left - t.left
          const dx = over > 0 ? -over : under > 0 ? under : 0
          if (dx) {
            t.l.style.translate = `${dx.toFixed(1)}px 0`
            t.left += dx
            t.right += dx
          }
        }
        let crowded = false
        for (let i = 1; i < text.length; i++) if (text[i].left - text[i - 1].right < GAP) crowded = true
        el.classList.toggle(`stagger-${row}`, crowded)
      }
    }
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(fit)
    })
    ro.observe(el)
    el.querySelectorAll('.ag-label').forEach((l) => ro.observe(l))
    fit()
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
