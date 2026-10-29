import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Doc, Folder, IngestResult } from '../types'

interface Props {
  docs: Doc[]
  folders: Folder[]
  wide: boolean
  onToggleWide: () => void
  selected: Set<number>
  onToggle: (id: number) => void
  onChanged: () => Promise<void>
  onError: (msg: string) => void
  /** A paper to bring into view and open (from the network view or the palette); `n` changes per request. */
  focus?: { id: number; n: number } | null
  /** Work done for the library elsewhere (files dropped on the window), shown like its own. */
  busyLabel?: string | null
  onFindDuplicates: () => void
}

const KIND_LABEL: Record<Doc['kind'], string> = {
  pdf: 'PDF',
  docx: 'Doc',
  text: 'Notes',
  web: 'Web',
  pptx: 'Slides',
  image: 'Scan',
}
const KIND_PLURAL: Record<Doc['kind'], string> = {
  pdf: 'PDFs',
  docx: 'Word files',
  text: 'Notes',
  web: 'Web pages',
  pptx: 'Slides',
  image: 'Scans',
}
const SORTS: { value: string; label: string }[] = [
  { value: 'name:1', label: 'Name A–Z' },
  { value: 'name:-1', label: 'Name Z–A' },
  { value: 'year:-1', label: 'Newest' },
  { value: 'year:1', label: 'Oldest' },
  { value: 'type:1', label: 'Type' },
  { value: 'pages:-1', label: 'Longest' },
]

function byline(d: Doc): string {
  const who = d.authors.length > 2 ? `${d.authors[0]} et al.` : d.authors.join(' & ')
  return [who, d.year].filter(Boolean).join(' · ')
}

function pages(d: Doc): string {
  return d.page_count > 1 ? `${d.page_count} ${d.kind === 'pptx' ? 'slides' : 'pp'}` : ''
}

type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>
type SortKey = 'name' | 'type' | 'year' | 'pages' | 'match'
type Scope = 'all' | 'none' | number // every file, files with no folder, or one folder

/** Close a popover when the user clicks outside it or presses Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, ref, close])
}

/** The folders a document is filed under. Editable: take it out of one, or add it to another. */
function FolderChips({ doc: d, editable, run }: { doc: Doc; editable: boolean; run: Run }) {
  if (!editable && d.folders.length === 0) return null
  return (
    <div className="tags folder-chips">
      {d.folders.map((f) => (
        <span
          key={f.id}
          className={`tag folder-tag${f.state === 'user' ? ' mine' : ''}`}
          title={f.state === 'user' ? 'Added by you' : f.score != null ? `${f.score}% match` : undefined}
        >
          {f.name}
          {f.state !== 'user' && f.score != null && <span className="folder-score">{f.score}%</span>}
          {editable && (
            <button
              className="tag-x"
              title={`Not about ${f.name}: take it out of this folder`}
              aria-label={`Remove ${d.title} from ${f.name}`}
              onClick={() => run('Updating…', () => api.setFolderMember(d.id, f.id, false))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {editable && (
        <input
          className="folder-add"
          list="folder-names"
          placeholder="+ add to folder"
          aria-label={`Add ${d.title} to a folder`}
          onKeyDown={(e) => {
            const value = e.currentTarget.value.trim()
            if (e.key === 'Enter' && value) {
              e.currentTarget.value = ''
              run('Updating…', () => api.addToFolder(d.id, value))
            }
          }}
        />
      )}
    </div>
  )
}

function SimilaritySlider({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="sim">
      <span>Match at least</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        disabled={disabled}
        aria-label="Similarity threshold"
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <b>{value}%</b>
    </label>
  )
}

/** A folder is defined by the subject the user types and how closely a paper must match it. */
function NewFolderForm({ onCreate, onCancel }: { onCreate: (name: string, similarity: number) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [similarity, setSimilarity] = useState(50)
  return (
    <form
      className="lb-card lb-newfolder"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onCreate(name.trim(), similarity)
      }}
    >
      <b>New subject folder</b>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        placeholder="Subject, e.g. Digital finance"
        aria-label="Folder name"
      />
      <SimilaritySlider value={similarity} onChange={setSimilarity} />
      <p className="muted">Papers about this subject at {similarity}% or more are filed here automatically. A paper can sit in several folders.</p>
      <div className="lb-card-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={!name.trim()}>
          Create folder
        </button>
      </div>
    </form>
  )
}

/** The open folder in one line; its threshold, name and deletion behind Edit. */
function FolderBar({ folder, run }: { folder: Folder; run: Run }) {
  const [value, setValue] = useState(folder.similarity)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const pending = useRef<number | undefined>(undefined)
  const latest = useRef({ folder, run, value })
  latest.current = { folder, run, value }
  const save = () => {
    pending.current = undefined
    const { folder: f, run: r, value: v } = latest.current
    if (v !== f.similarity) r('Re-filing…', () => api.updateFolder(f.id, { similarity: v }))
  }
  // Wait for the slider to settle (it can move many steps in a second) before re-filing.
  const change = (v: number) => {
    latest.current.value = v
    setValue(v)
    window.clearTimeout(pending.current)
    pending.current = window.setTimeout(save, 450)
  }
  useEffect(() => {
    if (pending.current === undefined) setValue(folder.similarity)
  }, [folder.similarity])
  useEffect(() => {
    setEditing(false)
    setDeleting(false)
  }, [folder.id])
  useEffect(
    () => () => {
      if (pending.current !== undefined) {
        window.clearTimeout(pending.current)
        save()
      }
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )
  return (
    <div className={`lb-folderbar${editing ? ' editing' : ''}`}>
      <div className="lb-folderbar-line">
        <span className="lb-folder-ico" aria-hidden="true">▣</span>
        <b className="lb-folderbar-name" title={folder.name}>{folder.name}</b>
        <span className="muted" title={`Papers matching at ${value}% or more are filed here`}>
          ≥{value}%
        </span>
        <span className="spacer" />
        <button className="link" onClick={() => setEditing((e) => !e)} aria-expanded={editing} title="Rename, change the match threshold, or delete">
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      {editing && (
        <div className="lb-folderbar-edit">
          <input
            defaultValue={folder.name}
            key={folder.name}
            aria-label="Folder name"
            title="Press Enter to rename"
            onKeyDown={(e) => {
              const name = e.currentTarget.value.trim()
              if (e.key === 'Enter' && name && name !== folder.name) run('Renaming…', () => api.updateFolder(folder.id, { name }))
            }}
          />
          <SimilaritySlider value={value} onChange={change} />
          <p className="muted">Lower it for looser matches, raise it to be stricter. Papers you add or take out by hand stay as you left them.</p>
          <div className="lb-card-actions">
            {deleting ? (
              <>
                <span className="muted">Delete the folder? Its papers stay in the library.</span>
                <button onClick={() => setDeleting(false)}>Keep</button>
                <button className="danger" onClick={() => run('Deleting folder…', () => api.deleteFolder(folder.id))}>
                  Delete
                </button>
              </>
            ) : (
              <button className="link danger-link" onClick={() => setDeleting(true)}>
                Delete folder
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** One source in the list: one line of title, one of who and when. */
function Row({
  doc: d,
  on,
  active,
  folder,
  onToggle,
  onOpen,
}: {
  doc: Doc
  on: boolean
  active: boolean
  folder: Folder | undefined // the folder being browsed, to show how well the paper fits it
  onToggle: () => void
  onOpen: () => void
}) {
  const fit = folder && d.folders.find((x) => x.id === folder.id)
  const meta = [byline(d), pages(d)].filter(Boolean).join(' · ')
  return (
    <li
      id={`lib-doc-${d.id}`}
      className={`lb-row${on ? ' on' : ''}${active ? ' active' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(d.id))
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <input
        type="checkbox"
        className="lb-check"
        checked={on}
        onChange={onToggle}
        title={on ? 'The Assistant drafts from this source' : 'Tick to have the Assistant draft only from ticked sources'}
        aria-label={`Use “${d.title}” for drafting`}
      />
      <button className="lb-row-main" onClick={onOpen} aria-current={active}>
        <span className="lb-row-title">{d.title}</span>
        <span className="lb-row-meta">
          <span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind]}</span>
          {meta && <span className="lb-row-by">{meta}</span>}
        </span>
      </button>
      {fit ? (
        <span className="lb-row-fit" title={fit.state === 'user' ? 'You added it to this folder' : 'How well it matches this folder'}>
          {fit.state === 'user' ? 'added' : fit.score != null ? `${fit.score}%` : ''}
        </span>
      ) : (
        d.folders.length > 0 && (
          <span className="lb-row-folders" title={d.folders.map((f) => f.name).join(', ')}>
            {d.folders.length} folder{d.folders.length === 1 ? '' : 's'}
          </span>
        )
      )}
    </li>
  )
}

/** Everything about one source: summary, folders, keywords, and removing it. */
function Detail({ doc: d, on, onToggle, onClose, closeLabel, run }: {
  doc: Doc
  on: boolean
  onToggle: () => void
  onClose: () => void
  closeLabel: string
  run: Run
}) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => setConfirming(false), [d.id])
  const facts = [d.venue, pages(d), d.page_range && `pp. ${d.page_range}`].filter(Boolean)
  return (
    <section className="lb-detail" aria-label="Source details">
      <div className="lb-detail-top">
        <button className="link lb-back" onClick={onClose}>
          ‹ {closeLabel}
        </button>
      </div>
      <div className="lb-detail-body">
        <div className="lb-detail-kind">
          <span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind]}</span>
          {d.year && <span>{d.year}</span>}
        </div>
        <h3 className="lb-detail-title">{d.title}</h3>
        {d.authors.length > 0 && <p className="lb-detail-authors">{d.authors.join(', ')}</p>}
        {facts.length > 0 && <p className="muted">{facts.join(' · ')}</p>}
        {d.doi && (
          <p className="muted">
            DOI <span className="lb-doi">{d.doi}</span>
          </p>
        )}

        <button className={`lb-use${on ? ' on' : ''}`} onClick={onToggle} aria-pressed={on}>
          <span className="lb-use-box" aria-hidden="true">{on ? '✓' : ''}</span>
          {on ? 'The Assistant drafts from this source' : 'Draft from this source'}
        </button>

        {d.summary && (
          <>
            <h4 className="eyebrow">Summary</h4>
            <p className="lb-detail-summary">{d.summary}</p>
          </>
        )}

        <h4 className="eyebrow">Folders</h4>
        <FolderChips doc={d} editable run={run} />

        {(d.keywords.length > 0 || d.tags.length > 0 || d.jel_codes.length > 0) && <h4 className="eyebrow">Topics</h4>}
        {d.jel_codes.length > 0 && (
          <div className="tags">
            {d.jel_codes.map((j) => (
              <span key={j.code} className="tag jel" title={j.area}>
                {j.code}
              </span>
            ))}
          </div>
        )}
        {(d.keywords.length > 0 || d.tags.length > 0) && (
          <div className="tags">
            {[...new Set([...d.keywords, ...d.tags])].map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <footer className="lb-detail-foot">
        {confirming ? (
          <>
            <span className="muted">Citations to it stop working.</span>
            <button onClick={() => setConfirming(false)}>Keep</button>
            <button className="danger" onClick={() => run('Removing…', () => api.deleteDocument(d.id))}>
              Remove
            </button>
          </>
        ) : (
          <button className="link danger-link" onClick={() => setConfirming(true)}>
            Remove from library
          </button>
        )}
      </footer>
    </section>
  )
}

/** Paste a link or path, or pick files and folders: everything that adds a source, in one menu. */
function AddMenu({ busy, run, reportFailures }: { busy: boolean; run: Run; reportFailures: (r: IngestResult[]) => void }) {
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useDismiss(open, box, () => setOpen(false))

  const addFiles = async () => {
    setOpen(false)
    const files = (await window.rc?.pickFiles()) ?? []
    if (!files.length) return
    // One request for all of them: the backend reads several at once instead of one by one.
    await run(`Adding ${files.length} file${files.length === 1 ? '' : 's'}…`, async () =>
      reportFailures((await api.ingestPaths(files)).results),
    )
  }

  const addDiskFolder = async () => {
    setOpen(false)
    const folder = await window.rc?.pickFolder()
    if (folder) await run('Reading folder…', async () => reportFailures((await api.ingestPath(folder)).results))
  }

  // One field for both web pages and local paths, so there's nothing to choose between.
  const addSource = () => {
    const value = source.trim().replace(/^"(.*)"$/, '$1')
    if (!value) return
    const isUrl = /^https?:\/\//i.test(value)
    setOpen(false)
    setSource('')
    run(isUrl ? 'Fetching page…' : 'Reading…', async () => {
      if (isUrl) await api.ingestUrl(value)
      else reportFailures((await api.ingestPath(value)).results)
    })
  }

  return (
    <div className="lb-pop-anchor" ref={box}>
      <button className="primary lb-add-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" disabled={busy}>
        + Add
      </button>
      {open && (
        <div className="lb-pop lb-add-pop" role="dialog" aria-label="Add sources">
          {window.rc && (
            <div className="lb-add-picks">
              <button onClick={addFiles}>
                <b>Choose files…</b>
                <span>PDF, Word, slides, notes, images</span>
              </button>
              <button onClick={addDiskFolder}>
                <b>Import a folder…</b>
                <span>Everything readable inside it</span>
              </button>
            </div>
          )}
          <form className="lb-add-link" onSubmit={(e) => (e.preventDefault(), addSource())}>
            <label className="eyebrow" htmlFor="lb-add-input">{window.rc ? 'Or paste a link or path' : 'Paste a link or path'}</label>
            <div>
              <input
                id="lb-add-input"
                autoFocus
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="https://… or C:\papers\smith2021.pdf"
              />
              <button className="primary" disabled={!source.trim()}>
                Add
              </button>
            </div>
          </form>
          <p className="muted lb-add-hint">You can also drop files anywhere on the window.</p>
        </div>
      )}
    </div>
  )
}

function MoreMenu({ docs, folders, busy, run, onFindDuplicates }: {
  docs: Doc[]
  folders: Folder[]
  busy: boolean
  run: Run
  onFindDuplicates: () => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(open, box, () => setOpen(false))
  return (
    <div className="lb-pop-anchor" ref={box}>
      <button className="lb-icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label="More library actions" title="More" onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div className="lb-pop lb-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onFindDuplicates()
            }}
            disabled={docs.length < 2}
          >
            <b>Find duplicate files</b>
            <span>Copies of the same paper, with what you could free up</span>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false)
              run('Re-filing papers…', api.classifyFolders)
            }}
            disabled={busy || folders.length === 0}
          >
            <b>Re-file papers into folders</b>
            <span>{folders.length ? 'Score every paper against your folders again. Your own changes are kept.' : 'Make a folder first'}</span>
          </button>
        </div>
      )}
    </div>
  )
}

export function LibraryPanel({ docs, folders, wide, onToggleWide, selected, onToggle, onChanged, onError, focus, busyLabel, onFindDuplicates }: Props) {
  const [ownBusy, setBusy] = useState<string | null>(null)
  const busy = ownBusy ?? busyLabel ?? null
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | Doc['kind']>('all')
  const [open, setOpen] = useState<number | null>(null) // doc whose details are showing
  const [scope, setScope] = useState<Scope>('all') // the folder being browsed
  const [creating, setCreating] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [dropOn, setDropOn] = useState<Scope | null>(null)

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label)
    try {
      await fn()
      await onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  function reportFailures(results: IngestResult[]) {
    const failed = results.filter((r) => !r.ok)
    if (failed.length) onError(failed.map((f) => `${f.source.split(/[\\/]/).pop()}: ${f.error}`).join('\n'))
  }

  // Bring a requested paper into view: show everything, open its details, scroll to it.
  useEffect(() => {
    if (!focus) return
    setScope('all')
    setQuery('')
    setKind('all')
    setOpen(focus.id)
    const t = window.setTimeout(() => document.getElementById(`lib-doc-${focus.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350)
    return () => window.clearTimeout(t)
  }, [focus?.n])

  useEffect(() => {
    if (typeof scope === 'number' && !folders.some((f) => f.id === scope)) setScope('all') // the open folder was deleted
  }, [folders, scope])

  // A removed source closes its details.
  useEffect(() => {
    if (open != null && !docs.some((d) => d.id === open)) setOpen(null)
  }, [docs, open])

  // Opening a folder sorts by how well papers match it; leaving it goes back to names.
  useEffect(() => {
    setSort((s) => (typeof scope === 'number' ? { key: 'match', dir: -1 } : s.key === 'match' ? { key: 'name', dir: 1 } : s))
  }, [scope])

  const needle = query.trim().toLowerCase()
  const openFolder = typeof scope === 'number' ? folders.find((f) => f.id === scope) : undefined
  const rows = useMemo(() => {
    const shown = docs.filter(
      (d) =>
        (kind === 'all' || d.kind === kind) &&
        (scope === 'all' ? true : scope === 'none' ? d.folders.length === 0 : d.folders.some((f) => f.id === scope)) &&
        (!needle ||
          `${d.title} ${d.authors.join(' ')} ${d.venue} ${d.tags.join(' ')} ${d.keywords.join(' ')} ${d.jel_codes.map((j) => j.code).join(' ')} ${d.summary}`
            .toLowerCase()
            .includes(needle)),
    )
    const fit = (d: Doc) => d.folders.find((f) => f.id === scope)?.score ?? (d.folders.some((f) => f.id === scope) ? 101 : -1)
    const value = (d: Doc) =>
      sort.key === 'name' ? d.title.toLowerCase()
        : sort.key === 'type' ? d.kind
        : sort.key === 'year' ? (d.year ?? 0)
        : sort.key === 'match' ? fit(d)
        : d.page_count
    return shown.sort((a, b) => (value(a) > value(b) ? 1 : value(a) < value(b) ? -1 : 0) * sort.dir)
  }, [docs, kind, needle, scope, sort])

  const unfiled = docs.filter((d) => d.folders.length === 0).length
  const kinds = (Object.keys(KIND_LABEL) as Doc['kind'][])
    .map((k) => ({ kind: k, n: docs.filter((d) => d.kind === k).length }))
    .filter((k) => k.n > 0)
  const filtering = kind !== 'all' || needle !== ''
  const allShownOn = rows.length > 0 && rows.every((d) => selected.has(d.id))
  const detail = open != null ? docs.find((d) => d.id === open) : undefined
  const scopeName = scope === 'all' ? 'All sources' : scope === 'none' ? 'Unfiled' : openFolder?.name ?? 'Folder'

  const toggleMany = (members: Doc[]) => {
    const allOn = members.every((d) => selected.has(d.id))
    for (const d of members) if (allOn === selected.has(d.id)) onToggle(d.id)
  }

  const folderItem = (id: Scope, name: string, count: number, hint?: string) => {
    const folder = typeof id === 'number' ? folders.find((f) => f.id === id) : undefined
    return (
      <button
        key={String(id)}
        className={`lb-folder${scope === id ? ' on' : ''}${dropOn === id ? ' drop' : ''}`}
        onClick={() => {
          setScope(id)
          setOpen(null)
        }}
        title={folder ? `Papers matching “${folder.name}” at ${folder.similarity}% or more. Drop a paper here to file it.` : undefined}
        aria-pressed={scope === id}
        onDragOver={(e) => {
          if (!folder) return
          e.preventDefault()
          setDropOn(id)
        }}
        onDragLeave={() => setDropOn(null)}
        onDrop={(e) => {
          setDropOn(null)
          const docId = Number(e.dataTransfer.getData('text/plain'))
          if (folder && docId) run('Filing…', () => api.setFolderMember(docId, folder.id, true))
        }}
      >
        <span className="lb-folder-name">{name}</span>
        {hint && <span className="lb-folder-hint">{hint}</span>}
        <span className="lb-folder-count">{count}</span>
      </button>
    )
  }

  const list = (
    <section className="lb-list" aria-label={scopeName}>
      {creating && (
        <NewFolderForm
          onCancel={() => setCreating(false)}
          onCreate={(name, similarity) => {
            setCreating(false)
            run('Creating folder…', () => api.createFolder(name, similarity))
          }}
        />
      )}
      {openFolder && <FolderBar folder={openFolder} run={run} />}

      {docs.length > 0 && (
        <div className="lb-toolbar">
          <input
            className="lb-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={scope === 'all' ? 'Search the library…' : 'Search this folder…'}
            aria-label="Search the library"
          />
          {kinds.length > 1 && (
            <select className="lb-select" aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value as 'all' | Doc['kind'])}>
              <option value="all">All types</option>
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {KIND_PLURAL[k.kind]} ({k.n})
                </option>
              ))}
            </select>
          )}
          <select
            className="lb-select"
            aria-label="Sort"
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(':')
              setSort({ key: key as SortKey, dir: Number(dir) as 1 | -1 })
            }}
          >
            {openFolder && <option value="match:-1">Best match</option>}
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {rows.length > 0 && (
        <div className="lb-listhead">
          <label className="lb-check-all" title="Tick every source shown, so the Assistant drafts only from them">
            <input
              type="checkbox"
              checked={allShownOn}
              ref={(el) => {
                if (el) el.indeterminate = !allShownOn && rows.some((d) => selected.has(d.id))
              }}
              onChange={() => toggleMany(rows)}
            />
            <span>
              {rows.length} {filtering ? `of ${scope === 'all' ? docs.length : scopeName}` : rows.length === 1 ? 'source' : 'sources'}
            </span>
          </label>
          {filtering && (
            <button
              className="link"
              onClick={() => {
                setQuery('')
                setKind('all')
              }}
            >
              Clear search
            </button>
          )}
        </div>
      )}

      <ul className="lb-rows">
        {rows.map((d) => (
          <Row
            key={d.id}
            doc={d}
            on={selected.has(d.id)}
            active={open === d.id}
            folder={openFolder}
            onToggle={() => onToggle(d.id)}
            onOpen={() => setOpen(open === d.id ? null : d.id)}
          />
        ))}
      </ul>

      {docs.length === 0 && (
        <div className="lib-empty">
          <div className="lib-empty-title">Your library is empty</div>
          <p>Add the papers, notes, slides, scans and web pages you're writing from. They stay on this computer.</p>
          <ol>
            <li>Click Add, or drop files anywhere on the window</li>
            <li>Muse reads each one and writes a summary and tags</li>
            <li>Make a subject folder; matching papers are filed in, as many folders as fit</li>
          </ol>
        </div>
      )}
      {docs.length > 0 && rows.length === 0 && (
        <div className="lib-empty">
          <div className="lib-empty-title">{filtering ? 'No matches' : 'This folder is empty'}</div>
          {filtering ? (
            <button
              className="link"
              onClick={() => {
                setQuery('')
                setKind('all')
              }}
            >
              Clear search
            </button>
          ) : (
            <p>Lower its match threshold under Edit, or drag a paper onto the folder.</p>
          )}
        </div>
      )}
    </section>
  )

  return (
    <aside className={`panel library lb${wide ? ' wide' : ''}${detail ? ' has-detail' : ''}`}>
      <header className="lb-head">
        <div className="lb-title">
          <h2>Library</h2>
          <span className="muted">
            {docs.length} source{docs.length === 1 ? '' : 's'}
            {folders.length > 0 && ` · ${folders.length} folder${folders.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <AddMenu busy={!!busy} run={run} reportFailures={reportFailures} />
        <button
          className="lb-icon-btn"
          onClick={onToggleWide}
          title={wide ? 'Back to the side panel' : 'Expand into a full library view'}
          aria-label={wide ? 'Collapse library' : 'Expand library'}
        >
          {wide ? '⤡' : '⤢'}
        </button>
        {docs.length > 0 && <MoreMenu docs={docs} folders={folders} busy={!!busy} run={run} onFindDuplicates={onFindDuplicates} />}
      </header>
      <div className={`lb-progress${busy ? ' on' : ''}`} role="status" aria-live="polite">
        {busy && (
          <>
            <span className="bar" />
            <span>{busy}</span>
          </>
        )}
      </div>

      <datalist id="folder-names">
        {folders.map((f) => (
          <option key={f.id} value={f.name} />
        ))}
      </datalist>

      <div className="lb-body">
        {docs.length > 0 && (
          <nav
            className="lb-folders"
            aria-label="Folders"
            onWheel={(e) => {
              // The compact strip scrolls sideways; a mouse wheel only scrolls up and down.
              if (!wide && Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
            }}
          >
            {wide && <div className="eyebrow lb-folders-label">Browse</div>}
            {folderItem('all', 'All sources', docs.length)}
            {unfiled > 0 && folderItem('none', 'Unfiled', unfiled)}
            {wide && <div className="eyebrow lb-folders-label">Subject folders</div>}
            {folders.map((f) => folderItem(f.id, f.name, f.doc_count, wide ? `≥${f.similarity}%` : undefined))}
            <button
              className="lb-folder lb-folder-new"
              onClick={() => setCreating((c) => !c)}
              title="Make a folder for a subject you choose"
              aria-expanded={creating}
            >
              + New folder
            </button>
          </nav>
        )}
        {list}
        {detail && (
          <Detail
            doc={detail}
            on={selected.has(detail.id)}
            onToggle={() => onToggle(detail.id)}
            onClose={() => setOpen(null)}
            closeLabel={wide ? 'Close' : scopeName}
            run={run}
          />
        )}
      </div>

      {selected.size > 0 && (
        <footer className="lb-scopebar">
          <span>
            Assistant drafts from <b>{selected.size}</b> of {docs.length} source{docs.length === 1 ? '' : 's'}
          </span>
          <button className="link" onClick={() => toggleMany(docs.filter((d) => selected.has(d.id)))}>
            Use all
          </button>
        </footer>
      )}
    </aside>
  )
}
