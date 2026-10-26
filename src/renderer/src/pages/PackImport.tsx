import { Download, FileUp, Loader2, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ImportDecision, ImportPreview, ImportResult, ImportRisk, ImportState } from '@shared/skills'
import { api, errMsg, timeAgo, useStore } from '../store'
import { fmtSize, PART_LABEL } from './PackExport'
import { tr } from '@shared/i18n'

const STATE = (): Record<ImportState, { label: string; cls: string }> => ({
  new: { label: tr("Nou"), cls: 'good' },
  same: { label: tr("Identic"), cls: '' },
  different: { label: tr("Diferit"), cls: 'warn' },
  newer: { label: tr("Mai nou"), cls: 'volt' },
  older: { label: tr("Mai vechi"), cls: 'warn' }
})
const RISK = (): Record<ImportRisk, string> => ({
  'runs-code': tr("Conține cod care rulează"),
  'changes-instructions': tr("Schimbă instrucțiunile modelului"),
  'changes-settings': tr("Schimbă setările"),
  'adds-account': tr("Adaugă un cont")
})
const WARNING = (code: string): string =>
  ({
    'newer-app-version': tr("Pachetul vine dintr-o versiune mai nouă de Jolty. Unele elemente pot lipsi."),
    'unknown-parts': tr("Pachetul are părți pe care această versiune nu le știe; sunt ignorate."),
    'checksum-mismatch': tr("Fișierul a fost schimbat după export sau e stricat. Deschide-l doar dacă ai încredere în cine ți l-a dat."),
    'invalid-items': tr("Unele elemente din pachet nu sunt valide și au fost lăsate deoparte.")
  })[code] ?? code

/** Open a pack, decide per item what happens on a clash, apply, and take it back if needed. */
export function PackImport({ onImported, initial, onClose }: { onImported: () => void; initial?: ImportPreview; onClose?: () => void }) {
  const { toast } = useStore()
  const [preview, setPreview] = useState<ImportPreview | undefined>(initial)
  const [decisions, setDecisions] = useState<Record<string, ImportDecision>>(() => Object.fromEntries((initial?.items ?? []).map((i) => [i.key, i.suggested])))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult>()
  const [over, setOver] = useState(false)

  // a pack that was opened and never applied is dropped when the tab closes
  useEffect(() => () => void (preview && api.pack.discard(preview.previewId).catch(() => undefined)), [preview])

  const show = (p: ImportPreview | null): void => {
    if (!p) return
    setResult(undefined)
    setPreview(p)
    setDecisions(Object.fromEntries(p.items.map((i) => [i.key, i.suggested])))
  }
  const open = async (file?: string): Promise<void> => {
    setBusy(true)
    try {
      show(await api.pack.open(file))
    } catch (e) {
      toast(errMsg(e), true)
    } finally {
      setBusy(false)
    }
  }
  const apply = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    try {
      const r = await api.pack.apply(preview.previewId, decisions)
      setPreview(undefined)
      setResult(r)
      onImported()
    } catch (e) {
      toast(errMsg(e), true)
    } finally {
      setBusy(false)
    }
  }
  const undo = async (): Promise<void> => {
    if (!result) return
    setBusy(true)
    try {
      await api.pack.undo(result.importId)
      setResult(undefined)
      onImported()
      toast(tr("Importul a fost anulat. Ce a fost înlocuit e la loc."))
    } catch (e) {
      toast(errMsg(e), true)
    } finally {
      setBusy(false)
    }
  }

  if (result)
    return (
      <div className="card signal pack-done">
        <b>{tr("Import terminat")}</b>
        <span className="small">{tr("{n} importate, {s} sărite, {c} copiate.", { n: result.imported, s: result.skipped, c: result.copied })}</span>
        {result.failed.length > 0 && (
          <ul className="attn-problems">
            {result.failed.map((f) => (
              <li key={f.key}>
                <b>{f.key}</b>
                <span className="muted small">{f.reason}</span>
              </li>
            ))}
          </ul>
        )}
        <span className="faint small">{tr("Ce a fost înlocuit e păstrat ca backup, poți anula.")}</span>
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => void undo()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Undo2 size={14} />} {tr("Anulează importul")}
          </button>
          <button className="btn ghost" onClick={() => { setResult(undefined); onClose?.() }}>
            {tr("Gata")}
          </button>
        </div>
      </div>
    )

  if (!preview)
    return (
      <div
        className={`pack-drop ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer.files[0]
          if (f) void open(api.files.path(f))
        }}
      >
        <FileUp size={30} strokeWidth={1.4} />
        <b>{tr("Trage aici un fișier .joltypack")}</b>
        <span className="muted small">{tr("Vezi ce conține și alegi pentru fiecare element ce se întâmplă, înainte să se schimbe ceva.")}</span>
        <button className="btn primary" disabled={busy} onClick={() => void open()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {tr("Alege un pachet")}
        </button>
      </div>
    )

  const labels = PART_LABEL()
  const states = STATE()
  const risks = RISK()
  const set = (k: string, d: ImportDecision): void => setDecisions((p) => ({ ...p, [k]: d }))
  const active = Object.values(decisions).filter((d) => d !== 'skip').length
  return (
    <div className="pack-form">
      <div className="card">
        <b>{preview.name}</b>
        <div className="faint small">
          {[preview.author, timeAgo(preview.createdAt), `Jolty ${preview.appVersion}`].filter(Boolean).join(' · ')}
        </div>
        {preview.note && <p className="small">{preview.note}</p>}
      </div>
      {preview.warnings.map((w) => (
        <div key={w} className="pack-warn small">
          {WARNING(w)}
        </div>
      ))}
      <table className="table">
        <thead>
          <tr>
            <th>{tr("Element")}</th>
            <th>{tr("Stare")}</th>
            <th>{tr("Ce se întâmplă")}</th>
          </tr>
        </thead>
        <tbody>
          {preview.items.map((i) => (
            <tr key={i.key}>
              <td className="skill-cell">
                <div className="skill-name">
                  <span className="ellipsis">{i.label}</span>
                </div>
                <div className="faint small ellipsis">
                  {labels[i.part]} · {fmtSize(i.bytes)}
                  {i.existing ? ` · ${tr("aici: {size}, {when}", { size: fmtSize(i.existing.bytes), when: timeAgo(i.existing.modifiedAt) })}` : ''}
                </div>
                {i.risks.map((r) => (
                  <div key={r} className="pack-risk small">
                    {risks[r]}
                  </div>
                ))}
              </td>
              <td>
                <span className={`tag ${states[i.state].cls}`}>{states[i.state].label}</span>
              </td>
              <td>
                <label className="pill-select">
                  <select value={decisions[i.key] ?? 'skip'} onChange={(e) => set(i.key, e.target.value as ImportDecision)} aria-label={i.label}>
                    <option value="skip">{tr("Las ce am")}</option>
                    <option value="overwrite">{i.state === 'new' ? tr("Adaugă") : tr("Înlocuiește (cu backup)")}</option>
                    {i.state !== 'new' && <option value="copy">{tr("Adaugă lângă al meu")}</option>}
                  </select>
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="btn ghost" onClick={() => { setPreview(undefined); onClose?.() }}>
          {tr("Renunță")}
        </button>
        <div className="spacer" />
        <button className="btn primary" disabled={busy || active === 0} onClick={() => void apply()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {tr("Importă {n}", { n: active })}
        </button>
      </div>
    </div>
  )
}
