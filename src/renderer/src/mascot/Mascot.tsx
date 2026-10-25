import { EyeOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { tr } from '@shared/i18n'
import { api } from '../store'
import { showMenu } from '../components/ContextMenu'
import { Brain } from './brain'
import { soundsOn } from './sfx'
import { dim, setSize, type MascotSize } from './size'
import './mascot.css'

const EVENT = 'jolty:mascot'
const SIZE_EVENT = 'jolty:mascot-size'

/** Settings: how big he is (a new body is made at once) */
export async function setMascotSize(size: MascotSize): Promise<void> {
  await api.app.saveSettings({ mascotSize: size })
  window.dispatchEvent(new CustomEvent(SIZE_EVENT, { detail: size }))
}

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
      const { px } = dim
      ref.current.style.setProperty('--mk', String(dim.k))
      Object.assign(canvas.current.style, { left: `${30 * dim.k + VIEW.left * px}px`, top: `${132 * px - VIEW.top * px}px` })
      const body = new Rig3D(canvas.current, px)
      const brain = new Brain(ref.current, body, (e) => showMenu(e, [{ label: tr("Ascunde mascota"), icon: EyeOff, run: () => void setMascot(false) }]))
      if (localStorage.getItem('jolty-mascot-debug')) (window as unknown as { __mascot: Brain['debug'] }).__mascot = brain.debug
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
  // a new size is a new body: the key remounts him
  const [size, setSizeState] = useState(0)
  useEffect(() => {
    void api.app.settings().then((s) => {
      setSize(s.mascotSize)
      setOn(s.mascot !== false)
      soundsOn(s.mascotSounds !== false)
    })
    const onToggle = (e: Event): void => setOn(Boolean((e as CustomEvent<boolean>).detail))
    const onSize = (e: Event): void => {
      setSize((e as CustomEvent<MascotSize>).detail)
      setSizeState((n) => n + 1)
    }
    window.addEventListener(EVENT, onToggle)
    window.addEventListener(SIZE_EVENT, onSize)
    return () => {
      window.removeEventListener(EVENT, onToggle)
      window.removeEventListener(SIZE_EVENT, onSize)
    }
  }, [])
  // the end of the chat keeps room for him, so he never stands over the last lines (mascot.css)
  useEffect(() => void document.documentElement.classList.toggle('has-mascot', on), [on])
  return on ? <Body key={size} /> : null
}
