import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { SystemCheck } from '@shared/types'
import { api, errMsg, useStore } from '../store'

export function SystemPage() {
  const { toast } = useStore()
  const [checks, setChecks] = useState<SystemCheck[]>()
  const load = useCallback(async () => {
    setChecks(undefined)
    setChecks(await api.system.check())
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const bad = checks?.filter((c) => !c.ok && !c.optional).length || 0
  return (
    <div className="page">
      <div className="page-inner narrow">
        <div className="row">
          <h1 className="page-title">Verificare sistem</h1>
          <div className="spacer" />
          <button className="btn small" onClick={() => void load()}>
            <RefreshCw size={14} /> Verifică din nou
          </button>
        </div>
        <p className="lead">
          Jolty vine cu Claude Code și Codex incluse. Aici vezi dacă PC-ul are tot ce le mai trebuie și instalezi ce lipsește cu un clic.
        </p>
        <div className="panel">
          {!checks && (
            <div className="empty">
              <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
          )}
          {checks && (
            <div className="row" style={{ marginBottom: 6 }}>
              {bad === 0 ? <span className="tag good">Totul e pregătit</span> : <span className="tag warn">{bad} lucruri de rezolvat</span>}
            </div>
          )}
          {checks?.map((c) => (
            <div className="check-row" key={c.id}>
              <div>{c.ok ? <CheckCircle2 size={20} strokeWidth={1.5} color="var(--good)" /> : c.optional ? <AlertTriangle size={19} strokeWidth={1.5} color="var(--grey-2)" /> : <XCircle size={20} strokeWidth={1.5} color="var(--warning)" />}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 550 }}>
                  {c.label}
                </div>
                <div className="muted small" style={{ wordBreak: 'break-all' }}>
                  {c.detail}
                </div>
              </div>
              {c.fixLabel && (
                <button
                  className="btn small"
                  onClick={async () => {
                    try {
                      await api.system.fix(c.id)
                      toast('Pornit. Apasă „Verifică din nou” după ce termină.')
                    } catch (err) {
                      toast(errMsg(err), true)
                    }
                  }}
                >
                  {c.fixLabel}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
