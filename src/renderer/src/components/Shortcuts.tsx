import { X } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { SHORTCUT_GROUPS, keyLabels, shortcutsIn } from '@shared/shortcuts'
import { tr } from '@shared/i18n'
import { useExitClose } from '../usePresence'
import './find.css'

const EVENT = 'jolty:shortcuts'
const MAC = /Mac/i.test(navigator.platform)

/** Opens the keyboard shortcuts sheet from anywhere (Settings). */
export function openShortcuts(): void {
  window.dispatchEvent(new Event(EVENT))
}

function Sheet({ onClose: closeNow }: { onClose: () => void }) {
  const { state, close } = useExitClose(closeNow)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
  return (
    <div className="modal-back keys-back" data-state={state} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal keys" role="dialog" aria-modal="true" aria-labelledby="keys-title">
        <div className="keys-head">
          <h2 id="keys-title" className="modal-title">{tr("Scurtături de tastatură")}</h2>
          <button className="btn ghost small icon" onClick={close} title={tr("Închide")} aria-label={tr("Închide")} autoFocus>
            <X size={15} />
          </button>
        </div>
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.id} className="keys-group">
            <h3>{g.label()}</h3>
            {shortcutsIn(g.id).map((s) => (
              <div key={s.keys.join('+') + s.label()} className="keys-row">
                <span className="keys-label">{s.label()}</span>
                <span className="keys-chips" dir="ltr">
                  {keyLabels(s.keys, MAC).map((k, i) => (
                    <Fragment key={i}>
                      {i > 0 && <span className="keys-plus">+</span>}
                      <kbd>{k}</kbd>
                    </Fragment>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

/** The sheet itself, opened with Ctrl+/ or openShortcuts(); Ctrl+/ again or Esc closes it. */
export function ShortcutsHost() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key !== '/') return
      e.preventDefault()
      setOpen((o) => !o)
    }
    const onOpen = (): void => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(EVENT, onOpen)
    }
  }, [])
  return open ? <Sheet onClose={() => setOpen(false)} /> : null
}
