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
const FILTERS: { id: 'all' | Doc['kind']; label: string }[] = [
  { id: 'all', label: 'All types' },
  { id: 'pdf', label: 'PDF' },
  { id: 'docx', label: 'Docs' },
  { id: 'text', label: 'Notes' },
  { id: 'web', label: 'Web' },
  { id: 'pptx', label: 'Slides' },
  { id: 'image', label: 'Scans' },
]

function byline(d: Doc): string {
  const who = d.authors.length > 2 ? `${d.authors[0]} et al.` : d.authors.join(' & ')
  return [who, d.year, d.venue].filter(Boolean).join(' · ')
}

type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>
type SortKey = 'name' | 'type' | 'year' | 'pages' | 'match'
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
function NewFolderForm({ onCreate, onCancel }: { onCreate: (name: string, similarity: number) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [similarity, setSimilarity] = useState(50)
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

/** One source: what it is, who wrote it, its folders. Opens in place for the summary and edits. */
function DocCard({
  doc: d,
  on,
  isOpen,
  folder,
  onToggle,
  onOpen,
  run,
}: {
  doc: Doc
  on: boolean
  isOpen: boolean
  folder: Folder | undefined // the folder being browsed, to show how well the paper fits it
  onToggle: () => void
  onOpen: () => void
  run: Run
}) {
  const [confirming, setConfirming] = useState(false)
  const fit = folder && d.folders.find((x) => x.id === folder.id)
  return (
    <li
      id={`lib-doc-${d.id}`}
      className={`lib-doc${on ? ' on' : ''}${isOpen ? ' open' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(d.id))
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <label className="pick" title={on ? 'The Assistant drafts from this source' : 'Tick to have the Assistant draft only from ticked sources'}>
        <input type="checkbox" checked={on} onChange={onToggle} aria-label={`Use “${d.title}” for drafting`} />
      </label>
      <div className="lib-doc-body" onClick={onOpen}>
        <div className="lib-doc-meta">
          <span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind]}</span>
          {d.page_count > 1 && <span>{d.page_count} {d.kind === 'pptx' ? 'slides' : 'pp'}</span>}
          {fit && <span className="fit">{fit.state === 'user' ? 'added by you' : fit.score != null ? `${fit.score}% match` : ''}</span>}
        </div>
        <div className="lib-doc-title">{d.title}</div>
        {byline(d) && <div className="lib-doc-by">{byline(d)}</div>}
        {!isOpen && <FolderChips doc={d} editable={false} run={run} />}
        {isOpen && (
          <div className="lib-doc-more" onClick={(e) => e.stopPropagation()}>
            {d.summary && <p className="lib-doc-summary">{d.summary}</p>}
            <div className="lib-doc-label">Folders</div>
            <FolderChips doc={d} editable run={run} />
            <JelChips doc={d} />
            {d.tags.length > 0 && (
              <div className="tags">
                {d.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="lib-doc-actions">
              {confirming ? (
                <>
                  <button className="danger" onClick={() => run('Removing…', () => api.deleteDocument(d.id))}>
                    Remove from library
                  </button>
                  <button onClick={() => setConfirming(false)}>Keep</button>
                </>
              ) : (
                <button className="link danger-link" onClick={() => setConfirming(true)}>
                  Remove from library
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </li>
  )
}

export function LibraryPanel({ docs, folders, wide, onToggleWide, selected, onToggle, onChanged, onError, focus, onFindDuplicates }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | Doc['kind']>('all')
  const [open, setOpen] = useState<number | null>(null) // doc whose details are showing
  const [scope, setScope] = useState<Scope>('all') // the folder being browsed
  const [creating, setCreating] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [dropOn, setDropOn] = useState<Scope | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen) return
    const close = (e: MouseEvent) => !moreRef.current?.contains(e.target as Node) && setMoreOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [moreOpen])

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

  const addFiles = () =>
    run('Adding files…', async () => {
      const files = (await window.rc?.pickFiles()) ?? []
      for (const f of files) reportFailures((await api.ingestPath(f)).results)
    })

  const addDiskFolder = () =>
    run('Reading folder…', async () => {
      const folder = await window.rc?.pickFolder()
      if (folder) reportFailures((await api.ingestPath(folder)).results)
    })

  // One field for both web pages and local paths, so there's nothing to choose between.
  const addSource = () => {
    const value = source.trim().replace(/^"(.*)"$/, '$1')
    if (!value) return
    const isUrl = /^https?:\/\//i.test(value)
    run(isUrl ? 'Fetching page…' : 'Reading…', async () => {
      if (isUrl) await api.ingestUrl(value)
      else reportFailures((await api.ingestPath(value)).results)
      setSource('')
    })
  }

  // Bring a requested paper into view: show everything, open its card, scroll to it.
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
  const kinds = FILTERS.filter((f) => f.id === 'all' || docs.some((d) => d.kind === f.id))
  const filtering = kind !== 'all' || needle !== ''
  const allShownOn = rows.length > 0 && rows.every((d) => selected.has(d.id))

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
    <aside className={`panel library${wide ? ' wide' : ''}`}>
      <header className="lib-head">
        <div className="lib-title">
          <h2>Library</h2>
          <span className="muted">
            {docs.length} source{docs.length === 1 ? '' : 's'}
            {folders.length > 0 && ` · ${folders.length} folder${folders.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <button
          className="ghost lib-icon-btn"
          onClick={onToggleWide}
          title={wide ? 'Back to the compact panel' : 'Expand into a full library view'}
          aria-label={wide ? 'Collapse library' : 'Expand library'}
        >
          {wide ? '⤡' : '⤢'}
        </button>
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

      <section className="lib-add-box" aria-label="Add sources">
        <form className="lib-add" onSubmit={(e) => (e.preventDefault(), addSource())}>
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Paste a web link or a file path…"
            aria-label="Add a web page or local path"
          />
          <button className="primary" disabled={!!busy || !source.trim()}>
            Add
          </button>
        </form>
        {window.rc && (
          <div className="lib-pick">
            <span className="muted">or</span>
            <button className="ghost" onClick={addFiles} disabled={!!busy}>
              Choose files…
            </button>
            <button className="ghost" onClick={addDiskFolder} disabled={!!busy}>
              Import a folder…
            </button>
          </div>
        )}
        {busy && (
          <div className="lib-busy" role="status">
            <span className="bar" />
            {busy}
          </div>
        )}
      </section>

      <datalist id="folder-names">
        {folders.map((f) => (
          <option key={f.id} value={f.name} />
        ))}
      </datalist>

      <div className="lib-body">
        <nav className="lib-nav" aria-label="Folders">
          {wide && <div className="lib-nav-label">Browse</div>}
          {navItem('all', 'All sources', docs.length)}
          {unfiled > 0 && navItem('none', 'Unfiled', unfiled)}
          {wide && folders.length > 0 && <div className="lib-nav-label">Subject folders</div>}
          {folders.map((f) => navItem(f.id, f.name, f.doc_count, wide ? `${f.similarity}%` : undefined))}
          <button className="lib-nav-item lib-nav-new" onClick={() => setCreating((c) => !c)} title="Make a folder for a subject you choose">
            <span className="lib-nav-ico" aria-hidden="true">+</span>
            <span className="lib-nav-name">New folder</span>
          </button>
        </nav>

        <div className="lib-main">
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
            <div className="lib-tools">
              <div className="lib-search-row">
                <input
                  className="lib-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by title, author, keyword, JEL code…"
                  aria-label="Filter library"
                />
                <select
                  className="lib-sort"
                  aria-label="Sort"
                  value={`${sort.key}:${sort.dir}`}
                  onChange={(e) => {
                    const [key, dir] = e.target.value.split(':')
                    setSort({ key: key as SortKey, dir: Number(dir) as 1 | -1 })
                  }}
                >
                  <option value="name:1">Name A–Z</option>
                  <option value="name:-1">Name Z–A</option>
                  <option value="year:-1">Newest</option>
                  <option value="year:1">Oldest</option>
                  <option value="type:1">Type</option>
                  <option value="pages:-1">Longest</option>
                  {openFolder && <option value="match:-1">Best match</option>}
                </select>
              </div>
              {kinds.length > 2 && (
                <div className="lib-filters" role="group" aria-label="Filter by type">
                  {kinds.map((f) => (
                    <button key={f.id} className={kind === f.id ? 'chipbtn on' : 'chipbtn'} onClick={() => setKind(f.id)}>
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
              <div className={`lib-scope${selected.size ? ' some' : ''}`}>
                <span>
                  {selected.size === 0 ? (
                    'The Assistant drafts from all sources. Tick some to narrow it.'
                  ) : (
                    <>
                      Drafting from <b>{selected.size}</b> of {docs.length}
                    </>
                  )}
                </span>
                <span className="spacer" />
                {rows.length > 0 && (
                  <button className="link" onClick={() => toggleMany(rows)} title="Use every source shown for drafting">
                    {allShownOn ? 'Deselect shown' : `Select ${rows.length} shown`}
                  </button>
                )}
                {selected.size > 0 && (
                  <button className="link" onClick={() => toggleMany(docs.filter((d) => selected.has(d.id)))}>
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}

          <ul className="lib-docs">
            {rows.map((d) => (
              <DocCard
                key={d.id}
                doc={d}
                on={selected.has(d.id)}
                isOpen={open === d.id}
                folder={openFolder}
                onToggle={() => onToggle(d.id)}
                onOpen={() => setOpen(open === d.id ? null : d.id)}
                run={run}
              />
            ))}
          </ul>

          {docs.length === 0 && (
            <div className="lib-empty">
              <div className="lib-empty-title">Your library is empty</div>
              <p>Add the papers, notes, slides, scans and web pages you're writing from. They stay on this computer.</p>
              <ol>
                <li>Paste a link or path above, or choose files</li>
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
                    setQuery('')
                    setKind('all')
                  }}
                >
                  Clear filters
                </button>
              ) : (
                <p>Lower the similarity above to take in looser matches, or drag a paper onto the folder.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
