import { Loader2, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PackItem, PackPart, PersonalKind } from '@shared/skills'
import { api, errMsg, useStore } from '../store'
import { tr } from '@shared/i18n'

export const PART_LABEL = (): Record<PackPart, string> => ({
  skills: tr("Skilluri"),
  commands: tr("Comenzi"),
  instructions: tr("Instrucțiuni"),
  settings: tr("Setări"),
  profiles: tr("Conturi (fără chei)"),
  schedules: tr("Sarcini programate"),
  mcp: tr("Servere MCP")
})
const ORDER: PackPart[] = ['skills', 'commands', 'instructions', 'settings', 'profiles', 'schedules']

const PERSONAL = (): Record<PersonalKind, string> => ({
  email: tr("adrese de e-mail"),
  phone: tr("numere de telefon"),
  bank: tr("IBAN"),
  card: tr("numere de card"),
  'home-path': tr("căi cu numele tău de utilizator"),
  'account-name': tr("numele contului tău de Windows")
})

export const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)

/** Pick what goes into a pack and save it as one file. Keys, tokens and cookies never go in. */
export function PackExport() {
  const { toast } = useStore()
  const [items, setItems] = useState<PackItem[]>()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [author, setAuthor] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.pack
      .items()
      .then(setItems)
      .catch((e) => {
        setItems([])
        toast(errMsg(e), true)
      })
  }, [toast])

  const groups = useMemo(() => ORDER.map((part) => ({ part, rows: (items ?? []).filter((i) => i.part === part) })).filter((g) => g.rows.length), [items])
  const toggle = (keys: string[], on: boolean): void =>
    setPicked((p) => {
      const n = new Set(p)
      keys.forEach((k) => (on ? n.add(k) : n.delete(k)))
      return n
    })
  const size = (items ?? []).filter((i) => picked.has(i.key)).reduce((a, i) => a + i.bytes, 0)
  const labels = PART_LABEL()

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.pack.export({ keys: [...picked], name: name.trim(), author: author.trim() || undefined, note: note.trim() || undefined })
      if (r) {
        toast(tr("Pachet salvat: {n} elemente, {size}.", { n: r.items, size: fmtSize(r.bytes) }))
        if (r.redacted) toast(tr("{n} elemente aveau date personale, înlocuite cu marcaje precum <email> sau <user>.", { n: r.redacted }))
      }
    } catch (e) {
      toast(errMsg(e), true)
    } finally {
      setBusy(false)
    }
  }

  if (!items) return <div className="empty">{tr("Se citește ce poți trimite…")}</div>
  return (
    <div className="pack-form">
      <p className="muted small">{tr("Alege ce vrei să trimiți. Pachetul e un singur fișier .joltypack pe care celălalt îl deschide la Import. Cheile API, tokenurile și cookie-urile nu intră niciodată în el.")}</p>
      {groups.length === 0 && <div className="empty">{tr("Nu e nimic de exportat încă.")}</div>}
      {groups.map(({ part, rows }) => {
        const keys = rows.map((r) => r.key)
        const all = keys.length > 0 && keys.every((k) => picked.has(k))
        return (
          <section key={part} className="pack-group">
            <div className="attn-head">
              <span className="label">{labels[part]}</span>
              <button className="btn ghost small" onClick={() => toggle(keys, !all)}>
                {all ? tr("Deselectează tot") : tr("Selectează tot")}
              </button>
            </div>
            {rows.map((i) => (
              <div key={i.key}>
                <label className="pack-row">
                  <input type="checkbox" checked={picked.has(i.key)} onChange={(e) => toggle([i.key], e.target.checked)} />
                  <span className="ellipsis">{i.label}</span>
                  {i.detail && <span className="faint small ellipsis">{i.detail}</span>}
                  <span className="faint small pack-size">{fmtSize(i.bytes)}</span>
                </label>
                {i.personal?.length ? (
                  <div className="pack-note small">{tr("Date personale înlocuite la export: {kinds}.", { kinds: i.personal.map((k) => PERSONAL()[k]).join(", ") })}</div>
                ) : null}
              </div>
            ))}
          </section>
        )
      })}
      <div className="field">
        <label>{tr("Numele pachetului")}</label>
        <input className="input" value={name} maxLength={80} placeholder={tr("Setup-ul meu Jolty")} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>{tr("Autor (opțional)")}</label>
        <input className="input" value={author} maxLength={80} onChange={(e) => setAuthor(e.target.value)} />
      </div>
      <div className="field">
        <label>{tr("Notă pentru cel care primește (opțional)")}</label>
        <textarea className="textarea" rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="row">
        <span className="faint small">{tr("{n} selectate, {size}", { n: picked.size, size: fmtSize(size) })}</span>
        <div className="spacer" />
        <button className="btn primary" disabled={busy || picked.size === 0 || !name.trim()} onClick={() => void run()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} {tr("Exportă pachetul")}
        </button>
      </div>
    </div>
  )
}
