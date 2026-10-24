import { FolderOpen, Link2, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { SkillHome, SkillInfo, SkillProblem, SkillStatus } from '@shared/skills'
import { api, errMsg, useStore } from '../store'
import { tr } from '@shared/i18n'

/** The backends answer 'not-implemented' until they are in; anything else is shown as it came. */
export const unavailable = (e: unknown): boolean => /not-implemented/.test(errMsg(e))
const CODES = (): Record<string, string> => ({
  'bad-source': tr("Sursa nu e validă: folosește o adresă HTTPS de depozit."),
  'managed-by-plugin': tr("Skillul vine dintr-un plugin și se actualizează odată cu pluginul."),
  'skill-not-found': tr("Skillul nu mai există."),
  'no-source': tr("Skillul nu are o sursă. Setează-i una mai întâi."),
  'no-folder': tr("Folderul skillului nu mai există."),
  'has-local-changes': tr("Depozitul skillului are modificări necomise. Comite-le sau pune-le deoparte, apoi actualizează."),
  'no-skill-md-at-source': tr("La sursă nu există SKILL.md pe calea aceasta."),
  'too-big': tr("Skillul de la sursă e prea mare."),
  busy: tr("Se lucrează deja la acest skill.")
})
export const skillError = (e: unknown): string => {
  if (unavailable(e)) return tr("Indisponibil momentan. Încearcă din nou puțin mai târziu.")
  const m = errMsg(e)
  const code = Object.keys(CODES()).find((c) => m.includes(c))
  return code ? CODES()[code] : m
}

export const STATUS: Record<SkillStatus, { label: string; cls: string; hint: string }> = {
  ok: { label: tr("La zi"), cls: 'good', hint: tr("Se potrivește cu sursa lui sau nu are nimic de verificat.") },
  outdated: { label: tr("De actualizat"), cls: 'volt', hint: tr("Sursa are o versiune mai nouă.") },
  modified: { label: tr("Modificat"), cls: 'warn', hint: tr("A fost schimbat pe acest PC după instalare.") },
  unknown: { label: tr("Neverificat"), cls: '', hint: tr("Verificarea nu a putut rula: nu are sursă, nu e internet sau depozitul e privat.") },
  broken: { label: tr("Stricat"), cls: 'bad', hint: tr("Are o problemă care îl împiedică să se încarce.") }
}

export const HOME: Record<SkillHome, string> = { claude: 'Claude', codex: 'Codex', agents: 'Agents' }

/** What each problem means and what to do about it, in plain words. */
export const PROBLEM: Record<SkillProblem, { label: string; fix: string }> = {
  'no-skill-md': { label: tr("Lipsește SKILL.md"), fix: tr("Fără acest fișier modelele nu pot încărca skillul. Adaugă-l sau șterge folderul dacă nu-l mai folosești.") },
  'no-name': { label: tr("Fără nume"), fix: tr("Antetul din SKILL.md nu are câmpul name. Adaugă-l, de obicei la fel ca numele folderului.") },
  'no-description': { label: tr("Fără descriere"), fix: tr("Fără câmpul description, modelul nu știe când să folosească skillul. Scrie într-o frază ce face și când e de folosit.") },
  'bad-frontmatter': { label: tr("Antet ilizibil"), fix: tr("Partea dintre liniile --- de la începutul SKILL.md nu se poate citi. Verifică ghilimelele și spațiile de la începutul rândurilor.") },
  'dead-link': { label: tr("Scurtătură spre nicăieri"), fix: tr("Folderul trimite spre un loc care nu mai există. Reinstalează pluginul care l-a pus acolo sau șterge scurtătura.") },
  'duplicate-name': { label: tr("Nume folosit de două ori"), fix: tr("Alt skill are același nume, deci modelul poate încărca altul decât cel la care te aștepți. Redenumește unul dintre ele.") },
  'name-differs-from-folder': { label: tr("Numele diferă de folder"), fix: tr("Numele din SKILL.md nu e același cu al folderului. Unele aplicații îl caută după folder; pune-le la fel.") },
  'too-big': { label: tr("Prea mare"), fix: tr("Folderul are multe fișiere sau fișiere mari și încetinește încărcarea. Mută datele mari în afara lui.") }
}
export const problemText = (p: string): { label: string; fix: string } => PROBLEM[p as SkillProblem] ?? { label: p, fix: tr("O problemă pe care Jolty nu o descrie încă. Deschide folderul și verifică SKILL.md.") }

export function StatusChip({ s }: { s: SkillInfo }) {
  const st = STATUS[s.status] ?? STATUS.unknown
  const hint = s.status === 'outdated' && s.latest ? `${st.hint} ${tr("Versiunea nouă: {latest}", { latest: s.latest })}` : st.hint
  return (
    <span className={`tag ${st.cls}`} title={hint}>
      {st.label}
    </span>
  )
}

export function sourceLabel(s: SkillInfo): { text: string; title?: string } {
  const src = s.source
  if (src.kind === 'git') return { text: 'Git', title: [src.url, src.ref, src.subdir].filter(Boolean).join(' · ') }
  if (src.kind === 'pack') return { text: tr("Pachet"), title: src.author ? `${src.packName} · ${src.author}` : src.packName }
  return { text: tr("Local"), title: tr("Făcut sau copiat pe acest PC, fără o sursă de unde să se actualizeze") }
}

/** An https address of a repository, without a user name or password in it. */
export function gitUrlError(url: string): string | undefined {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return tr("Pune adresa HTTPS a depozitului, de forma https://github.com/cont/depozit.")
  }
  if (u.protocol !== 'https:' || u.pathname.split('/').filter(Boolean).length < 2) return tr("Pune adresa HTTPS a depozitului, de forma https://github.com/cont/depozit.")
  if (u.username || u.password) return tr("Adresa nu poate conține un nume de utilizator sau o parolă.")
  return undefined
}
export const refError = (ref: string): string | undefined =>
  !ref || (/^[A-Za-z0-9][\w./-]{0,99}$/.test(ref) && !ref.includes('..')) ? undefined : tr("Un branch, un tag sau un commit, fără spații.")

function SourceModal({ s, onClose, onSaved }: { s: SkillInfo; onClose: () => void; onSaved: (s: SkillInfo) => void }) {
  const { toast } = useStore()
  const [url, setUrl] = useState(s.source.kind === 'git' ? s.source.url : '')
  const [ref, setRef] = useState(s.source.kind === 'git' ? s.source.ref || '' : '')
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const urlErr = gitUrlError(url)
  const refErr = refError(ref.trim())
  const save = async (): Promise<void> => {
    setTried(true)
    if (urlErr || refErr) return
    setBusy(true)
    try {
      let next = await api.skills.setSource(s.id, { kind: 'git', url: url.trim(), ref: ref.trim() || undefined })
      // check it right away, so the status says something about the new source
      next = (await api.skills.check([s.id]).catch(() => [next])).find((x) => x.id === s.id) ?? next
      onSaved(next)
      toast(tr("Sursa lui {name} e salvată.", { name: s.name }))
      onClose()
    } catch (e) {
      toast(skillError(e), true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2 className="modal-title">{tr("Sursa skillului")}</h2>
        <p className="muted small" style={{ marginTop: -8 }}>
          {tr("Spune-i lui Jolty din ce depozit Git vine {name}, ca să poată verifica dacă e la zi și să-l actualizeze.", { name: s.name })}
        </p>
        <div className="field">
          <label>{tr("Adresa depozitului")}</label>
          <input className="input mono" autoFocus value={url} placeholder="https://github.com/…" onChange={(e) => setUrl(e.target.value)} aria-invalid={tried && Boolean(urlErr)} />
          {tried && urlErr && <div className="hint field-error">{urlErr}</div>}
        </div>
        <div className="field">
          <label>{tr("Branch, tag sau commit (opțional)")}</label>
          <input className="input mono" value={ref} placeholder="main" onChange={(e) => setRef(e.target.value)} aria-invalid={Boolean(refErr)} />
          {refErr ? <div className="hint field-error">{refErr}</div> : <div className="hint">{tr("Gol: ramura principală a depozitului.")}</div>}
        </div>
        <div className="row">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            {tr("Renunță")}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <Loader2 size={14} className="spin" />} {tr("Salvează sursa")}
          </button>
        </div>
      </form>
    </div>
  )
}

function ConfirmUpdate({ s, onClose, onYes }: { s: SkillInfo; onClose: () => void; onYes: () => void }) {
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="alertdialog" aria-labelledby="confirm-update-title">
        <h2 className="modal-title" id="confirm-update-title">
          {tr("Actualizezi {name}?", { name: s.name })}
        </h2>
        <p>{tr("Skillul a fost schimbat pe acest PC după ce l-ai instalat. Actualizarea îi pune fișierele din sursă, deci editările tale nu mai rămân în skill.")}</p>
        <p className="muted small">{tr("Folderul de acum se păstrează întreg ca backup, ca să poți lua înapoi ce ai schimbat.")}</p>
        <div className="row" style={{ marginTop: 18 }}>
          <div className="spacer" />
          <button className="btn ghost" autoFocus onClick={onClose}>
            {tr("Păstrează editările")}
          </button>
          <button className="btn primary" onClick={onYes}>
            {tr("Actualizează oricum")}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Update, set the source, open the folder: the same buttons on every tab. */
export function SkillActions({ s, onChanged }: { s: SkillInfo; onChanged: (s: SkillInfo) => void }) {
  const { toast } = useStore()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [sourcing, setSourcing] = useState(false)
  const canUpdate = !s.linked && s.source.kind === 'git' && (s.status === 'outdated' || s.status === 'modified')
  const canSource = !s.linked && (s.source.kind === 'local' || s.status === 'unknown')
  const update = async (): Promise<void> => {
    setConfirming(false)
    setBusy(true)
    try {
      onChanged(await api.skills.update(s.id))
      toast(tr("{name} e la zi. Versiunea de dinainte e păstrată ca backup.", { name: s.name }))
    } catch (e) {
      toast(skillError(e), true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="skill-actions">
      {s.linked && (
        <span className="faint small" title={tr("E o oglindă a unui plugin: se actualizează odată cu pluginul.")}>
          {tr("gestionat de plugin")}
        </span>
      )}
      {canUpdate && (
        <button className={`btn small ${s.status === 'outdated' ? 'primary' : ''}`} disabled={busy} onClick={() => (s.status === 'modified' ? setConfirming(true) : void update())}>
          {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} {tr("Actualizează")}
        </button>
      )}
      {canSource && (
        <button className="btn small" onClick={() => setSourcing(true)}>
          <Link2 size={13} /> {tr("Setează sursa")}
        </button>
      )}
      <button
        className="btn ghost small icon"
        title={tr("Deschide folderul")}
        aria-label={tr("Deschide folderul")}
        onClick={() => void api.skills.reveal(s.id).catch((e) => toast(skillError(e), true))}
      >
        <FolderOpen size={14} />
      </button>
      {confirming && <ConfirmUpdate s={s} onClose={() => setConfirming(false)} onYes={() => void update()} />}
      {sourcing && <SourceModal s={s} onClose={() => setSourcing(false)} onSaved={onChanged} />}
    </div>
  )
}
