import { ArrowRightLeft, FolderOpen, Loader2, PlayCircle, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ExternalSession } from '@shared/types'
import { ProfileDot } from '../components/Chat'
import { api, basename, ENGINE_LABEL, errMsg, timeAgo, useStore } from '../store'

function CodexImporter({ profileId }: { profileId: string }) {
  const { toast } = useStore()
  const [items, setItems] = useState<{ itemType: string; description: string; cwd: string | null }[]>()
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const detect = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.codexImport.detect(profileId)
      setItems(r.items)
      setChosen(new Set(r.items.map((i) => i.itemType)))
    } catch (err) {
      toast(errMsg(err), true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <ArrowRightLeft size={16} color="var(--volt)" />
        <b>Aduce în Codex ce ai configurat în Claude Code</b>
        <div className="spacer" />
        <button className="btn small" disabled={busy} onClick={() => void detect()}>
          {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={14} />} Caută
        </button>
      </div>
      <div className="muted small" style={{ marginBottom: 10 }}>
        Folosește importul oficial din Codex: instrucțiuni (CLAUDE.md), skills, servere MCP, subagenți, comenzi, hooks și sesiuni.
      </div>
      {items && items.length === 0 && <div className="faint small">Nu am găsit nimic nou de importat.</div>}
      {items?.map((i, k) => (
        <label key={k} className="row small" style={{ padding: '5px 0', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={chosen.has(i.itemType)}
            onChange={(e) => {
              const next = new Set(chosen)
              if (e.target.checked) next.add(i.itemType)
              else next.delete(i.itemType)
              setChosen(next)
            }}
          />
          <span className="tag volt">{i.itemType}</span>
          <span className="ellipsis">{i.description}</span>
        </label>
      ))}
      {items && items.length > 0 && (
        <button
          className="btn primary small"
          style={{ marginTop: 10 }}
          disabled={busy || !chosen.size}
          onClick={async () => {
            setBusy(true)
            try {
              await api.codexImport.run(profileId, undefined, [...chosen])
              toast('Import terminat')
              setItems(undefined)
            } catch (err) {
              toast(errMsg(err), true)
            } finally {
              setBusy(false)
            }
          }}
        >
          Importă selecția
        </button>
      )}
    </div>
  )
}

export function ImportPage() {
  const profiles = useStore((s) => s.profiles)
  const { openSession, loadSessions, toast } = useStore()
  const [profileId, setProfileId] = useState<string>()
  const [list, setList] = useState<ExternalSession[]>()
  const [loading, setLoading] = useState(false)
  const profile = profiles.find((p) => p.id === profileId)

  useEffect(() => {
    if (!profileId && profiles.length) setProfileId(profiles[0].id)
  }, [profiles, profileId])

  const load = async (): Promise<void> => {
    if (!profileId) return
    setLoading(true)
    setList(undefined)
    try {
      setList(await api.sessions.external(profileId))
    } catch (err) {
      toast(errMsg(err), true)
      setList([])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  const groups = useMemo(() => {
    const m = new Map<string, ExternalSession[]>()
    for (const s of list || []) m.set(s.cwd || '?', [...(m.get(s.cwd || '?') || []), s])
    return [...m.entries()]
  }, [list])

  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="page-title">Importă sesiuni</h1>
        <p className="lead">
          Jolty folosește aceleași fișiere ca aplicațiile oficiale, așa că tot ce ai în Claude Code pe PC (CLAUDE.md, skills, servere MCP, subagenți, comenzi, setări) funcționează direct. Aici deschizi orice conversație existentă și o continui din Jolty.
        </p>
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="pill-select">
            <ProfileDot profile={profile} />
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles
                .filter((p) => p.auth === 'subscription' || p.engine === 'codex' || p.isDefaultDir)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>
          <button className="btn small" onClick={() => void load()}>
            <RefreshCw size={14} /> Reîncarcă
          </button>
          <span className="faint small">{list ? `${list.length} sesiuni ${profile ? ENGINE_LABEL[profile.engine] : ''} încă neimportate` : ''}</span>
        </div>
        {loading && (
          <div className="empty">
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        )}
        {list && list.length === 0 && <div className="card empty">Nu am găsit sesiuni noi pentru acest profil.</div>}
        {groups.map(([cwd, sessions]) => (
          <div className="card" key={cwd} style={{ marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <FolderOpen size={15} color="var(--grey-2)" />
              <b>{basename(cwd)}</b>
              <span className="faint small ellipsis">{cwd}</span>
            </div>
            <table className="table">
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.engineSessionId}>
                    <td className="ellipsis" style={{ maxWidth: 560 }}>
                      {s.title}
                    </td>
                    <td className="faint small" style={{ width: 70 }}>
                      {timeAgo(s.updatedAt)}
                    </td>
                    <td style={{ width: 150, textAlign: 'right' }}>
                      <button
                        className="btn small"
                        onClick={async () => {
                          try {
                            const meta = await api.sessions.start({
                              profileId: s.profileId,
                              cwd: s.cwd || cwd,
                              permissionMode: 'ask',
                              resumeEngineSessionId: s.engineSessionId,
                              title: s.title.slice(0, 60)
                            })
                            await loadSessions()
                            await openSession(meta.id)
                          } catch (err) {
                            toast(errMsg(err), true)
                          }
                        }}
                      >
                        <PlayCircle size={14} /> Continuă aici
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {profile?.engine === 'codex' && <CodexImporter profileId={profile.id} />}
      </div>
    </div>
  )
}
