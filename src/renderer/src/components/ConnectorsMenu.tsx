// The connectors (MCP servers) of one chat on a button of their own: a long list would drown the Tools menu.
// The button shows how many are on; the list scrolls and has one switch for all of them.
import { Check, Plug } from 'lucide-react'
import { tr } from '@shared/i18n'
import { usePopover } from './ModelPicker'

export function ConnectorsMenu({ names, off, onChange }: { names: string[]; off: string[]; onChange: (off: string[]) => void }) {
  const { open, setOpen, ref, shown, state } = usePopover()
  const on = names.filter((n) => !off.includes(n)).length
  const label = tr("Conectori: {on} din {total} pornite", { on: String(on), total: String(names.length) })
  const allOff = on === 0
  return (
    <div className="picker" ref={ref}>
      <button className="chrome-toggle" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={label} aria-label={label}>
        <Plug size={14} strokeWidth={1.8} />
        <span className="connector-count">{on}/{names.length}</span>
      </button>
      {shown && (
        <div className="picker-pop small connectors-pop" data-state={state} role="menu" aria-label={label}>
          <div className="picker-list">
            {names.map((name) => {
              const isOn = !off.includes(name)
              return (
                <button
                  key={name}
                  data-opt
                  role="menuitemcheckbox"
                  aria-checked={isOn}
                  className={`picker-opt ${isOn ? 'on' : ''}`}
                  onClick={() => onChange(isOn ? [...off, name] : off.filter((n) => n !== name))}
                >
                  <span className="picker-opt-text">
                    <span className="picker-opt-name">{name}</span>
                  </span>
                  {isOn && <Check size={14} />}
                </button>
              )
            })}
          </div>
          <button data-opt className="picker-opt connectors-all" role="menuitem" onClick={() => onChange(allOff ? [] : [...names])}>
            <span className="picker-opt-text">
              <span className="picker-opt-name">{allOff ? tr("Pornește toate") : tr("Oprește toate")}</span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
