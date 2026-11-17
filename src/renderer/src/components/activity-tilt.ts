// The activity board leans a few degrees towards the pointer, its tiles and core standing off the surface, so it reads as a physical
// panel. One transform on one layer, written at most once a frame and only while the pointer is over the board; a mouse only (a touch
// screen has no hover), and never with low-power mode or reduced motion.
import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

const MAX_DEG = 5

const still = (): boolean => {
  const c = document.documentElement.classList
  return c.contains('low-power') || c.contains('reduce-motion')
}

export function useTilt(): { stage: RefObject<HTMLDivElement | null>; move: (e: ReactPointerEvent<HTMLElement>) => void; leave: () => void } {
  const stage = useRef<HTMLDivElement>(null)
  const st = useRef({ raf: 0, rect: null as DOMRect | null, x: 0, y: 0 })
  const move = (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.pointerType !== 'mouse' || still()) return
    const s = st.current
    if (!s.rect) s.rect = e.currentTarget.getBoundingClientRect()
    s.x = (e.clientX - s.rect.left) / s.rect.width - 0.5
    s.y = (e.clientY - s.rect.top) / s.rect.height - 0.5
    if (s.raf) return
    s.raf = requestAnimationFrame(() => {
      s.raf = 0
      const el = stage.current
      if (!el) return
      el.classList.add('tilting')
      el.style.transform = `rotateX(${(-s.y * MAX_DEG).toFixed(2)}deg) rotateY(${(s.x * MAX_DEG * 1.2).toFixed(2)}deg)`
    })
  }
  const leave = (): void => {
    const s = st.current
    cancelAnimationFrame(s.raf)
    s.raf = 0
    s.rect = null
    const el = stage.current
    if (!el) return
    el.classList.remove('tilting')
    el.style.transform = ''
  }
  return { stage, move, leave }
}
