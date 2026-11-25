/** What remote/phone.ts reads about the visible area of the phone's screen. */
export interface ViewportRead {
  /** a text field has focus: the only time a keyboard can be up */
  typing: boolean
  /** window.visualViewport: height and offsetTop */
  vvHeight: number
  vvTop: number
  /** the tallest the visible area has been with no field in use */
  full: number
  /** Jolty opened from the iPhone's home screen (standalone), where the app always covers the whole screen */
  iphoneApp: boolean
  screenW: number
  screenH: number
  landscape: boolean
}

export interface ViewportFit {
  /** the page takes the visible area's height and offset (--vvh, --vvt) instead of filling the screen by itself */
  follow: boolean
  height?: number
  top?: number
  keyboard: boolean
  /** the least height the page may have: the whole screen of an iPhone home screen app */
  floor?: number
}

/**
 * How tall the phone's page is. With no field in use it fills the screen by itself (a fixed box pinned to all four edges): the visible
 * area's height is not used then, because an iPhone reports it wrong in ways that left a dark band under the app: short by the status
 * bar in a home screen app, and stale (still the keyboard's height) for a while after the keyboard went down. Only while a field has
 * focus does the page follow the visible area, so the box stays above the keyboard that covers the page instead of shrinking it.
 */
export function fitViewport(r: ViewportRead): ViewportFit {
  if (r.typing) return { follow: true, height: r.vvHeight, top: r.vvTop, keyboard: r.vvHeight < r.full - 110 }
  // iOS does not turn screen.width and height with the phone
  const floor = r.iphoneApp && r.screenW > 0 && r.screenH > 0 ? (r.landscape ? Math.min(r.screenW, r.screenH) : Math.max(r.screenW, r.screenH)) : undefined
  return { follow: false, keyboard: false, floor }
}
