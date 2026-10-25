import { useCallback, useEffect, useRef, useState } from 'react'

/** Length of the exit motion in ms, read from the --t-exit token (0 with Reduce motion). */
export function exitMs(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--t-exit').trim()
  return v.endsWith('ms') ? parseFloat(v) : v.endsWith('s') ? parseFloat(v) * 1000 : 0
}

/**
 * Keeps something mounted while its exit plays. Render `{shown && <div data-state={state}>}`: the entry comes
 * from @starting-style, the exit from the [data-state=closed] rule, and reopening mid-exit reverses from where it is.
 */
export function usePresence(open: boolean): { shown: boolean; state: 'open' | 'closed' } {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  useEffect(() => {
    if (open || !mounted) return
    const id = window.setTimeout(() => setMounted(false), exitMs() + 20)
    return () => window.clearTimeout(id)
  }, [open, mounted])
  return { shown: open || mounted, state: open ? 'open' : 'closed' }
}

/**
 * For a dialog whose parent unmounts it on close: close() plays the exit first, then calls onClose.
 * Calling it twice (Escape and a click) closes once.
 */
export function useExitClose(onClose: () => void): { state: 'open' | 'closed'; close: () => void } {
  const [closing, setClosing] = useState(false)
  const timer = useRef<number>(undefined)
  const last = useRef(onClose)
  last.current = onClose
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const close = useCallback(() => {
    if (timer.current) return
    setClosing(true)
    timer.current = window.setTimeout(() => last.current(), exitMs() + 20)
  }, [])
  return { state: closing ? 'closed' : 'open', close }
}

/**
 * True once the rows already on screen have been styled, so only what arrives afterwards animates in
 * (opening a long conversation must not play sixty entrances).
 */
export function useSettled(ready: boolean): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!ready) return
    let inner = 0
    const outer = requestAnimationFrame(() => (inner = requestAnimationFrame(() => setOn(true))))
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [ready])
  return on
}
