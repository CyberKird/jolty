// Low-power mode for weak PCs: the class `low-power` on <html> (lowpower.css and the mascot key off it).
export type LowPowerMode = 'auto' | 'on' | 'off'

let mode: LowPowerMode = 'auto'

/** The graphics chip as Chromium reports it: none at all, software drawing, a chip built into the processor, or a real card. */
let kind: ReturnType<typeof gpuKind> | undefined
function gpuKind(): 'none' | 'software' | 'integrated' | 'discrete' {
  if (kind) return kind
  return (kind = probeGpu())
}
function probeGpu(): 'none' | 'software' | 'integrated' | 'discrete' {
  try {
    const gl = document.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null
    if (!gl) return 'none'
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    if (/swiftshader|llvmpipe|software|basic render|warp|softpipe/i.test(name)) return 'software'
    // Radeon cards are "RX ..." or "Pro ..."; the chip inside a Ryzen is plain "Radeon(TM) Graphics" or "Vega"
    if (/intel|uhd|iris|hd graphics|vega|radeon\(tm\) graphics|adreno|mali|powervr/i.test(name) && !/arc|rx\s?(\d|vega)|vega\s?(56|64)|radeon vii|pro\s?w/i.test(name)) return 'integrated'
    return 'discrete'
  } catch {
    return 'none'
  }
}

/**
 * What this PC can draw smoothly: 4 cores or fewer, 4 GB of memory or less (deviceMemory is Chromium's rounded figure), no hardware
 * graphics at all, or a chip built into the processor driving a screen of 4 megapixels or more (a 4K panel).
 */
function weakPc(): boolean {
  const memory = (navigator as { deviceMemory?: number }).deviceMemory
  if (navigator.hardwareConcurrency <= 4 || (memory !== undefined && memory <= 4)) return true
  const gpu = gpuKind()
  if (gpu === 'none' || gpu === 'software') return true
  return gpu === 'integrated' && screen.width * screen.height * devicePixelRatio * devicePixelRatio >= 4e6
}

/** A chip built into the processor (at any screen size) keeps the glass look but not the bending of the chat under the header and the box. */
export function liteGlass(): boolean {
  return mode === 'auto' && gpuKind() === 'integrated'
}

/** A phone paired with the PC (html.remote): its core count says little, a recent phone draws this page smoothly, so "auto" means off there. */
const onPhone = (): boolean => document.documentElement.classList.contains('remote')

export function lowPower(): boolean {
  return mode === 'on' || (mode === 'auto' && !onPhone() && weakPc())
}

/** Applies the saved choice; also tells whoever listens (the mascot) that it changed. */
export function setLowPowerMode(next: LowPowerMode | undefined): void {
  mode = next === 'on' || next === 'off' ? next : 'auto'
  const on = lowPower()
  const root = document.documentElement
  root.classList.toggle('lite-glass', liteGlass())
  if (root.classList.contains('low-power') === on) return
  root.classList.toggle('low-power', on)
  window.dispatchEvent(new CustomEvent('jolty:lowpower', { detail: on }))
}
