import { AlertTriangle, ArrowDown, ArrowUp, CircleCheck, Eye, EyeOff, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { needsAttention, onlyTooBig, type SkillHome, type SkillInfo, type SkillStatus } from '@shared/skills'
import { timeAgo, useStore } from '../store'
import { HOME, problemText, SkillActions, sourceLabel, STATUS, StatusChip } from './SkillActions'
import { tr } from '@shared/i18n'
import { useShallow } from 'zustand/shallow'

type SortKey = 'name' | 'home' | 'source' | 'status' | 'checked'
const STATUS_ORDER: SkillStatus[] = ['broken', 'outdated', 'modified', 'unknown', 'ok']

function sortValue(s: SkillInfo, k: SortKey): string | number {
  if (k === 'name') return s.name.toLowerCase()
  if (k === 'home') return s.home
  if (k === 'source') return s.source.kind
  if (k === 'status') return STATUS_ORDER.indexOf(s.status) * 100 - s.problems.length
  return s.checkedAt ?? 0
}

function Name({ s }: { s: SkillInfo }) {
  return (
    <>
      <div className="skill-name">
        <span className="ellipsis">{s.name}</span>
        {s.problems.length > 0 && (
          <AlertTriangle size={13} className="skill-warn" aria-label={tr("Probleme")}>
            <title>{s.problems.map((p) => problemText(p).label).join('\n')}</title>
          </AlertTriangle>
        )}
      </div>
      {s.description && (
        <div className="faint small ellipsis" title={s.description}>
          {s.description}
        </div>
      )}
    </>
  )
}

/** Every skill: search, filters and sortable columns. */
export function SkillsTable({ list, onChanged }: { list: SkillInfo[]; onChanged: (s: SkillInfo) => void }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<SkillStatus | ''>('')
  const [home, setHome] = useState<SkillHome | ''>('')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'status', desc: false })
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = list.filter(
      (s) => (!status || s.status === status) && (!home || s.home === home) && (!needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle))
    )
    const dir = sort.desc ? -1 : 1
    return out.sort((a, b) => {
      const x = sortValue(a, sort.key)
      const y = sortValue(b, sort.key)
      return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name)
    })
  }, [list, q, status, home, sort])
  const homes = [...new Set(list.map((s) => s.home))]

  const th = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button className="th-sort" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : false })}>
        {label}
        {sort.key === key && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
      </button>
    </th>
  )

  return (
    <>
      <div className="skills-filters">
        <div className="search skills-search">
          <Search size={13} />
          <input placeholder={tr("Caută după nume sau descriere")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tr("Caută skilluri")} />
        </div>
        <label className="pill-select" title={tr("Status")}>
          <select value={status} onChange={(e) => setStatus(e.target.value as SkillStatus | '')} aria-label={tr("Status")}>
            <option value="">{tr("Orice status")}</option>
            {STATUS_ORDER.map((k) => (
              <option key={k} value={k}>
                {STATUS[k].label}
              </option>
            ))}
          </select>
        </label>
        {homes.length > 1 && (
          <label className="pill-select" title={tr("Unde stă")}>
            <select value={home} onChange={(e) => setHome(e.target.value as SkillHome | '')} aria-label={tr("Unde stă")}>
              <option value="">{tr("Toate folderele")}</option>
              {homes.map((h) => (
                <option key={h} value={h}>
                  {HOME[h]}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="faint small skills-count">{tr("{n} din {total}", { n: rows.length, total: list.length })}</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty">{list.length ? tr("Niciun skill nu se potrivește cu filtrele.") : tr("Niciun skill în ~/.claude/skills, ~/.codex/skills sau ~/.agents/skills.")}</div>
      ) : (
        <div className="skills-table-wrap">
          <table className="table skills-table">
            <thead>
              <tr>
                {th('name', tr("Nume"))}
                {th('home', tr("Unde stă"))}
                {th('source', tr("Sursă"))}
                {th('status', tr("Status"))}
                {th('checked', tr("Verificat"))}
                <th aria-label={tr("Acțiuni")} />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const src = sourceLabel(s)
                return (
                  <tr key={s.id}>
                    <td className="skill-cell">
                      <Name s={s} />
                    </td>
                    <td>
                      <span className="tag" title={s.dir}>
                        {HOME[s.home] ?? s.home}
                      </span>
                    </td>
                    <td className="small" title={src.title}>
                      {src.text}
                    </td>
                    <td>
                      <StatusChip s={s} />
                    </td>
                    <td className="faint small">{s.checkedAt ? timeAgo(s.checkedAt) : tr("niciodată")}</td>
                    <td>
                      <SkillActions s={s} onChanged={onChanged} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

type Reason = 'broken' | 'outdated' | 'modified' | 'problems'
const REASON = (): Record<Reason, { title: string; text: string }> => ({
  broken: { title: tr("Stricate"), text: tr("Nu se încarcă deloc până nu repari problema de la fiecare.") },
  outdated: { title: tr("De actualizat"), text: tr("Sursa are o versiune mai nouă. Actualizarea păstrează folderul de acum ca backup.") },
  modified: { title: tr("Modificate pe acest PC"), text: tr("Au fost schimbate după instalare. O actualizare le-ar înlocui editările, așa că Jolty te întreabă înainte.") },
  problems: { title: tr("De reparat"), text: tr("Se încarcă, dar au ceva care le poate încurca pe modele.") }
})

/** Each skill lands in one group, the most urgent reason first. */
export const reasonOf = (s: SkillInfo): Reason => (s.status === 'broken' ? 'broken' : s.status === 'outdated' ? 'outdated' : s.status === 'modified' ? 'modified' : 'problems')

/** Only what needs a look, grouped by why, with what to do. */
export function AttentionList({ list, onChanged }: { list: SkillInfo[]; onChanged: (s: SkillInfo) => void }) {
  const { hiddenSkills, hideSkill } = useStore(useShallow(({ hiddenSkills, hideSkill }) => ({ hiddenSkills, hideSkill })))
  const todo = list.filter((s) => needsAttention(s, hiddenSkills))
  const hidden = list.filter((s) => hiddenSkills.includes(s.id) && onlyTooBig(s))
  const reasons = REASON()
  return (
    <>
      {!todo.length && (
        <div className="empty skills-calm">
          <CircleCheck size={30} strokeWidth={1.4} color="var(--volt)" />
          <b>{tr("Toate skillurile sunt în regulă")}</b>
          <span className="small">{tr("Niciunul nu e stricat, modificat sau rămas în urmă. Verifică acum ca să cauți versiuni noi.")}</span>
        </div>
      )}
      {(Object.keys(reasons) as Reason[]).map((r) => {
        const group = todo.filter((s) => reasonOf(s) === r).sort((a, b) => a.name.localeCompare(b.name))
        if (!group.length) return null
        return (
          <section key={r} className="attn-group">
            <div className="attn-head">
              <span className="label">{reasons[r].title}</span>
              <span className="label">{group.length}</span>
            </div>
            <p className="muted small attn-why">{reasons[r].text}</p>
            <div className="grid">
              {group.map((s) => (
                <div key={s.id} className="card attn-card">
                  <div className="row attn-top">
                    <div className="attn-name">
                      <Name s={s} />
                    </div>
                    <span className="tag" title={s.dir}>
                      {HOME[s.home] ?? s.home}
                    </span>
                    <StatusChip s={s} />
                    <SkillActions s={s} onChanged={onChanged} />
                    {onlyTooBig(s) && (
                      <button className="btn ghost" title={tr("Ascunde alerta: nu mai apare în bara din stânga, o găsești mai jos la Alerte ascunse.")} onClick={() => hideSkill(s.id, true)}>
                        <EyeOff size={14} /> {tr("Ascunde")}
                      </button>
                    )}
                  </div>
                  {s.status === 'outdated' && s.latest && <div className="faint small">{tr("Versiunea nouă: {latest}", { latest: s.latest })}</div>}
                  {s.problems.length > 0 && (
                    <ul className="attn-problems">
                      {s.problems.map((p) => {
                        const t = problemText(p)
                        return (
                          <li key={p}>
                            <b>{t.label}</b>
                            <span className="muted small">{t.fix}</span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>
        )
      })}
      {hidden.length > 0 && (
        <details className="attn-hidden">
          <summary className="label">{tr("Alerte ascunse ({n})", { n: hidden.length })}</summary>
          <ul className="attn-problems">
            {hidden.map((s) => (
              <li key={s.id} className="row">
                <b>{s.name}</b>
                <span className="muted small">{problemText('too-big').label}</span>
                <span className="spacer" />
                <button className="btn ghost" onClick={() => hideSkill(s.id, false)}>
                  <Eye size={14} /> {tr("Arată din nou")}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}
