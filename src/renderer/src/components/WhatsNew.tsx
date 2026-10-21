import { Bug, Gem, Sparkles, X, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import changelog from '../../../../CHANGELOG.md?raw'
import { parseChangelog, type Release } from '@shared/changelog'
import { tr } from '@shared/i18n'
import { Bolt } from '../App'
import { api } from '../store'
import { Markdown } from './Rich'
import './whatsnew.css'

const EVENT = 'jolty:whatsnew'
/** releases on screen at first; "Older versions" adds this many more */
const PAGE = 4
/** css px per model unit for the hero Jolty (the in-app one is 0.6) */
const HERO_PX = 1.6

/** Opens the What's new window from anywhere (Settings). */
export function openWhatsNew(): void {
  window.dispatchEvent(new Event(EVENT))
}

const GROUPS: Record<string, { label: () => string; icon: LucideIcon }> = {
  new: { label: () => tr("Nou"), icon: Sparkles },
  improvements: { label: () => tr("Îmbunătățiri"), icon: Gem },
  fixes: { label: () => tr("Reparații"), icon: Bug }
}

/** Jolty cheering in the hero: the app's own 3D model, the eyes on the cursor; still when motion is reduced. */
function HeroJolty() {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let gone = false
    let stop = (): void => undefined
    void import('../mascot/Rig3D').then(({ Rig3D }) => {
      if (gone || !canvas.current) return
      Object.assign(canvas.current.style, { left: '0px', top: '0px' })
      const rig = new Rig3D(canvas.current, HERO_PX)
      const calm = document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches
      const beats: [Parameters<typeof rig.set>[0], Parameters<typeof rig.set>[1], number][] = [
        ['cheer', 'happy', 2600],
        ['wave', 'happy', 2200],
        ['idle', 'open', 3200]
      ]
      let i = 0
      let timer = 0
      const next = (): void => {
        const [pose, eyes, ms] = beats[i++ % beats.length]
        rig.set(pose, eyes)
        timer = window.setTimeout(next, ms)
      }
      rig.face(-1)
      if (calm) rig.set('idle', 'happy')
      else next()
      const look = (e: PointerEvent): void => {
        const r = canvas.current?.getBoundingClientRect()
        if (!r) return
        const clamp = (v: number): number => Math.max(-1, Math.min(1, v))
        rig.look(clamp(((e.clientX - r.left) / r.width) * 2 - 1), clamp(((e.clientY - r.top) / r.height) * 2 - 1.2))
      }
      window.addEventListener('pointermove', look)
      const blink = window.setInterval(() => rig.blink(), 3400)
      stop = () => {
        clearTimeout(timer)
        clearInterval(blink)
        window.removeEventListener('pointermove', look)
        rig.destroy()
      }
    })
    return () => {
      gone = true
      stop()
    }
  }, [])
  return (
    <div className="wn-art" aria-hidden>
      <canvas ref={canvas} />
    </div>
  )
}

function ReleaseView({ r, latest }: { r: Release; latest: boolean }) {
  const lead = r.groups[0]?.items[0]
  return (
    <section className="wn-release" id={`wn-${r.version}`} data-version={r.version}>
      <header className="wn-release-head">
        <span className="wn-version">v{r.version}</span>
        {latest && <span className="tag volt">{tr("Cea mai nouă")}</span>}
      </header>
      {lead?.title && <h3 className="wn-release-title">{lead.title}</h3>}
      {r.groups.map((g, gi) => {
        const kind = GROUPS[g.name.toLowerCase()]
        const Icon = kind?.icon
        return (
          <div className="wn-group" key={gi}>
            {g.name && (
              <div className={`wn-group-name ${g.name.toLowerCase()}`}>
                {Icon && <Icon size={14} />}
                {kind ? kind.label() : g.name}
              </div>
            )}
            <ul className="wn-items">
              {g.items.map((it, ii) => (
                <li key={ii} className="wn-item">
                  {/* the lead item's title is already the release's headline */}
                  {it.title && it !== lead && <b className="wn-item-title">{it.title}</b>}
                  {it.body && <Markdown text={it.body} />}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

function WhatsNew({ version, onClose }: { version: string; onClose: () => void }) {
  const releases = useMemo(() => parseChangelog(changelog), [])
  const [shown, setShown] = useState(PAGE)
  const [active, setActive] = useState<string | undefined>(releases[0]?.version)
  const body = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const current = releases.find((r) => r.version === version) || releases[0]
  const headline = current?.groups[0]?.items[0]?.title

  useEffect(() => {
    close.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // the rail follows the release being read
  // the rail follows the release being read: the last one whose start has scrolled up to the top
  useEffect(() => {
    const root = body.current
    if (!root) return
    const follow = (): void => {
      const top = root.getBoundingClientRect().top + 60
      let at: string | undefined
      for (const el of root.querySelectorAll<HTMLElement>('.wn-release')) if (el.getBoundingClientRect().top <= top) at = el.dataset.version
      setActive(at ?? releases[0]?.version)
    }
    root.addEventListener('scroll', follow, { passive: true })
    return () => root.removeEventListener('scroll', follow)
  }, [releases])

  const jump = (v: string): void => {
    const at = releases.findIndex((r) => r.version === v)
    if (at >= shown) setShown(at + 1)
    requestAnimationFrame(() => document.getElementById(`wn-${v}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  return (
    <div className="modal-back wn-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wn" role="dialog" aria-modal="true" aria-labelledby="wn-title">
        <div className="wn-hero">
          <svg className="wn-bolt" viewBox="0 0 205 740" aria-hidden>
            <polygon points="52,0 170,0 118,300 205,284 56,740 84,408 0,426" />
          </svg>
          <div className="wn-hero-text">
            <div className="wn-kicker">
              <Bolt size={13} /> {tr("Ce e nou în Jolty")}
            </div>
            <h2 id="wn-title" className="wn-headline">
              {headline || `Jolty ${version}`}
            </h2>
            <div className="wn-meta">
              <span className="wn-version">v{current?.version || version}</span>
            </div>
          </div>
          <HeroJolty />
          <button ref={close} className="wn-close" onClick={onClose} aria-label={tr("Închide")} title={tr("Închide")}>
            <X size={18} />
          </button>
        </div>
        <div className="wn-main">
          <nav className="wn-rail" aria-label={tr("Toate versiunile")}>
            {releases.map((r) => (
              <button key={r.version} className={`wn-rail-item ${active === r.version ? 'on' : ''}`} onClick={() => jump(r.version)}>
                {r.version}
              </button>
            ))}
          </nav>
          <div className="wn-body" ref={body}>
            {releases.slice(0, shown).map((r, i) => (
              <ReleaseView key={r.version} r={r} latest={i === 0} />
            ))}
            <div className="wn-foot">
              {shown < releases.length && (
                <button className="btn" onClick={() => setShown((n) => n + PAGE + 2)}>
                  {tr("Versiuni mai vechi")}
                </button>
              )}
              <button className="btn primary" onClick={onClose}>
                {tr("Gata")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Shows What's new once after an update (the version Jolty last showed it for is kept in settings) and
 * whenever openWhatsNew() asks. A fresh install (no conversations yet) records its version quietly.
 */
export function WhatsNewHost() {
  const [version, setVersion] = useState<string>()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    void Promise.all([api.app.version(), api.app.settings(), api.sessions.list()]).then(([v, s, chats]) => {
      setVersion(v)
      const known = parseChangelog(changelog).some((r) => r.version === v)
      if (s.seenVersion === v || !known) return
      // no version on record and no conversations yet: a fresh install, nothing is new to it
      if (!s.seenVersion && !chats.length) void api.app.saveSettings({ seenVersion: v })
      else setOpen(true)
    })
    const onOpen = (): void => setOpen(true)
    window.addEventListener(EVENT, onOpen)
    return () => window.removeEventListener(EVENT, onOpen)
  }, [])
  if (!open || !version) return null
  return (
    <WhatsNew
      version={version}
      onClose={() => {
        setOpen(false)
        void api.app.saveSettings({ seenVersion: version })
      }}
    />
  )
}
