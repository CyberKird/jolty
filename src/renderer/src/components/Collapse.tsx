import type { ReactNode } from 'react'
import { usePresence } from '../usePresence'

/** Height-animated block (grid 0fr/1fr, no measuring) that stays mounted while it closes. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const { shown, state } = usePresence(open)
  if (!shown) return null
  return (
    <div className="collapse" data-state={state}>
      <div className="collapse-in">{children}</div>
    </div>
  )
}
