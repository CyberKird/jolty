import { AlertTriangle, Download, List, Loader2, RefreshCw, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { needsAttention, type SkillInfo } from '@shared/skills'
import { PageTabs, useSavedTab } from '../components/PageTabs'
import { api, useStore } from '../store'
import { PackExport } from './PackExport'
import { PackImport } from './PackImport'
import { skillError } from './SkillActions'
import { AttentionList, SkillsTable } from './SkillsList'
import { tr } from '@shared/i18n'
import { useShallow } from 'zustand/shallow'

const TABS = ['all', 'attention', 'export', 'import'] as const
type Tab = (typeof TABS)[number]

/** Skills: the inventory with update checks, what needs attention, and sharing (export and import packs). */
export function SkillsPage() {
  const { toast, setSkillsAttention } = useStore(useShallow(({ toast, setSkillsAttention }) => ({ toast, setSkillsAttention })))
  const hidden = useStore((s) => s.hiddenSkills)
  const [list, setList] = useState<SkillInfo[]>()
  const [checking, setChecking] = useState(false)
  const [tab, setTab] = useSavedTab<Tab>('jolty.skillsTab', TABS)

  const publish = useCallback(
    (next: SkillInfo[]) => {
      setList(next)
      setSkillsAttention(next.filter((s) => needsAttention(s, useStore.getState().hiddenSkills)).length)
    },
    [setSkillsAttention]
  )
  // hiding or showing an alert changes the badge at once
  useEffect(() => setSkillsAttention((list ?? []).filter((s) => needsAttention(s, hidden)).length), [hidden, list, setSkillsAttention])
  const reload = useCallback(() => api.skills.list().then(publish), [publish])
  useEffect(() => {
    void reload().catch((e) => {
      setList([])
      toast(skillError(e), true)
    })
  }, [reload, toast])

  const changed = (s: SkillInfo): void => publish((list ?? []).map((x) => (x.id === s.id ? s : x)))
  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      publish(await api.skills.check())
    } catch (e) {
      toast(skillError(e), true)
    } finally {
      setChecking(false)
    }
  }

  const attention = useMemo(() => (list ?? []).filter((s) => needsAttention(s, hidden)).length, [list, hidden])
  const tabs = [
    { id: 'all' as const, label: tr("Toate"), icon: List, count: list?.length },
    { id: 'attention' as const, label: tr("Atenție"), icon: AlertTriangle, count: attention },
    { id: 'export' as const, label: tr("Export"), icon: Upload },
    { id: 'import' as const, label: tr("Import"), icon: Download }
  ]
  const lastCheck = Math.max(0, ...(list ?? []).map((s) => s.checkedAt ?? 0))

  return (
    <div className="page">
      <div className="page-inner">
        <div className="row skills-head">
          <h1 className="page-title">{tr("Skilluri")}</h1>
          <div className="spacer" />
          {(tab === 'all' || tab === 'attention') && (
            <>
              {lastCheck > 0 && <span className="faint small">{tr("Ultima verificare: {when}", { when: new Date(lastCheck).toLocaleString() })}</span>}
              <button className="btn" onClick={() => void check()} disabled={checking || !list}>
                {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} {tr("Verifică actualizări")}
              </button>
            </>
          )}
        </div>
        <PageTabs tabs={tabs} tab={tab} onPick={setTab} label={tr("Skilluri")} />
        <div className="skills-body">
          {tab === 'export' && <PackExport />}
          {tab === 'import' && <PackImport onImported={() => void reload().catch(() => undefined)} />}
          {(tab === 'all' || tab === 'attention') &&
            (list ? tab === 'all' ? <SkillsTable list={list} onChanged={changed} /> : <AttentionList list={list} onChanged={changed} /> : <div className="empty">{tr("Se citesc skillurile…")}</div>)}
        </div>
      </div>
    </div>
  )
}
