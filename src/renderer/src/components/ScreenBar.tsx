import { Monitor } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../store'
import { tr } from '@shared/i18n'

/** On the PC, on every page, while a phone is looking at the screen: what is happening and how to end it. */
export function ScreenBar() {
  const [viewers, setViewers] = useState(0)
  useEffect(() => {
    // the phone's own page has no say over the link
    if (document.documentElement.classList.contains('remote')) return
    const load = (): void => void api.remote.status().then((s) => setViewers(s.screen.viewers), () => undefined)
    load()
    return api.remote.onChange(load)
  }, [])
  if (!viewers) return null
  return (
    <div className="power-bar counting screen-bar" role="status" aria-live="polite">
      <Monitor size={14} strokeWidth={2} />
      <span>{tr("Un telefon vede și controlează ecranul acestui PC")}</span>
      <button className="btn small" onClick={() => void api.remote.stopScreen()}>
        {tr("Oprește")}
      </button>
    </div>
  )
}
