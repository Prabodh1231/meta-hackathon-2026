import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Doc, Folder, IngestJob } from '../types'
import { ImportProgress, owedText } from './ImportProgress'

interface Props {
  docs: Doc[]
  folders: Folder[]
  /** The app bar's search, which filters the library while it's open. */
  query: string
  onQuery: (query: string) => void
  selected: Set<number>
  onToggle: (id: number) => void
  onChanged: () => Promise<void>
  onError: (msg: string) => void
  /** A paper to bring into view and open (from the network view or the palette); `n` changes per request. */
  focus?: { id: number; n: number } | null
  onFindDuplicates: () => void
  onCitedPapers: (docId: number) => void
  onFindMissing: () => void
  cited: number[] // documents the draft cites
  /** Where a new folder's similarity starts (Settings). */
  folderSimilarity: number
  /** Show a PDF in the app's viewer. */
  onOpenPdf: (doc: Doc) => void
  /** Background imports, newest first, with each file's progress. */
  jobs: IngestJob[]
  /** Add files and folders on disk, in the background. */
  onAddPaths: (paths: string[]) => Promise<void>
  onCancelJob: (id: number) => void
  onDismissJob: (id: number) => void
}

const KIND_LABEL: Record<Doc['kind'], string> = {
  pdf: 'PDF',
  docx: 'Doc',
  text: 'Notes',
  web: 'Web',
  pptx: 'Slides',
  image: 'Scan',
}
const FILTERS: { id: Doc['kind']; label: string }[] = [
  { id: 'pdf', label: 'PDFs' },
  { id: 'docx', label: 'Docs' },
  { id: 'text', label: 'Notes' },
  { id: 'web', label: 'Web pages' },
  { id: 'pptx', label: 'Slides' },
  { id: 'image', label: 'Scans' },
]

/** 'Okafor & Raman', 'Chen et al.': surnames, as a reference list shows them. */
function authorsShort(d: Doc): string {
  const surname = (a: string) => (a.includes(',') ? a.split(',')[0] : a.split(' ').pop() ?? a).trim()
  if (d.authors.length > 2) return `${surname(d.authors[0])} et al.`
  return d.authors.map(surname).join(' & ')
}

type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>
type SortKey = 'title' | 'authors' | 'year' | 'type' | 'added' | 'pages' | 'match'
type Sort = { key: SortKey; dir: 1 | -1 }
type Scope = 'all' | 'none' | number // every file, files with no folder, or one folder

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
          {editable && (
            <button
              className="tag-x"
              title={`Not about ${f.name}: take it out of this folder`}
              aria-label={`Remove ${d.title} from ${f.name}`}
              onClick={(e) => {
                e.stopPropagation()
                run('Updating…', () => api.setFolderMember(d.id, f.id, false))
              }}
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
          onClick={(e) => e.stopPropagation()}
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
      <span>Similarity</span>
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
function NewFolderForm({ initial, onCreate, onCancel }: {
  initial: number
  onCreate: (name: string, similarity: number) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [similarity, setSimilarity] = useState(initial)
  return (
    <form
      className="newfolder"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onCreate(name.trim(), similarity)
      }}
    >
      <div className="newfolder-title">New subject folder</div>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        placeholder="Subject, e.g. Digital finance"
        aria-label="Folder name"
      />
      <SimilaritySlider value={similarity} onChange={setSimilarity} />
      <p className="muted">
        Every paper that matches this subject at {similarity}% or more is filed here. Lower it to take in looser matches, raise it to be stricter.
      </p>
      <div className="newfolder-actions">
        <button className="primary" disabled={!name.trim()}>
          Create folder
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Shown for an opened folder: its name, how closely a paper has to match to be filed here,
 * and renaming or deleting it. */
function FolderBar({ folder, run }: { folder: Folder; run: Run }) {
  const [value, setValue] = useState(folder.similarity)
  const [renaming, setRenaming] = useState(false)
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
    setRenaming(false)
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
    <div className="lib-folderbar">
      <div className="lib-folderbar-top">
        {renaming ? (
          <input
            autoFocus
            defaultValue={folder.name}
            aria-label="Folder name"
            onBlur={() => setRenaming(false)}
            onKeyDown={(e) => {
              const name = e.currentTarget.value.trim()
              if (e.key === 'Escape') setRenaming(false)
              if (e.key === 'Enter' && name) {
                setRenaming(false)
                run('Renaming…', () => api.updateFolder(folder.id, { name }))
              }
            }}
          />
        ) : (
          <b className="lib-folderbar-name" onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
            {folder.name}
          </b>
        )}
        <span className="spacer" />
        {deleting ? (
          <>
            <button className="danger" onClick={() => run('Deleting folder…', () => api.deleteFolder(folder.id))}>
              Delete folder
            </button>
            <button onClick={() => setDeleting(false)}>Keep</button>
          </>
        ) : (
          <>
            <button className="link" onClick={() => setRenaming(true)}>Rename</button>
            <button className="link danger-link" onClick={() => setDeleting(true)} title="The sources stay in your library">
              Delete
            </button>
          </>
        )}
      </div>
      <SimilaritySlider value={value} onChange={change} />
      <span className="muted">Papers matching {value}% or more are filed here. What you add or remove by hand is kept.</span>
    </div>
  )
}

/** JEL classification codes the authors printed; hover for the field each belongs to. */
function JelChips({ doc }: { doc: Doc }) {
  if (doc.jel_codes.length === 0) return null
  return (
    <div className="tags">
      <span className="muted">JEL</span>
      {doc.jel_codes.map((j) => (
        <span key={j.code} className="tag jel" title={j.area}>
          {j.code}
        </span>
      ))}
    </div>
  )
}

/** Lets a source be dragged onto a folder to file it there. */
function dragProps(d: Doc) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('text/plain', String(d.id))
      e.dataTransfer.effectAllowed = 'copy'
    },
  }
}

/** How well a paper fits the folder being browsed: 'added by you' or its match score. */
function fitLabel(d: Doc, folder: Folder | undefined): string {
  const f = folder && d.folders.find((x) => x.id === folder.id)
  if (!f) return ''
  return f.state === 'user' ? 'added by you' : f.score != null ? `${f.score}%` : ''
}

/** "no summary yet": what Muse couldn't write when the source was added. */
function OwedMark({ doc: d }: { doc: Doc }) {
  return (
    <span className="lb-row-owed" title={`Muse couldn't write its ${owedText(d.missing)} when it was added`}>
      no {owedText(d.missing)} yet
    </span>
  )
}

const COLUMNS: { key: SortKey; label: string; first: 1 | -1 }[] = [
  { key: 'title', label: 'Title', first: 1 },
  { key: 'authors', label: 'Authors', first: 1 },
  { key: 'year', label: 'Year', first: -1 },
  { key: 'type', label: 'Type', first: 1 },
  { key: 'added', label: 'Added', first: -1 },
]

/** The expanded library: every source as a row, sortable by any column. */
function DocTable({ rows, selected, cited, open, folder, sort, onSort, onToggle, onToggleAll, onOpen }: {
  rows: Doc[]
  selected: Set<number>
  cited: Set<number>
  open: number | null
  folder: Folder | undefined
  sort: Sort
  onSort: (s: Sort) => void
  onToggle: (id: number) => void
  onToggleAll: () => void
  onOpen: (id: number | null) => void
}) {
  const allOn = rows.length > 0 && rows.every((d) => selected.has(d.id))
  const columns = folder ? [...COLUMNS.slice(0, 4), { key: 'match' as SortKey, label: 'Match', first: -1 as const }] : COLUMNS
  const header = (c: (typeof columns)[number]) => {
    const on = sort.key === c.key
    return (
      <th key={c.key} className={`c-${c.key}`} aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button onClick={() => onSort({ key: c.key, dir: on ? (-sort.dir as 1 | -1) : c.first })}>
          {c.label}
          <span className="sort-arrow" aria-hidden="true">{on ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
        </button>
      </th>
    )
  }
  // ↑ ↓ move between papers while the table has focus, Esc closes the details.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return onOpen(null)
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const i = rows.findIndex((d) => d.id === open)
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next) {
      onOpen(next.id)
      document.getElementById(`lib-doc-${next.id}`)?.scrollIntoView({ block: 'nearest' })
    }
  }
  return (
    <div className="lib-table-wrap">
    <table className="lib-table" tabIndex={0} onKeyDown={onKeyDown} aria-label="Sources">
      <thead>
        <tr>
          <th className="c-pick">
            <input type="checkbox" checked={allOn} onChange={onToggleAll} aria-label="Use every source shown for drafting" title="Use every source shown for drafting" />
          </th>
          {columns.map(header)}
          {!folder && <th className="c-folders">Folders</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr
            key={d.id}
            id={`lib-doc-${d.id}`}
            className={`${selected.has(d.id) ? 'on' : ''}${open === d.id ? ' active' : ''}`}
            aria-selected={open === d.id}
            onClick={() => onOpen(open === d.id ? null : d.id)}
            {...dragProps(d)}
          >
            <td className="c-pick" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={selected.has(d.id)} onChange={() => onToggle(d.id)} aria-label={`Use “${d.title}” for drafting`} />
            </td>
            <td className="c-title">
              <span className="lib-cell-title">{d.title}</span>
              {cited.has(d.id) && <span className="cited-mark" title="Your draft cites this">Cited</span>}
              {d.missing.length > 0 && <OwedMark doc={d} />}
            </td>
            <td className="c-authors">{authorsShort(d)}</td>
            <td className="c-year">{d.year ?? ''}</td>
            <td className="c-type"><span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind]}</span></td>
            {folder ? (
              <td className="c-match">{fitLabel(d, folder)}</td>
            ) : (
              <>
                <td className="c-added">{d.added_at.slice(0, 10)}</td>
                <td className="c-folders">{d.folders.map((f) => f.name).join(', ')}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}

/** Correct what was read from the file: references and citations are built from these. */
function EditDetails({ doc: d, run, onDone }: { doc: Doc; run: Run; onDone: () => void }) {
  const [f, setF] = useState({
    title: d.title, authors: d.authors.join('\n'), year: d.year ? String(d.year) : '', venue: d.venue, doi: d.doi, url: d.url,
  })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  const year = f.year.trim() ? Number(f.year) : null
  const valid = f.title.trim() !== '' && (year === null || (Number.isInteger(year) && year > 0 && year < 3000))
  return (
    <form
      className="lib-edit"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        onDone()
        // Only what changed: the backend keeps every field it's sent as the user's own, and stops
        // refreshing it from the file.
        const next: Partial<Doc> = {
          title: f.title.trim(),
          authors: f.authors.split('\n').map((a) => a.trim()).filter(Boolean),
          year, venue: f.venue.trim(), doi: f.doi.trim(), url: f.url.trim(),
        }
        const changed = Object.fromEntries(
          Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(d[k as keyof Doc])),
        ) as Partial<Doc>
        if (Object.keys(changed).length) run('Saving…', () => api.updateDocument(d.id, changed))
      }}
      onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onDone())}
    >
      <label>Title<textarea rows={2} value={f.title} onChange={set('title')} autoFocus /></label>
      <label>Authors, one per line<textarea rows={Math.max(2, d.authors.length)} value={f.authors} onChange={set('authors')} /></label>
      <div className="lib-edit-row">
        <label>Year<input value={f.year} onChange={set('year')} inputMode="numeric" /></label>
        <label>Journal or venue<input value={f.venue} onChange={set('venue')} /></label>
      </div>
      <label>DOI<input value={f.doi} onChange={set('doi')} placeholder="10.…" /></label>
      <label>Link<input value={f.url} onChange={set('url')} placeholder="https://…" /></label>
      <p className="muted">What you change here is kept if the file is added again.</p>
      <div className="lib-edit-actions">
        <button className="primary" disabled={!valid}>Save</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  )
}

/** Everything about one source, and what can be done with it. */
function DocDetails({ doc: d, on, cited, onToggle, onClose, onCited, onRetry, onOpenPdf, run }: {
  doc: Doc
  on: boolean
  cited: boolean
  onOpenPdf: () => void
  onToggle: () => void
  onClose: () => void
  onCited: () => void
  onRetry: () => void // ask Muse again for what it couldn't write when this was added
  run: Run
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const isFile = !/^https?:\/\//i.test(d.source)
  const terms = [...new Set([...d.keywords, ...d.tags].map((t) => t.toLowerCase()))]
  const facts = [d.year, d.venue, d.page_range ? `pp. ${d.page_range}` : ''].filter(Boolean).join(' · ')
  return (
    <section className="lib-detail" aria-label="Source details">
      <div className="lib-detail-top">
        <span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind]}</span>
        <span className="spacer" />
        <button className="icon" onClick={onClose} aria-label="Close details" title="Close (Esc)">×</button>
      </div>

      {editing ? (
        <EditDetails doc={d} run={run} onDone={() => setEditing(false)} />
      ) : (
        <>
          <h3 className="lib-detail-title">{d.title}</h3>
          {d.authors.length > 0 && (
            <p className="lib-detail-authors">{d.authors.join(d.authors.some((a) => a.includes(',')) ? '; ' : ', ')}</p>
          )}
          {facts && <p className="lib-detail-facts">{facts}</p>}
          {cited && <p className="lib-detail-cited">Your draft cites this</p>}
          {d.missing.length > 0 && (
            <div className="lb-owed lib-detail-owed">
              <span>Muse couldn't write its {owedText(d.missing)} when it was added. It's searchable and citable meanwhile.</span>
              <button className="link" onClick={onRetry}>
                Try again
              </button>
            </div>
          )}

          <div className="lib-detail-actions">
            {d.kind === 'pdf' && isFile && (
              <button className="primary" onClick={onOpenPdf} title="Read the whole PDF here: search, zoom and print">
                Open PDF
              </button>
            )}
            <label className={`lib-use${on ? ' on' : ''}`} title="Tick sources to have the Assistant draft only from them">
              <input type="checkbox" checked={on} onChange={onToggle} /> Use for drafting
            </label>
            <button onClick={onCited} title="List the works this paper cites and download free copies of them">Cited papers…</button>
            <button onClick={() => setEditing(true)} title="Correct the title, authors, year, journal, DOI or link">Edit details</button>
          </div>
        </>
      )}

      {d.summary && (
        <>
          <h4 className="lib-doc-label">Summary</h4>
          <p className="lib-doc-summary">{d.summary}</p>
        </>
      )}

      <h4 className="lib-doc-label">Folders</h4>
      <FolderChips doc={d} editable run={run} />

      {(terms.length > 0 || d.jel_codes.length > 0) && <h4 className="lib-doc-label">Keywords</h4>}
      {terms.length > 0 && (
        <div className="tags">
          {terms.map((t) => <span key={t} className="tag">{t}</span>)}
        </div>
      )}
      <JelChips doc={d} />

      <h4 className="lib-doc-label">File</h4>
      <dl className="lib-detail-meta">
        <dt>Type</dt>
        <dd>{KIND_LABEL[d.kind]}{d.page_count > 1 ? ` · ${d.page_count} ${d.kind === 'pptx' ? 'slides' : 'pages'}` : ''}</dd>
        {d.doi && (
          <>
            <dt>DOI</dt>
            <dd><a className="link" href={`https://doi.org/${d.doi}`} target="_blank" rel="noreferrer">{d.doi}</a></dd>
          </>
        )}
        {d.url && d.url !== d.source && (
          <>
            <dt>Link</dt>
            <dd><a className="link" href={d.url} target="_blank" rel="noreferrer">{d.url.replace(/^https?:\/\/(www\.)?/, '')}</a></dd>
          </>
        )}
        <dt>Added</dt>
        <dd>{d.added_at.slice(0, 10)}</dd>
        <dt>{isFile ? 'Location' : 'Page'}</dt>
        <dd>
          {isFile ? <code title={d.source}>{d.source}</code> : <a className="link" href={d.source} target="_blank" rel="noreferrer">{d.source}</a>}
          {isFile && window.rc?.showFile && (
            <button className="link" onClick={() => window.rc!.showFile!(d.source).catch(() => {})}>Show in folder</button>
          )}
        </dd>
      </dl>

      <div className="lib-detail-remove">
        {confirming ? (
          <>
            <span>Remove “{d.title}” from your library? The file stays where it is.</span>
            <button className="danger" onClick={() => run('Removing…', () => api.deleteDocument(d.id))}>Remove</button>
            <button onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : (
          <button className="link danger-link" onClick={() => setConfirming(true)}>Remove from library</button>
        )}
      </div>
    </section>
  )
}

/** Closes a popup menu on a click outside `ref`. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close()
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, close, ref])
}

/** One button for every way in: files, a folder on disk, or a pasted link or path. */
function AddSources({ disabled, onFiles, onFolder, onLink }: {
  disabled: boolean
  onFiles: () => void
  onFolder: () => void
  onLink: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [value, setValue] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    setPasting(false)
    setValue('')
  }, [])
  useDismiss(open, close, ref)
  const pick = (fn: () => void) => () => {
    close()
    fn()
  }
  return (
    <div className="add-sources" ref={ref}>
      <button className="primary" onClick={() => (open ? close() : setOpen(true))} disabled={disabled} aria-haspopup="menu" aria-expanded={open}>
        + Add sources
      </button>
      {open && (
        <div
          className="lib-menu add-menu"
          role="menu"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            close()
          }}
        >
          {window.rc && (
            <>
              <button role="menuitem" onClick={pick(onFiles)}>
                <b>Files…</b>
                <span>PDF, Word, PowerPoint, Markdown, text, HTML, images</span>
              </button>
              <button role="menuitem" onClick={pick(onFolder)}>
                <b>Folder…</b>
                <span>Every readable document in a folder and its subfolders</span>
              </button>
            </>
          )}
          {pasting ? (
            <form
              className="add-link"
              onSubmit={(e) => {
                e.preventDefault()
                const v = value.trim().replace(/^"(.*)"$/, '$1')
                if (v) pick(() => onLink(v))()
              }}
            >
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="https://… or a file path"
                aria-label="Web link or file path"
              />
              <button className="primary" disabled={!value.trim()}>Add</button>
            </form>
          ) : (
            <button role="menuitem" onClick={() => setPasting(true)}>
              <b>Paste a link or path…</b>
              <span>A web page, or a file or folder on this computer</span>
            </button>
          )}
          <p className="muted add-hint">You can also drop files anywhere on the window.</p>
        </div>
      )}
    </div>
  )
}

/** The library: subject folders on the left, every source as a sortable table, and the open
 * source's details on the right. The app bar's search box filters it. Memoized: the app redraws
 * at every pause in typing, and the library has no reason to follow. */
export const LibraryPanel = memo(function LibraryPanel({
  docs, folders, query, onQuery, selected, onToggle, onChanged, onError, focus, onFindDuplicates, onCitedPapers, onFindMissing, cited,
  folderSimilarity, onOpenPdf,  jobs, onAddPaths, onCancelJob, onDismissJob,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [kind, setKind] = useState<'all' | Doc['kind']>('all')
  const [open, setOpen] = useState<number | null>(null) // doc whose details are showing
  const [scope, setScope] = useState<Scope>('all') // the folder being browsed
  const [creating, setCreating] = useState(false)
  const [sort, setSort] = useState<Sort>({ key: 'title', dir: 1 })
  const [dropOn, setDropOn] = useState<Scope | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const closeMore = useCallback(() => setMoreOpen(false), [])
  useDismiss(moreOpen, closeMore, moreRef)

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

  // Files and folders are read in the background, with each file's progress shown below the header.
  const addFiles = async () => {
    const files = (await window.rc?.pickFiles()) ?? []
    if (files.length) await onAddPaths(files)
  }

  const addDiskFolder = async () => {
    const folder = await window.rc?.pickFolder()
    if (folder) await onAddPaths([folder])
  }

  // One field for both web pages and local paths, so there's nothing to choose between.
  const addLink = (value: string) => {
    if (/^https?:\/\//i.test(value)) run('Fetching page…', () => api.ingestUrl(value))
    else onAddPaths([value])
  }

  /** Ask Muse again for what failed when sources were added (all of them, or `ids`). */
  const retry = (ids?: number[]) =>
    run('Asking Muse again…', async () => {
      const r = await api.fillMissing(ids)
      if (r.still_missing) {
        onError(`Muse still couldn't finish ${r.still_missing} source${r.still_missing === 1 ? '' : 's'}. They stay searchable; try again in a few minutes.`)
      }
    })
  const owed = docs.filter((d) => d.missing.length > 0).length
  const importing = jobs.some((j) => j.finished_at == null) // an import retries what it owes when it ends

  // Bring a requested paper into view: show everything and open its details.
  useEffect(() => {
    if (!focus) return
    setScope('all')
    onQuery('')
    setKind('all')
    setOpen(focus.id)
    const t = window.setTimeout(() => document.getElementById(`lib-doc-${focus.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350)
    return () => window.clearTimeout(t)
  }, [focus?.n])

  useEffect(() => {
    if (typeof scope === 'number' && !folders.some((f) => f.id === scope)) setScope('all') // the open folder was deleted
  }, [folders, scope])

  useEffect(() => {
    if (open !== null && !docs.some((d) => d.id === open)) setOpen(null) // the open paper was removed
  }, [docs, open])

  useEffect(() => {
    if (sort.key === 'match' && typeof scope !== 'number') setSort({ key: 'title', dir: 1 })
  }, [scope, sort.key])

  const needle = query.trim().toLowerCase()
  const openFolder = typeof scope === 'number' ? folders.find((f) => f.id === scope) : undefined
  const citedSet = useMemo(() => new Set(cited), [cited])
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
    const value = (d: Doc): string | number =>
      sort.key === 'title' ? d.title.toLowerCase()
        : sort.key === 'authors' ? authorsShort(d).toLowerCase() || '￿' // no authors: last
        : sort.key === 'type' ? KIND_LABEL[d.kind]
        : sort.key === 'year' ? (d.year ?? 0)
        : sort.key === 'added' ? `${d.added_at}${String(d.id).padStart(9, '0')}`
        : sort.key === 'match' ? fit(d)
        : d.page_count
    const byTitle = (a: Doc, b: Doc) => a.title.localeCompare(b.title)
    return shown.sort((a, b) => (value(a) > value(b) ? 1 : value(a) < value(b) ? -1 : byTitle(a, b) * sort.dir) * sort.dir)
  }, [docs, kind, needle, scope, sort])

  const unfiled = docs.filter((d) => d.folders.length === 0).length
  const kinds = FILTERS.filter((f) => docs.some((d) => d.kind === f.id))
  const filtering = kind !== 'all' || needle !== ''
  const current = open !== null ? docs.find((d) => d.id === open) : undefined

  const toggleMany = (members: Doc[]) => {
    const allOn = members.every((d) => selected.has(d.id))
    for (const d of members) if (allOn === selected.has(d.id)) onToggle(d.id)
  }

  const navItem = (id: Scope, name: string, count: number, hint?: string) => {
    const folder = typeof id === 'number' ? folders.find((f) => f.id === id) : undefined
    return (
      <button
        key={String(id)}
        className={`lib-nav-item${scope === id ? ' on' : ''}${dropOn === id ? ' drop' : ''}`}
        onClick={() => setScope(id)}
        title={folder ? `${folder.similarity}% similarity · drop a paper here to file it` : undefined}
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
        <span className="lib-nav-ico" aria-hidden="true">
          {id === 'all' ? '◫' : id === 'none' ? '◌' : '▣'}
        </span>
        <span className="lib-nav-name">{name}</span>
        {hint && <span className="lib-nav-hint">{hint}</span>}
        <span className="lib-nav-count">{count}</span>
      </button>
    )
  }

  return (
    <section className={`panel library${current ? ' has-pane' : ''}`} aria-label="Library">
      <header className="lib-head">
        <div className="lib-title">
          <h2>Library</h2>
          <span className="muted">
            {docs.length} source{docs.length === 1 ? '' : 's'}
            {folders.length > 0 && ` · ${folders.length} folder${folders.length === 1 ? '' : 's'}`}
          </span>
        </div>
        {busy && (
          <div className="lib-busy" role="status">
            <span className="bar" />
            {busy}
          </div>
        )}
        <span className="spacer" />
        <AddSources disabled={!!busy} onFiles={addFiles} onFolder={addDiskFolder} onLink={addLink} />
        {docs.length > 0 && (
          <div className="lib-more" ref={moreRef}>
            <button className="ghost lib-icon-btn" aria-haspopup="menu" aria-expanded={moreOpen} aria-label="More library actions" title="More" onClick={() => setMoreOpen((o) => !o)}>
              ⋯
            </button>
            {moreOpen && (
              <div className="lib-menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false)
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
                    setMoreOpen(false)
                    onFindMissing()
                  }}
                >
                  <b>Most-cited papers you don't have</b>
                  <span>What your papers on a topic cite most, with free copies to download</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false)
                    run('Re-filing papers…', api.classifyFolders)
                  }}
                  disabled={!!busy || folders.length === 0}
                >
                  <b>Re-file papers into folders</b>
                  <span>{folders.length ? 'Score every paper against your folders again. Your own changes are kept.' : 'Make a folder first'}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {(jobs.length > 0 || (owed > 0 && !importing)) && (
        <div className="lb-jobs">
          {jobs.map((j) => (
            <ImportProgress key={j.id} job={j} onCancel={() => onCancelJob(j.id)} onDismiss={() => onDismissJob(j.id)} />
          ))}
          {owed > 0 && !importing && (
            <div className="lb-owed">
              <span>
                {owed} source{owed === 1 ? ' has' : 's have'} no {owedText(docs.flatMap((d) => d.missing))} yet: Muse was unavailable when{' '}
                {owed === 1 ? 'it was' : 'they were'} added.
              </span>
              <button className="link" onClick={() => retry()} disabled={!!busy}>
                Try again
              </button>
            </div>
          )}
        </div>
      )}

      <datalist id="folder-names">
        {folders.map((f) => (
          <option key={f.id} value={f.name} />
        ))}
      </datalist>

      <div className="lib-body">
        <nav className="lib-nav" aria-label="Folders">
          <div className="lib-nav-label">Browse</div>
          {navItem('all', 'All sources', docs.length)}
          {unfiled > 0 && navItem('none', 'Unfiled', unfiled)}
          {folders.length > 0 && <div className="lib-nav-label">Subject folders</div>}
          {folders.map((f) => navItem(f.id, f.name, f.doc_count, `${f.similarity}%`))}
          <button className="lib-nav-item lib-nav-new" onClick={() => setCreating((c) => !c)} title="Make a folder for a subject you choose">
            <span className="lib-nav-ico" aria-hidden="true">+</span>
            <span className="lib-nav-name">New folder</span>
          </button>
        </nav>

        <div className="lib-main">
          <div className="lib-list">
            {creating && (
              <NewFolderForm
                initial={folderSimilarity}
                onCancel={() => setCreating(false)}
                onCreate={(name, similarity) => {
                  setCreating(false)
                  run('Creating folder…', () => api.createFolder(name, similarity))
                }}
              />
            )}
            {openFolder && <FolderBar folder={openFolder} run={run} />}

            {docs.length > 0 && (
              <div className="lib-tools">
                {kinds.length > 1 && (
                  <select className="lib-kind" aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                    <option value="all">All types</option>
                    {kinds.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label} ({docs.filter((d) => d.kind === f.id).length})
                      </option>
                    ))}
                  </select>
                )}
                <span className="muted">
                  {filtering ? `${rows.length} of ${docs.length} shown` : `${rows.length} shown`}
                  {needle && <> matching “{query.trim()}”</>}
                </span>
                <span className="spacer" />
                <span className={`lib-scope${selected.size ? ' some' : ''}`} title="Tick sources to have the Assistant and cite searches use only them">
                  {selected.size === 0 ? (
                    'Tick sources to draft from only those'
                  ) : (
                    <>
                      <b>{selected.size}</b> ticked for drafting
                      <button className="link" onClick={() => toggleMany(docs.filter((d) => selected.has(d.id)))}>
                        Clear
                      </button>
                    </>
                  )}
                </span>
              </div>
            )}

            {rows.length > 0 && (
              <DocTable
                rows={rows}
                selected={selected}
                cited={citedSet}
                open={open}
                folder={openFolder}
                sort={sort}
                onSort={setSort}
                onToggle={onToggle}
                onToggleAll={() => toggleMany(rows)}
                onOpen={setOpen}
              />
            )}

            {docs.length === 0 && (
              <div className="lib-empty">
                <div className="lib-empty-title">Your library is empty</div>
                <p>Add the papers, notes, slides, scans and web pages you're writing from. They stay on this computer.</p>
                <ol>
                  <li>Click <b>Add sources</b>, or drop files anywhere on the window</li>
                  <li>Muse reads each one and writes a summary and tags</li>
                  <li>Make a subject folder (New folder); matching papers are filed in, as many folders as fit</li>
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
                      onQuery('')
                      setKind('all')
                    }}
                  >
                    Clear the search and type filter
                  </button>
                ) : (
                  <p>Lower the similarity above to take in looser matches, or drag a paper onto the folder.</p>
                )}
              </div>
            )}
          </div>
        </div>

        {current && (
          <div className="lib-pane">
            <DocDetails
              key={current.id}
              doc={current}
              on={selected.has(current.id)}
              cited={citedSet.has(current.id)}
              onToggle={() => onToggle(current.id)}
              onClose={() => setOpen(null)}
              onCited={() => onCitedPapers(current.id)}
              onRetry={() => retry([current.id])}
              onOpenPdf={() => onOpenPdf(current)}
              run={run}
            />
          </div>
        )}
      </div>
    </section>
  )
})
