import type { LucideIcon } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

export type PageTab<T extends string> = { id: T; label: string; icon?: LucideIcon; count?: number }

/** The tab a page was left on, remembered between openings. */
export function useSavedTab<T extends string>(key: string, ids: readonly T[]): [T, (t: T) => void] {
  const [tab, setTab] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key) as T | null
      return v && ids.includes(v) ? v : ids[0]
    } catch {
      return ids[0]
    }
  })
  const pick = (t: T): void => {
    setTab(t)
    try {
      localStorage.setItem(key, t)
    } catch {
      // remembering the tab is a convenience only
    }
  }
  return [tab, pick]
}

/** A page's tab strip, in the live panel's look: a volt bar slides to the tab in use. */
export function PageTabs<T extends string>({ tabs, tab, onPick, label }: { tabs: PageTab<T>[]; tab: T; onPick: (t: T) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [bar, setBar] = useState<{ x: number; w: number }>()
  const counts = tabs.map((t) => t.count ?? '').join('|')
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = (): void => {
      const on = el.querySelector<HTMLElement>('.page-tab.on')
      if (on) setBar((b) => (b?.x === on.offsetLeft && b.w === on.offsetWidth ? b : { x: on.offsetLeft, w: on.offsetWidth }))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tab, counts])
  const move = (e: React.KeyboardEvent, i: number): void => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const next = tabs[(i + d * (document.documentElement.dir === 'rtl' ? -1 : 1) + tabs.length) % tabs.length]
    onPick(next.id)
    ref.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus()
  }
  return (
    <div ref={ref} className="page-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          data-tab={t.id}
          role="tab"
          aria-selected={tab === t.id}
          tabIndex={tab === t.id ? 0 : -1}
          className={`page-tab ${tab === t.id ? 'on' : ''}`}
          onClick={() => onPick(t.id)}
          onKeyDown={(e) => move(e, i)}
        >
          {t.icon && <t.icon size={14} strokeWidth={1.8} />}
          {t.label}
          {t.count ? <span className="page-tab-count">{t.count}</span> : null}
        </button>
      ))}
      {bar && <span className="page-tab-bar" style={{ width: bar.w, transform: `translateX(${bar.x}px)` }} aria-hidden />}
    </div>
  )
}
