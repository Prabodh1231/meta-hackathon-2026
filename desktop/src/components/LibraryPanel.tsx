import { useMemo, useState } from 'react'
import { api } from '../api'
import type { Doc, IngestResult, Topic } from '../types'

interface Props {
  docs: Doc[]
  topics: Topic[]
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

export function LibraryPanel({ docs, topics, selected, onToggle, onChanged, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | Doc['kind']>('all')
  const [renaming, setRenaming] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<number | null>(null) // doc whose summary is showing
  const [confirming, setConfirming] = useState<number | null>(null)

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
  const filtering = kind !== 'all' || needle !== ''

  const groups: { topic: Topic | null; docs: Doc[] }[] = [
    ...topics.map((t) => ({ topic: t, docs: visible.filter((d) => d.topic_id === t.id) })),
    { topic: null, docs: visible.filter((d) => d.topic_id == null || !topics.some((t) => t.id === d.topic_id)) },
  ].filter((g) => (filtering ? g.docs.length > 0 : g.docs.length > 0 || g.topic))

  const toggleMany = (members: Doc[]) => {
    const allOn = members.every((d) => selected.has(d.id))
    for (const d of members) if (allOn === selected.has(d.id)) onToggle(d.id)
  }

  return (
    <aside className="panel library">
      <header className="lib-head">
        <div>
          <h2>Library</h2>
          <span className="muted">
            {docs.length} source{docs.length === 1 ? '' : 's'}
            {topics.length > 0 && ` · ${topics.length} topic${topics.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <button
          className="ghost"
          onClick={() => run('Organizing…', api.rebuildTopics)}
          disabled={!!busy || docs.length === 0}
          title="Group sources into topics automatically"
        >
          {topics.length ? 'Re-organize' : 'Organize'}
        </button>
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

      <div className="lib-list">
        {groups.map(({ topic, docs: members }) => {
          const key = topic?.id ?? -1
          const isCollapsed = collapsed.has(key) && !filtering
          const picked = members.filter((d) => selected.has(d.id)).length
          return (
            <section key={key} className="lib-group">
              <div className="lib-group-head">
                <button
                  className="twisty"
                  aria-label={isCollapsed ? 'Expand topic' : 'Collapse topic'}
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
                {topic && renaming === topic.id ? (
                  <input
                    autoFocus
                    defaultValue={topic.label}
                    onBlur={() => setRenaming(null)}
                    onKeyDown={(e) => {
                      const value = e.currentTarget.value.trim()
                      if (e.key === 'Escape') setRenaming(null)
                      if (e.key === 'Enter' && value) {
                        setRenaming(null)
                        run('Renaming…', () => api.renameTopic(topic.id, value))
                      }
                    }}
                  />
                ) : (
                  <span
                    className="lib-group-label"
                    title={topic ? `${topic.description}\nDouble-click to rename` : 'Not in a topic yet'}
                    onDoubleClick={() => topic && setRenaming(topic.id)}
                  >
                    {topic?.label ?? 'Unsorted'}
                  </span>
                )}
                <span className="count">{members.length}</span>
                {members.length > 0 && (
                  <button
                    className="link"
                    onClick={() => toggleMany(members)}
                    title="Use every source in this topic as the draft scope"
                  >
                    {picked === members.length ? 'Deselect' : 'Select all'}
                  </button>
                )}
                {topic && topics.length > 1 && (
                  <select
                    className="merge"
                    value=""
                    title="Merge this topic into another"
                    aria-label="Merge topic"
                    onChange={(e) => run('Merging…', () => api.mergeTopics([topic.id], Number(e.target.value)))}
                  >
                    <option value="">Merge…</option>
                    {topics
                      .filter((t) => t.id !== topic.id)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          into {t.label}
                        </option>
                      ))}
                  </select>
                )}
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
                          {d.tags.length > 0 && (
                            <div className="tags">
                              {d.tags.slice(0, open === d.id ? d.tags.length : 3).map((t) => (
                                <span key={t} className="tag">
                                  {t}
                                </span>
                              ))}
                              {open !== d.id && d.tags.length > 3 && <span className="tag">+{d.tags.length - 3}</span>}
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
              <li>Organize groups them into topics</li>
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
    </aside>
  )
}
