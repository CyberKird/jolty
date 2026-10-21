import { EyeOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { tr } from '@shared/i18n'
import { api } from '../store'
import { showMenu } from '../components/ContextMenu'
import { Brain } from './brain'
import './mascot.css'

const EVENT = 'jolty:mascot'
/** css px per model unit: the 132-unit figure stands about 80 px tall */
const PX = 0.6

/** Shows or hides Jolty everywhere at once (Settings, his own right-click menu). */
export async function setMascot(on: boolean): Promise<void> {
  await api.app.saveSettings({ mascot: on })
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }))
}

function Body() {
  const ref = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let gone = false
    let stop = (): void => undefined
    // three.js loads with him, not with the app
    void import('./Rig3D').then(({ Rig3D, VIEW }) => {
      if (gone || !ref.current || !canvas.current) return
      Object.assign(canvas.current.style, { left: `${30 + VIEW.left * PX}px`, top: `${132 * PX - VIEW.top * PX}px` })
      const body = new Rig3D(canvas.current, PX)
      const brain = new Brain(ref.current, body, (e) => showMenu(e, [{ label: tr("Ascunde mascota"), icon: EyeOff, run: () => void setMascot(false) }]))
      stop = () => {
        brain.destroy()
        body.destroy()
      }
    })
    return () => {
      gone = true
      stop()
    }
  }, [])
  return (
    <div ref={ref} className="mascot" data-pose="dash" data-eyes="open">
      <div className="mascot-bubble" />
      <canvas ref={canvas} className="m-canvas" />
      <div className="m-hit" />
    </div>
  )
}

export function Mascot() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    void api.app.settings().then((s) => setOn(s.mascot !== false))
    const onToggle = (e: Event): void => setOn(Boolean((e as CustomEvent<boolean>).detail))
    window.addEventListener(EVENT, onToggle)
    return () => window.removeEventListener(EVENT, onToggle)
  }, [])
  // the end of the chat keeps room for him, so he never stands over the last lines (mascot.css)
  useEffect(() => void document.documentElement.classList.toggle('has-mascot', on), [on])
  return on ? <Body /> : null
}
