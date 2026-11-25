import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

/** What one scroll event of the conversation says about following the newest message. */
export interface ScrollRead {
  top: number
  lastTop: number
  scrollHeight: number
  clientHeight: number
  /** a wheel, key, finger or held mouse button moved it just now */
  byUser: boolean
  /** where the chat itself last put the scroll position, if it did */
  ours?: number
  stick: boolean
}

/**
 * Whether the conversation keeps following the newest message after a scroll event.
 * - A position the chat set itself (following a growing answer) is not the reader's: it changes nothing, even when a big block
 *   arrived between the jump and its event and the bottom moved away.
 * - Past the end (the elastic bounce of an iPhone, or content that got shorter and pulled the position back) counts as the end:
 *   the way back from the bounce runs upwards, and it used to let go of the bottom for good.
 * - The reader going up lets go at once, even inside the 120 px; otherwise the next growth pulls them back down.
 * - Anything else (momentum, scroll anchoring) only follows again once it reaches the very bottom.
 */
export function nextStick(s: ScrollRead): boolean {
  const max = Math.max(0, s.scrollHeight - s.clientHeight)
  const top = Math.min(s.top, max)
  const gap = max - top
  if (s.ours !== undefined && Math.abs(top - Math.min(s.ours, max)) < 2) return s.stick
  if (gap <= 2) return s.byUser || top >= Math.min(s.lastTop, max) ? true : s.stick
  if (s.byUser && top < Math.min(s.lastTop, max)) return false
  if (s.byUser) return gap < 120
  return s.stick
}

/**
 * The conversation follows the newest message while the reader is at the bottom, and stays where it is once they scroll up.
 * `stickNow` brings it back to the bottom (a message just sent from the phone).
 */
export function useStickToBottom(dep: unknown): { ref: RefObject<HTMLDivElement | null>; stickNow: () => void } {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const followRef = useRef<() => void>(() => undefined)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let lastInput = 0
    let lastTop = el.scrollTop
    let held = false
    // a finger on the glass: while it rests or drags, the chat does not move under it (an iPhone fights a scroll position set
    // during a drag, and a growth that landed between the touch and its first scroll event yanked the reader back down)
    let touching = false
    let ours: number | undefined
    let lastScroll = 0
    const markInput = (): void => { lastInput = Date.now() }
    // a finger is not "held" the way a mouse button is: the browser takes the touch over for scrolling and sends pointercancel, never pointerup, so a
    // finger would stay "held" for good and every later scroll (the page growing or shrinking under a streaming answer) would look like the reader's
    const onDown = (e: PointerEvent): void => { if (e.pointerType !== 'touch') held = true; markInput() }
    const onUp = (): void => { held = false }
    const onScroll = (): void => {
      const top = el.scrollTop
      lastScroll = Date.now()
      stick.current = nextStick({ top, lastTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, byUser: held || touching || Date.now() - lastInput < 500, ours, stick: stick.current })
      ours = undefined
      lastTop = top
    }
    const onKey = (event: KeyboardEvent): void => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markInput()
    }
    const follow = (): void => {
      if (!stick.current || touching) return
      const before = el.scrollTop
      el.scrollTop = el.scrollHeight
      // only a real move fires a scroll event: remember it so that event is not taken for the reader's
      if (el.scrollTop !== before) ours = el.scrollTop
    }
    followRef.current = follow
    const onTouchStart = (): void => { touching = true; markInput() }
    let catchUp = 0
    const onTouchEnd = (e: TouchEvent): void => {
      markInput()
      if (e.touches.length) return
      touching = false
      // what grew while the finger rested is caught up, if the reader is still at the end. Not at once: the scroll the finger made
      // reaches this thread after the touchend, and setting the position now would undo it; by then its events have let go of the end
      window.clearTimeout(catchUp)
      catchUp = window.setTimeout(() => {
        if (Date.now() - lastScroll > 150) follow()
      }, 250)
    }
    el.addEventListener('wheel', markInput, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', markInput, { passive: true })
    el.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    el.addEventListener('keydown', onKey)
    el.addEventListener('scroll', onScroll)
    const resize = new ResizeObserver(follow)
    if (el.firstElementChild) resize.observe(el.firstElementChild)
    // the box itself too: the room kept under the last message follows the composer's height (a second line, a note, an attachment), and a window
    // or panel resize changes the viewport; neither changes the content, so the observer above never saw them and the chat stopped short of the end
    resize.observe(el)
    follow()
    return () => {
      followRef.current = () => undefined
      window.clearTimeout(catchUp)
      el.removeEventListener('wheel', markInput)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', markInput)
      el.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('scroll', onScroll)
      resize.disconnect()
    }
  }, [])
  useLayoutEffect(() => {
    followRef.current()
  }, [dep])
  const stickNow = useCallback(() => {
    stick.current = true
    followRef.current()
  }, [])
  return { ref, stickNow }
}
