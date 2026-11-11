import { File as FileIcon, Image as ImageIcon, Link as LinkIcon, Music, Search, Video, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Library, LibraryImage } from '@shared/library'
import { tr } from '@shared/i18n'
import { api, useStore } from '../store'
import './library.css'

type Filter = 'images' | 'video' | 'links' | 'files' | 'audio'

const FILTERS: { id: Filter; label: () => string; icon: typeof FileIcon }[] = [
  { id: 'images', label: () => tr("Imagini"), icon: ImageIcon },
  { id: 'video', label: () => tr("Video"), icon: Video },
  { id: 'links', label: () => tr("Linkuri"), icon: LinkIcon },
  { id: 'files', label: () => tr("Fișiere"), icon: FileIcon },
  { id: 'audio', label: () => tr("Sunet"), icon: Music }
]

/** A picture of the grid: fetched small, and only once it is on screen (hundreds of pictures never load at once). */
function Thumb({ img, onOpen }: { img: LibraryImage; onOpen: () => void }) {
  const box = useRef<HTMLButtonElement>(null)
  const [src, setSrc] = useState<string | null>()
  useEffect(() => {
    const el = box.current
    if (!el) return
    let gone = false
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return
        io.disconnect()
        void api.library.image(img.sessionId, img.itemId, img.index, true).then((v) => !gone && setSrc(v), () => !gone && setSrc(null))
      },
      { rootMargin: '300px' }
    )
    io.observe(el)
    return () => {
      gone = true
      io.disconnect()
    }
  }, [img.sessionId, img.itemId, img.index])
  return (
    <button ref={box} className={`lib-thumb ${src ? 'ready' : ''}`} onClick={onOpen} title={img.name} aria-label={img.name}>
      {src && <img src={src} alt="" draggable={false} decoding="async" />}
    </button>
  )
}

function Lightbox({ img, onClose }: { img: LibraryImage; onClose: () => void }) {
  const open = useStore((s) => s.openSession)
  const [src, setSrc] = useState<string | null>()
  useEffect(() => {
    void api.library.image(img.sessionId, img.itemId, img.index).then(setSrc, () => setSrc(null))
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [img, onClose])
  return createPortal(
    <div className="lib-lightbox" role="dialog" aria-label={img.name} onClick={onClose}>
      <div className="lib-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="ellipsis">{img.name}</span>
        <button
          className="btn small"
          onClick={() => {
            onClose()
            void open(img.sessionId)
          }}
        >
          {tr("Deschide conversația")}
        </button>
        <button className="icon-btn" onClick={onClose} aria-label={tr("Închide")}>
          <X size={16} />
        </button>
      </div>
      {src ? <img src={src} alt={img.name} onClick={(e) => e.stopPropagation()} /> : <div className="lib-lightbox-wait">{src === null ? '' : tr("Se încarcă…")}</div>}
    </div>,
    document.body
  )
}

function Row({ icon, name, meta, title, onOpen, onChat }: { icon: ReactNode; name: string; meta: string; title: string; onOpen: () => void; onChat: () => void }) {
  return (
    <div className="lib-row" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <span className="lib-row-icon">{icon}</span>
      <span className="lib-row-text">
        <span className="ellipsis lib-row-name">{name}</span>
        <span className="ellipsis lib-row-meta">{meta}</span>
      </span>
      <button
        className="lib-row-chat ellipsis"
        title={tr("Deschide conversația")}
        onClick={(e) => {
          e.stopPropagation()
          onChat()
        }}
      >
        {title}
      </button>
    </div>
  )
}

/** The Library: what any conversation holds, by kind, the way a chat app lists a conversation's media. */
export function LibraryPage() {
  const open = useStore((s) => s.openSession)
  const [lib, setLib] = useState<Library>()
  const [filter, setFilter] = useState<Filter>()
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState<LibraryImage>()

  useEffect(() => {
    let gone = false
    const load = (): void => void api.library.list().then((l) => !gone && setLib(l), () => !gone && setLib({ images: [], files: [], links: [] }))
    load()
    // a conversation that just got a picture or a link: read again when the PC says something changed
    window.addEventListener('jolty:resync', load)
    return () => {
      gone = true
      window.removeEventListener('jolty:resync', load)
    }
  }, [])

  const q = query.trim().toLowerCase()
  const has = (...t: string[]): boolean => !q || t.some((x) => x.toLowerCase().includes(q))
  const lists = useMemo(() => {
    if (!lib) return undefined
    return {
      images: lib.images.filter((i) => has(i.name, i.title)),
      video: lib.files.filter((f) => f.kind === 'video' && has(f.name, f.title)),
      links: lib.links.filter((l) => has(l.url, l.title)),
      files: lib.files.filter((f) => f.kind === 'file' && has(f.name, f.title)),
      audio: lib.files.filter((f) => f.kind === 'audio' && has(f.name, f.title))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, q])
  const totals = lib && { images: lib.images.length, video: lib.files.filter((f) => f.kind === 'video').length, links: lib.links.length, files: lib.files.filter((f) => f.kind === 'file').length, audio: lib.files.filter((f) => f.kind === 'audio').length }

  if (!lib || !lists || !totals) return <div className="page" />
  // the first kind that has something, until one is picked
  const current: Filter = filter ?? FILTERS.find((f) => totals[f.id] > 0)?.id ?? 'images'
  const rows = lists[current]

  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="page-title">{tr("Bibliotecă")}</h1>
        <div className="lib-bar">
          <div className="lib-chips" role="tablist">
            {FILTERS.map((f) => (
              <button key={f.id} role="tab" aria-selected={current === f.id} className={`lib-chip ${current === f.id ? 'on' : ''}`} disabled={totals[f.id] === 0} onClick={() => setFilter(f.id)}>
                <f.icon size={14} strokeWidth={1.8} />
                {f.label()}
                <span className="count">{totals[f.id]}</span>
              </button>
            ))}
          </div>
          <label className="lib-search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr("Caută în bibliotecă")} aria-label={tr("Caută în bibliotecă")} />
          </label>
        </div>

        {rows.length === 0 && <p className="lib-empty">{tr("Nimic aici încă. Ce atașezi sau lipești în conversații apare în bibliotecă.")}</p>}

        {current === 'images' && (
          <div className="lib-grid" key={q}>
            {lists.images.map((img) => (
              <Thumb key={`${img.sessionId}:${img.itemId}:${img.index}`} img={img} onOpen={() => setShown(img)} />
            ))}
          </div>
        )}
        {current === 'links' && (
          <div className="lib-list">
            {lists.links.map((l) => (
              <Row key={l.url} icon={<LinkIcon size={16} />} name={l.host} meta={l.url} title={l.title} onOpen={() => void api.app.openLink(l.url)} onChat={() => void open(l.sessionId)} />
            ))}
          </div>
        )}
        {(current === 'files' || current === 'video' || current === 'audio') && (
          <div className="lib-list">
            {(current === 'files' ? lists.files : current === 'video' ? lists.video : lists.audio).map((f, i) => (
              <Row key={`${f.sessionId}:${f.itemId}:${i}`} icon={current === 'video' ? <Video size={16} /> : current === 'audio' ? <Music size={16} /> : <FileIcon size={16} />} name={f.name} meta={f.mime} title={f.title} onOpen={() => void open(f.sessionId)} onChat={() => void open(f.sessionId)} />
            ))}
          </div>
        )}
      </div>
      {shown && <Lightbox img={shown} onClose={() => setShown(undefined)} />}
    </div>
  )
}
