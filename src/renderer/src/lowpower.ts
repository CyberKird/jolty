// Low-power mode for weak PCs: the class `low-power` on <html> (lowpower.css and the mascot key off it).
export type LowPowerMode = 'auto' | 'on' | 'off'

let mode: LowPowerMode = 'auto'

/** 4 cores or fewer, or 4 GB of memory or less (deviceMemory is Chromium's rounded figure) */
function weakPc(): boolean {
  const memory = (navigator as { deviceMemory?: number }).deviceMemory
  return navigator.hardwareConcurrency <= 4 || (memory !== undefined && memory <= 4)
}

export function lowPower(): boolean {
  return mode === 'on' || (mode === 'auto' && weakPc())
}

/** Applies the saved choice; also tells whoever listens (the mascot) that it changed. */
export function setLowPowerMode(next: LowPowerMode | undefined): void {
  mode = next === 'on' || next === 'off' ? next : 'auto'
  const on = lowPower()
  const root = document.documentElement
  if (root.classList.contains('low-power') === on) return
  root.classList.toggle('low-power', on)
  window.dispatchEvent(new CustomEvent('jolty:lowpower', { detail: on }))
}
