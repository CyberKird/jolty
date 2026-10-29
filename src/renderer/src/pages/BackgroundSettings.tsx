import { Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BackgroundState } from '@shared/types'
import { DEFAULT_QUICK_KEY, hotkeyFromEvent } from '@shared/background'
import { tr } from '@shared/i18n'
import { api, errMsg } from '../store'

/** Tray and background mode, start with Windows, and the quick entry shortcut (main/background.ts, main/quick.ts). */
export function BackgroundSettings() {
  const [st, setSt] = useState<BackgroundState>()
  const [error, setError] = useState('')
  const [recording, setRecording] = useState(false)
  useEffect(() => void api.background.state().then(setSt), [])
  if (!st) return null

  const save = async (patch: Parameters<typeof api.app.saveSettings>[0]): Promise<void> => {
    await api.app.saveSettings(patch)
    setSt(await api.background.state())
  }
  const setKey = async (key: string): Promise<void> => {
    setError('')
    try {
      setSt(await api.background.setQuickKey(key))
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <Zap size={16} color="var(--volt)" />
        <b>{tr("Fundal și intrare rapidă")}</b>
      </div>
      <label className="row" style={{ marginBottom: 12, cursor: 'pointer', gap: 8 }}>
        <input type="checkbox" checked={st.keepInBackground} onChange={(e) => void save({ keepInBackground: e.target.checked })} />
        <span>
          <b>{tr("Rămâne pornit în fundal când închizi fereastra")}</b>
          <span className="muted small" style={{ display: 'block' }}>
            {tr("Fereastra se ascunde în bara de sistem, iar conversațiile, sarcinile programate și sesiunile paralele merg mai departe. Ieșire din meniul iconiței îl închide de tot.")}
          </span>
        </span>
      </label>
      <label className="row" style={{ marginBottom: 12, cursor: st.canStartWithWindows ? 'pointer' : 'default', gap: 8, opacity: st.canStartWithWindows ? 1 : 0.5 }}>
        <input type="checkbox" disabled={!st.canStartWithWindows} checked={st.startWithWindows} onChange={(e) => void save({ startWithWindows: e.target.checked })} />
        <span>
          <b>{tr("Pornește odată cu Windows")}</b>
          <span className="muted small" style={{ display: 'block' }}>
            {st.canStartWithWindows ? tr("Jolty pornește ascuns în bara de sistem, gata pentru sarcinile programate și intrarea rapidă.") : tr("Doar în aplicația instalată.")}
          </span>
        </span>
      </label>
      <div className="field" style={{ marginBottom: 12 }}>
        <label>{tr("Scurtătura intrării rapide")}</label>
        <p className="muted small" style={{ marginTop: 0 }}>
          {tr("Deschide oriunde ai fi o casetă mică: scrii sau dictezi, Enter pornește o conversație nouă, Esc o închide.")}
        </p>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input mono"
            readOnly
            style={{ flex: 1 }}
            value={recording ? tr("Apasă combinația…") : st.quickKey || tr("Oprită")}
            onFocus={() => setRecording(true)}
            onBlur={() => setRecording(false)}
            onKeyDown={(e) => {
              if (e.key === 'Tab') return
              e.preventDefault()
              if (e.key === 'Escape' && !e.ctrlKey && !e.altKey) return e.currentTarget.blur()
              const key = hotkeyFromEvent(e)
              if (!key) return
              e.currentTarget.blur()
              void setKey(key)
            }}
          />
          {st.quickKey !== DEFAULT_QUICK_KEY && (
            <button className="btn small" onClick={() => void setKey(DEFAULT_QUICK_KEY)}>
              {tr("Implicit")}
            </button>
          )}
          {st.quickKey && (
            <button className="btn ghost small" onClick={() => void setKey('')}>
              {tr("Oprește")}
            </button>
          )}
        </div>
        {(error || st.quickKeyBusy) && (
          <p className="small" role="alert" style={{ color: 'var(--critical)', margin: '6px 0 0' }}>
            {error || tr("{key} e folosită deja de alt program. Alege altă combinație.", { key: st.quickKey })}
          </p>
        )}
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{tr("Enter în intrarea rapidă")}</label>
        <select className="select" value={st.quickOpens} onChange={(e) => void save({ quickOpens: e.target.value as BackgroundState['quickOpens'] })}>
          <option value="window">{tr("Deschide conversația în fereastra Jolty")}</option>
          <option value="background">{tr("O pornește în fundal și anunță printr-o notificare")}</option>
        </select>
      </div>
    </div>
  )
}
