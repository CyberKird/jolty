// Phone behaviour of the PC screen page that is not about pictures: Back must not leave it by accident, and the
// browser's own gestures must not take the fingers meant for the PC.
import { useEffect, useState, type RefObject } from 'react'

/**
 * Back (the Android button, a gesture from the edge, the iOS swipe) does not leave the screen view by accident: the
 * first one stays and returns true for 2 s (the page shows a hint), a second one within those 2 s calls `close`
 * (the screen view closes, the app stays).
 */
export function useBackGuard(close: () => void): boolean {
  const [hint, setHint] = useState(false)
  useEffect(() => {
    history.pushState({ pcscreen: true }, '')
    let armed = 0
    let hide: ReturnType<typeof setTimeout> | undefined
    const onPop = (): void => {
      if (Date.now() - armed < 2000) return close()
      armed = Date.now()
      history.pushState({ pcscreen: true }, '')
      setHint(true)
      clearTimeout(hide)
      hide = setTimeout(() => setHint(false), 2000)
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      clearTimeout(hide)
      if ((history.state as { pcscreen?: boolean } | null)?.pcscreen) history.back()
    }
  }, [close])
  return hint
}

/**
 * iOS ignores the page's zoom settings: its own pinch (gesture events) and the rubber band of a moving finger are
 * stopped on the screen, so two fingers always reach the PC. Android keeps to touch-action: none there.
 */
export function useNoBrowserGestures(stage: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = stage.current
    const stop = (e: Event): void => e.preventDefault()
    const move = (e: TouchEvent): void => {
      if (e.cancelable) e.preventDefault()
    }
    document.addEventListener('gesturestart', stop)
    document.addEventListener('gesturechange', stop)
    el?.addEventListener('touchmove', move, { passive: false })
    return () => {
      document.removeEventListener('gesturestart', stop)
      document.removeEventListener('gesturechange', stop)
      el?.removeEventListener('touchmove', move)
    }
  }, [stage])
}
