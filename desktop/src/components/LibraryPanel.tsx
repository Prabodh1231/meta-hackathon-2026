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
  { id: 'all', label: 'All' },
  { id: 'pdf', label: 'PDF' },
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

/** The folders a document is filed under. Editable: take it out of one, or add it to another. */
function FolderChips({ doc: d, editable, run }: { doc: Doc; editable: boolean; run: Run }) {
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

function SimilaritySlider({
  value,
  onChange,
  disabled,
}: {
  value: number
  onChange: (v: number) => void
  disabled?: boolean
}) {
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

/** Shown inside an opened folder: how closely a paper has to match to be filed here. */
function FolderBar({ folder, run }: { folder: Folder; run: Run }) {
  const [value, setValue] = useState(folder.similarity)
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
    <div className="fm-folderbar">
      <SimilaritySlider value={value} onChange={change} />
      <span className="muted">
        Papers matching {value}% or more are filed here. What you add or remove by hand is kept.
      </span>
    </div>
  )
}

type SortKey = 'name' | 'type' | 'year' | 'pages'
type Scope = 'all' | 'none' | number // every file, files with no folder, or one folder

export function LibraryPanel({ docs, folders, wide, onToggleWide, selected, onToggle, onChanged, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | Doc['kind']>('all')
  const [renaming, setRenaming] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<number | null>(null) // doc whose summary is showing
  const [confirming, setConfirming] = useState<number | null>(null)
  const [deletingFolder, setDeletingFolder] = useState<number | null>(null)
  const [scope, setScope] = useState<Scope>('all') // the folder that is open
  const [picked, setPicked] = useState<Scope | null>(null) // the folder tile that is highlighted
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

  const addFiles = () =>
    run('Adding files…', async () => {
      const files = (await window.rc?.pickFiles()) ?? []
      for (const f of files) reportFailures((await api.ingestPath(f)).results)
    })

  const addFolder = () =>
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

  const needle = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      docs.filter(
        (d) =>
          (kind === 'all' || d.kind === kind) &&
          (!needle || `${d.title} ${d.authors.join(' ')} ${d.venue} ${d.tags.join(' ')} ${d.summary}`.toLowerCase().includes(needle)),
      ),
    [docs, kind, needle],
  )
  useEffect(() => {
    if (typeof scope === 'number' && !folders.some((f) => f.id === scope)) setScope('all') // the open folder was deleted
  }, [folders, scope])
  const openFolder = typeof scope === 'number' ? folders.find((f) => f.id === scope) : undefined
  const filtering = kind !== 'all' || needle !== ''

  // A document sits in every folder it was filed under; the rest go to Unfiled.
  const groups: { folder: Folder | null; docs: Doc[] }[] = [
    ...folders.map((f) => ({ folder: f, docs: visible.filter((d) => d.folders.some((x) => x.id === f.id)) })),
    { folder: null, docs: visible.filter((d) => d.folders.length === 0) },
  ].filter((g) => g.docs.length > 0 || (g.folder && !filtering))

  // File-manager view: the files of the folder picked in the sidebar, sorted by a column.
  const rows = useMemo(() => {
    const inScope = visible.filter((d) =>
      scope === 'all' ? true : scope === 'none' ? d.folders.length === 0 : d.folders.some((f) => f.id === scope),
    )
    const value = (d: Doc) =>
      sort.key === 'name' ? d.title.toLowerCase() : sort.key === 'type' ? d.kind : sort.key === 'year' ? (d.year ?? 0) : d.page_count
    return [...inScope].sort((a, b) => (value(a) > value(b) ? 1 : value(a) < value(b) ? -1 : 0) * sort.dir)
  }, [visible, scope, sort])
  const unfiled = docs.filter((d) => d.folders.length === 0).length
  const scopeName = scope === 'all' ? 'All files' : scope === 'none' ? 'Unfiled' : (folders.find((f) => f.id === scope)?.name ?? 'All files')

  const toggleMany = (members: Doc[]) => {
    const allOn = members.every((d) => selected.has(d.id))
    for (const d of members) if (allOn === selected.has(d.id)) onToggle(d.id)
  }

  return (
    <aside className={`panel library${wide ? ' wide' : ''}`}>
      <header className="lib-head">
        <div>
          <h2>Library</h2>
          <span className="muted">
            {docs.length} source{docs.length === 1 ? '' : 's'}
            {folders.length > 0 && ` · ${folders.length} folder${folders.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <button
          className="ghost"
          onClick={onToggleWide}
          title={wide ? 'Back to the compact list' : 'Open as a file manager'}
          aria-label={wide ? 'Collapse library' : 'Expand library'}
        >
          {wide ? '⤡' : '⤢'}
        </button>
        <button className="ghost" onClick={() => setCreating((c) => !c)} title="Make a folder for a subject you choose">
          + Folder
        </button>
        {folders.length > 0 && (
          <button
            className="ghost"
            onClick={() => run('Re-scoring papers…', api.classifyFolders)}
            disabled={!!busy || docs.length === 0}
            title="Score every paper against your folders again. Your own additions and removals are kept."
          >
            Re-sort
          </button>
        )}
      </header>

      <form className="lib-add" onSubmit={(e) => (e.preventDefault(), addSource())}>
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Paste a web link or file path…"
          aria-label="Add a web page or local path"
        />
        <button className="primary" disabled={!!busy || !source.trim()}>
          Add
        </button>
      </form>
      {window.rc && (
        <div className="lib-pick">
          <button onClick={addFiles} disabled={!!busy}>
            + Files
          </button>
          <button onClick={addFolder} disabled={!!busy}>
            + Folder
          </button>
        </div>
      )}
      {busy && (
        <div className="lib-busy" role="status">
          <span className="bar" />
          {busy}
        </div>
      )}

      {creating && (
        <NewFolderForm
          onCancel={() => setCreating(false)}
          onCreate={(name, similarity) => {
            setCreating(false)
            run('Creating folder…', () => api.createFolder(name, similarity))
          }}
        />
      )}

      {docs.length > 0 && (
        <>
          <input
            className="lib-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title, author, tag…"
            aria-label="Filter library"
          />
          <div className="lib-filters" role="group" aria-label="Filter by type">
            {FILTERS.filter((f) => f.id === 'all' || docs.some((d) => d.kind === f.id)).map((f) => (
              <button key={f.id} className={kind === f.id ? 'chipbtn on' : 'chipbtn'} onClick={() => setKind(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="lib-scope">
            {selected.size === 0 ? (
              <span>Drafting from all sources</span>
            ) : (
              <>
                <span>
                  Drafting from <b>{selected.size}</b> of {docs.length}
                </span>
                <button className="link" onClick={() => toggleMany(docs.filter((d) => selected.has(d.id)))}>
                  Clear
                </button>
              </>
            )}
          </div>
        </>
      )}

      <datalist id="folder-names">
        {folders.map((f) => (
          <option key={f.id} value={f.name} />
        ))}
      </datalist>
      {wide ? (
        <div className="fm">
          <div className="fm-crumb">
            <button className="link" onClick={() => setScope('all')} disabled={scope === 'all'}>
              Library
            </button>
            {scope !== 'all' && (
              <>
                <span className="muted">›</span>
                <b>{scopeName}</b>
              </>
            )}
            <span className="muted">
              {rows.length} file{rows.length === 1 ? '' : 's'}
            </span>
            <span className="spacer" />
            {rows.length > 0 && (
              <button className="link" onClick={() => toggleMany(rows)} title="Use every file shown as the draft scope">
                {rows.every((d) => selected.has(d.id)) ? 'Deselect all' : 'Select all'}
              </button>
            )}
            <label className="fm-sort">
              Sort
              <select
                value={`${sort.key}:${sort.dir}`}
                onChange={(e) => {
                  const [key, dir] = e.target.value.split(':')
                  setSort({ key: key as SortKey, dir: Number(dir) as 1 | -1 })
                }}
              >
                <option value="name:1">Name A–Z</option>
                <option value="name:-1">Name Z–A</option>
                <option value="year:-1">Newest first</option>
                <option value="year:1">Oldest first</option>
                <option value="type:1">Type</option>
                <option value="pages:-1">Longest first</option>
              </select>
            </label>
          </div>

          <div className="fm-scroll">
            {openFolder && <FolderBar folder={openFolder} run={run} />}
            {scope === 'all' && (
              <>
            <div className="fm-tiles" aria-label="Folders">
              {(
                [
                  ...folders.map((f) => [f.id, f.name, f.doc_count] as [Scope, string, number]),
                  ...(unfiled > 0 ? [['none', 'Unfiled', unfiled] as [Scope, string, number]] : []),
                ] as [Scope, string, number][]
              ).map(([id, name, count]) => {
                const folder = typeof id === 'number' ? folders.find((f) => f.id === id) : undefined
                const members = docs.filter((d) => (folder ? d.folders.some((x) => x.id === folder.id) : d.folders.length === 0))
                return (
                  <div
                    key={id}
                    className={`fm-tile${picked === id ? ' on' : ''}${dropOn === id ? ' drop' : ''}`}
                    tabIndex={0}
                    title="Double-click to open"
                    onClick={() => setPicked(id)}
                    onDoubleClick={() => setScope(id)}
                    onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && setScope(id)}
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
                    <div className="fm-tile-top">
                      <span className="fm-ico" aria-hidden>
                        {picked === id ? '📂' : '📁'}
                      </span>
                      <span className="count">{count}</span>
                      {folder && (
                        <button
                          className="icon folder-delete"
                          title="Rename this folder"
                          aria-label={`Rename folder ${folder.name}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setRenaming(folder.id)
                          }}
                        >
                          ✎
                        </button>
                      )}
                      {folder &&
                        (deletingFolder === folder.id ? (
                          <span className="lib-confirm-inline" onClick={(e) => e.stopPropagation()}>
                            <button
                              className="danger"
                              onClick={() => {
                                setDeletingFolder(null)
                                run('Deleting folder…', () => api.deleteFolder(folder.id))
                              }}
                            >
                              Delete
                            </button>
                            <button onClick={() => setDeletingFolder(null)}>Keep</button>
                          </span>
                        ) : (
                          <button
                            className="icon folder-delete"
                            title="Delete this folder (the sources stay in your library)"
                            aria-label={`Delete folder ${folder.name}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              setDeletingFolder(folder.id)
                            }}
                          >
                            ×
                          </button>
                        ))}
                    </div>
                    {folder && renaming === folder.id ? (
                      <input
                        autoFocus
                        defaultValue={folder.name}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => setRenaming(null)}
                        onKeyDown={(e) => {
                          const value = e.currentTarget.value.trim()
                          if (e.key === 'Escape') setRenaming(null)
                          if (e.key === 'Enter' && value) {
                            setRenaming(null)
                            run('Renaming…', () => api.updateFolder(folder.id, { name: value }))
                          }
                        }}
                      />
                    ) : (
                      <div className="fm-tile-name">{name}</div>
                    )}
                    <div className="fm-tile-peek">
                      {folder ? `${folder.similarity}% similarity` : ''}
                      {members.length > 0 && ` · ${members[0].title}`}
                    </div>
                  </div>
                )
              })}
              <button className="fm-tile fm-new" onClick={() => setCreating(true)}>
                + New folder
              </button>
            </div>
            <p className="fm-hint">
              {folders.length > 0
                ? 'Double-click a folder to open it. Drag a file onto a folder to file it there; it stays in its other folders too.'
                : 'Make a folder for a subject you work on, like Digital finance. Papers that match it are filed in automatically.'}
            </p>
              </>
            )}

            <div className="fm-grid">
              {rows.map((d) => {
                const on = selected.has(d.id)
                const isOpen = open === d.id
                return (
                  <div
                    key={d.id}
                    className={`fm-card${on ? ' on' : ''}${isOpen ? ' open' : ''}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', String(d.id))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={() => setOpen(isOpen ? null : d.id)}
                  >
                    <div className="fm-card-top">
                      <span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind]}</span>
                      {d.page_count > 1 && <span className="muted">{d.page_count} pp</span>}
                      {openFolder && (
                        <span className="muted">
                          {(() => {
                            const f = d.folders.find((x) => x.id === openFolder.id)
                            return f?.state === 'user' ? 'added by you' : f?.score != null ? `${f.score}% match` : ''
                          })()}
                        </span>
                      )}
                      <span className="spacer" />
                      <label className="pick" title="Use this source for drafting" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={on} onChange={() => onToggle(d.id)} />
                      </label>
                    </div>
                    <div className="fm-card-title">{d.title}</div>
                    {byline(d) && <div className="lib-card-by">{byline(d)}</div>}
                    {isOpen ? (
                      <div onClick={(e) => e.stopPropagation()}>
                        {d.summary && <p className="lib-card-summary">{d.summary}</p>}
                        <FolderChips doc={d} editable run={run} />
                        {d.tags.length > 0 && (
                          <div className="tags">
                            {d.tags.map((t) => (
                              <span key={t} className="tag">
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="fm-actions">
                          {confirming === d.id ? (
                            <>
                              <button
                                className="danger"
                                onClick={() => {
                                  setConfirming(null)
                                  run('Removing…', () => api.deleteDocument(d.id))
                                }}
                              >
                                Remove from library
                              </button>
                              <button onClick={() => setConfirming(null)}>Keep</button>
                            </>
                          ) : (
                            <button className="link" onClick={() => setConfirming(d.id)}>
                              Remove from library
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <FolderChips doc={d} editable={false} run={run} />
                    )}
                  </div>
                )
              })}
            </div>
            {docs.length > 0 && rows.length === 0 && <div className="lib-empty">Nothing here. Try another folder or clear the filters.</div>}
            {docs.length === 0 && <div className="lib-empty">Your library is empty. Add files, a folder or a web link above.</div>}
          </div>
        </div>
      ) : (
      <div className="lib-list">
        {groups.map(({ folder, docs: members }) => {
          const key = folder?.id ?? -1
          const isCollapsed = collapsed.has(key) && !filtering
          const picked = members.filter((d) => selected.has(d.id)).length
          return (
            <section key={key} className="lib-group">
              <div className="lib-group-head">
                <button
                  className="twisty"
                  aria-label={isCollapsed ? 'Expand folder' : 'Collapse folder'}
                  onClick={() =>
                    setCollapsed((s) => {
                      const n = new Set(s)
                      n.has(key) ? n.delete(key) : n.add(key)
                      return n
                    })
                  }
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
                {folder && renaming === folder.id ? (
                  <input
                    autoFocus
                    defaultValue={folder.name}
                    onBlur={() => setRenaming(null)}
                    onKeyDown={(e) => {
                      const value = e.currentTarget.value.trim()
                      if (e.key === 'Escape') setRenaming(null)
                      if (e.key === 'Enter' && value) {
                        setRenaming(null)
                        run('Renaming…', () => api.updateFolder(folder.id, { name: value }))
                      }
                    }}
                  />
                ) : (
                  <span
                    className="lib-group-label"
                    title={folder ? 'Double-click to rename' : 'Not in a folder yet'}
                    onDoubleClick={() => folder && setRenaming(folder.id)}
                  >
                    {folder?.name ?? 'Unfiled'}
                  </span>
                )}
                <span className="count">{members.length}</span>
                {members.length > 0 && (
                  <button
                    className="link"
                    onClick={() => toggleMany(members)}
                    title="Use every source in this folder as the draft scope"
                  >
                    {picked === members.length ? 'Deselect' : 'Select all'}
                  </button>
                )}
                {folder &&
                  (deletingFolder === folder.id ? (
                    <span className="lib-confirm-inline">
                      <button
                        className="danger"
                        onClick={() => {
                          setDeletingFolder(null)
                          run('Deleting folder…', () => api.deleteFolder(folder.id))
                        }}
                      >
                        Delete folder
                      </button>
                      <button onClick={() => setDeletingFolder(null)}>Keep</button>
                    </span>
                  ) : (
                    <button
                      className="icon folder-delete"
                      title="Delete this folder (the sources stay in your library)"
                      aria-label={`Delete folder ${folder.name}`}
                      onClick={() => setDeletingFolder(folder.id)}
                    >
                      ×
                    </button>
                  ))}
              </div>
              {!isCollapsed && (
                <ul>
                  {members.map((d) => {
                    const on = selected.has(d.id)
                    return (
                      <li key={d.id} className={`lib-card${on ? ' on' : ''}`}>
                        <label className="pick" title="Use this source for drafting">
                          <input type="checkbox" checked={on} onChange={() => onToggle(d.id)} />
                        </label>
                        <div className="lib-card-body" onClick={() => setOpen(open === d.id ? null : d.id)}>
                          <div className="lib-card-top">
                            <span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind]}</span>
                            {d.page_count > 1 && <span className="muted">{d.page_count} pp</span>}
                          </div>
                          <div className="lib-card-title">{d.title}</div>
                          {byline(d) && <div className="lib-card-by">{byline(d)}</div>}
                          <FolderChips doc={d} editable={open === d.id} run={run} />
                          {open === d.id && d.tags.length > 0 && (
                            <div className="tags">
                              {d.tags.map((t) => (
                                <span key={t} className="tag">
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                          {open === d.id && d.summary && <p className="lib-card-summary">{d.summary}</p>}
                        </div>
                        {confirming === d.id ? (
                          <div className="lib-confirm">
                            <button
                              className="danger"
                              onClick={() => {
                                setConfirming(null)
                                run('Removing…', () => api.deleteDocument(d.id))
                              }}
                            >
                              Remove
                            </button>
                            <button onClick={() => setConfirming(null)}>Keep</button>
                          </div>
                        ) : (
                          <button
                            className="icon lib-remove"
                            title="Remove from library"
                            aria-label={`Remove ${d.title}`}
                            onClick={() => setConfirming(d.id)}
                          >
                            ×
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}

        {docs.length === 0 && (
          <div className="lib-empty">
            <div className="lib-empty-title">Your library is empty</div>
            <p>Add the papers, notes, slides, scans and web pages you're writing from. They stay on this computer.</p>
            <ol>
              <li>Paste a link or path above, or use + Files / + Folder</li>
              <li>Muse reads each one and writes a summary and tags</li>
              <li>Make a folder for each subject (+ Folder); matching papers are filed in, as many folders as fit</li>
            </ol>
          </div>
        )}
        {docs.length > 0 && visible.length === 0 && (
          <div className="lib-empty">
            <div className="lib-empty-title">No matches</div>
            <button
              className="link"
              onClick={() => {
                setQuery('')
                setKind('all')
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
      )}
    </aside>
  )
}
