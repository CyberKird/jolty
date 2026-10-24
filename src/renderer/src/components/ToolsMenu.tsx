// The composer's switches (plan, browser, computer, temporary chat) behind one button: only the ones
// that are on show in the bar, so a quiet composer stays quiet.
import { Check, SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { tr } from '@shared/i18n'
import { usePopover } from './ModelPicker'

export interface Tool {
  id: string
  icon: ReactNode
  label: string
  title: string
  on: boolean
  disabled?: boolean
  onToggle: () => void
}

export function ToolsMenu({ tools, after }: { tools: Tool[]; after?: Record<string, ReactNode> }) {
  const { open, setOpen, ref } = usePopover()
  const active = tools.filter((t) => t.on)
  return (
    <>
      <div className="picker" ref={ref}>
        <button
          className="chrome-toggle"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={tr("Unelte")}
          aria-label={tr("Unelte")}
        >
          <SlidersHorizontal size={14} strokeWidth={1.8} />
        </button>
        {open && (
          <div className="picker-pop small" role="menu" aria-label={tr("Unelte")}>
            <div className="picker-list">
              {tools.map((t) => (
                <button
                  key={t.id}
                  data-opt
                  role="menuitemcheckbox"
                  aria-checked={t.on}
                  disabled={t.disabled}
                  className={`picker-opt ${t.on ? 'on' : ''}`}
                  title={t.title}
                  onClick={() => t.onToggle()}
                >
                  <span className="picker-opt-text">
                    <span className="picker-opt-name tool-name">{t.icon}{t.label}</span>
                  </span>
                  {t.on && <Check size={14} />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {active.map((t) => (
        <span key={t.id} className="tool-chip">
          <button className="chrome-toggle on" aria-pressed onClick={t.onToggle} title={t.title}>
            {t.icon}
            {t.label}
          </button>
          {after?.[t.id]}
        </span>
      ))}
    </>
  )
}
