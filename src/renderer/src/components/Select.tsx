import { Check, ChevronDown } from 'lucide-react'
import { Children, isValidElement, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { usePopover } from './ModelPicker'

interface Opt {
  value: string
  label: ReactNode
  disabled?: boolean
  group?: string
}

/** Reads <option> and <optgroup> children the way a native select does. */
function options(children: ReactNode, group?: string): Opt[] {
  const out: Opt[] = []
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return
    const el = c as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean; label?: string }>
    if (el.type === 'optgroup') out.push(...options(el.props.children, el.props.label))
    else if (el.type === 'option') {
      const text = el.props.children
      out.push({ value: el.props.value !== undefined ? String(el.props.value) : typeof text === 'string' ? text : '', label: text, disabled: el.props.disabled, group })
    } else if (el.props.children) out.push(...options(el.props.children, group))
  })
  return out
}

/**
 * The drop-down of the interface: the same props as a native <select>, but the list is drawn by Jolty (the system's one ignores the
 * theme: white on white in Glass, blue highlight). It opens in the same glass pane as the other menus and takes the arrow keys.
 */
export function Select(p: {
  value: string
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => unknown
  children: ReactNode
  className?: string
  style?: CSSProperties
  disabled?: boolean
  title?: string
  id?: string
  'aria-label'?: string
}) {
  const { open, setOpen, ref, shown, state } = usePopover()
  const list = options(p.children)
  const current = list.find((o) => o.value === p.value) ?? list[0]
  const btn = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<CSSProperties>({})

  const show = (): void => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    const below = innerHeight - r.bottom
    const up = below < 240 && r.top > below
    const room = Math.max(120, (up ? r.top : below) - 14)
    setPos({
      position: 'fixed',
      insetInlineStart: 'auto',
      left: Math.min(r.left, innerWidth - Math.max(r.width, 200) - 8),
      width: Math.max(r.width, 200),
      maxHeight: Math.min(320, room),
      ...(up ? { bottom: innerHeight - r.top + 6, top: 'auto', transformOrigin: 'bottom left' } : { top: r.bottom + 6, bottom: 'auto', transformOrigin: 'top left' })
    })
    setOpen(true)
  }
  // a fixed list does not follow a page that scrolls under it
  useEffect(() => {
    if (!open) return
    const close = (e: Event): void => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      setOpen(false)
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, ref, setOpen])

  const pick = (o: Opt): void => {
    setOpen(false)
    btn.current?.focus()
    if (o.value !== p.value) p.onChange?.({ target: { value: o.value }, currentTarget: { value: o.value } } as unknown as ChangeEvent<HTMLSelectElement>)
  }

  let lastGroup: string | undefined
  return (
    <div ref={ref} className="sel" style={p.style && p.style.width ? { width: p.style.width, marginLeft: p.style.marginLeft } : undefined}>
      <button
        ref={btn}
        type="button"
        id={p.id}
        className={`${p.className ?? 'sel-plain'} sel-btn`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={p['aria-label']}
        title={p.title}
        disabled={p.disabled}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <span className="sel-value">{current?.label}</span>
        <ChevronDown size={14} className="sel-arrow" aria-hidden />
      </button>
      {shown && (
        <div className="picker-pop sel-pop" role="listbox" data-state={state} style={pos}>
          <div className="picker-list">
            {list.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? <div className="sel-group">{o.group}</div> : null
              lastGroup = o.group
              const on = o.value === current?.value
              return (
                <div key={`${o.value}-${i}`}>
                  {head}
                  <button type="button" role="option" data-opt aria-selected={on} aria-checked={on} className={`picker-opt ${on ? 'on' : ''}`} disabled={o.disabled} onClick={() => pick(o)}>
                    <span className="sel-opt-label">{o.label}</span>
                    {on && <Check size={14} aria-hidden />}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
