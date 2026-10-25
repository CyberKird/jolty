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

/** a burst of bolts from a point: fanned around a direction (up by default), or all the way around (radial) */
const few = (n: number): number => (document.documentElement.classList.contains('low-power') ? Math.ceil(n / 2.2) : n)

export function sparks(x: number, y: number, dir = -Math.PI / 2, radial = false): void {
  if (document.documentElement.classList.contains('reduce-motion')) return
  const n = few(9)
  for (let i = 0; i < n; i++) {
    const a = radial ? dir + (i / n) * Math.PI * 2 : dir + (i - (n - 1) / 2) * 0.36 * (9 / n)
    const d = rand(radial ? 26 : 34, radial ? 46 : 58)
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

/** a puff of dust where something hit, thrown out along the surface and up; harder hits throw more */
export function dust(x: number, y: number, strength: number): void {
  if (document.documentElement.classList.contains('reduce-motion')) return
  const n = few(Math.min(9, 3 + Math.round(strength * 3)))
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1
    const d = rand(10, 24 + strength * 14)
    const size = rand(4, 8 + strength * 3)
    spawn('mascot-dust', {
      '--x0': `${x - size / 2}px`,
      '--y0': `${y - size / 2}px`,
      '--x1': `${x - size / 2 + side * d}px`,
      '--y1': `${y - size / 2 - rand(3, 12)}px`,
      '--s': `${size}px`
    })
  }
}

export function streak(x0: number, y0: number, x1: number, y1: number): void {
  spawn('mascot-streak', {
    width: `${Math.hypot(x1 - x0, y1 - y0)}px`,
    transform: `translate(${x0}px, ${y0}px) rotate(${Math.atan2(y1 - y0, x1 - x0)}rad)`
  })
}
