/** Effects drawn outside the mascot: a burst of little bolts and the streak of a dash. */
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)

function spawn(className: string, style: Record<string, string>): void {
  const el = document.createElement('div')
  el.className = className
  for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v)
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove())
  // a hidden or minimised window pauses animations and animationend may never come
  setTimeout(() => el.remove(), 1500)
}

/** a burst of bolts from a point, fanned around a direction (up by default) */
export function sparks(x: number, y: number, dir = -Math.PI / 2): void {
  if (document.documentElement.classList.contains('reduce-motion')) return
  for (let i = 0; i < 9; i++) {
    const a = dir + (i - 4) * 0.36
    const d = rand(34, 58)
    spawn('mascot-spark', {
      '--x0': `${x - 3}px`,
      '--y0': `${y}px`,
      '--x1': `${x - 3 + Math.cos(a) * d}px`,
      '--y1': `${y + Math.sin(a) * d}px`,
      '--r': `${rand(-30, 30)}deg`,
      'animation-delay': `${i * 18}ms`
    })
  }
}

export function streak(x0: number, y0: number, x1: number, y1: number): void {
  spawn('mascot-streak', {
    width: `${Math.hypot(x1 - x0, y1 - y0)}px`,
    transform: `translate(${x0}px, ${y0}px) rotate(${Math.atan2(y1 - y0, x1 - x0)}rad)`
  })
}
