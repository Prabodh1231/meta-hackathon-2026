import { useState } from 'react'
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

export function LibraryPanel({ docs, topics, selected, onToggle, onChanged, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [path, setPath] = useState('')
  const [renaming, setRenaming] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

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

  const addPath = () =>
    run('Reading…', async () => {
      reportFailures((await api.ingestPath(path.trim())).results)
      setPath('')
    })

  const addUrl = () =>
    run('Fetching page…', async () => {
      await api.ingestUrl(url.trim())
      setUrl('')
    })

  const groups: { topic: Topic | null; docs: Doc[] }[] = [
    ...topics.map((t) => ({ topic: t, docs: docs.filter((d) => d.topic_id === t.id) })),
    { topic: null, docs: docs.filter((d) => d.topic_id == null || !topics.some((t) => t.id === d.topic_id)) },
  ].filter((g) => g.docs.length || g.topic)

  return (
    <aside className="panel library">
      <header className="panel-head">
        <h2>Library</h2>
        <span className="muted">{docs.length} docs</span>
      </header>

      <div className="add-row">
        {window.rc ? (
          <>
            <button onClick={addFiles} disabled={!!busy}>+ Files</button>
            <button onClick={addFolder} disabled={!!busy}>+ Folder</button>
          </>
        ) : (
          <form className="inline-form" onSubmit={(e) => (e.preventDefault(), path.trim() && addPath())}>
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Local file or folder path" />
            <button disabled={!!busy || !path.trim()}>Add</button>
          </form>
        )}
      </div>
      <form className="inline-form" onSubmit={(e) => (e.preventDefault(), url.trim() && addUrl())}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… web page" />
        <button disabled={!!busy || !url.trim()}>Add</button>
      </form>

      <div className="topic-bar">
        <button onClick={() => run('Organizing…', api.rebuildTopics)} disabled={!!busy || docs.length === 0}>
          {topics.length ? 'Re-organize topics' : 'Organize into topics'}
        </button>
        {selected.size > 0 && <span className="muted">{selected.size} selected as draft scope</span>}
      </div>
      {busy && <div className="busy">{busy}</div>}

      <div className="topic-list">
        {groups.map(({ topic, docs: members }) => {
          const key = topic?.id ?? -1
          const isCollapsed = collapsed.has(key)
          return (
            <section key={key} className="topic">
              <div className="topic-head">
                <button
                  className="twisty"
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
                    className="topic-label"
                    title={topic ? `${topic.description}\nDouble-click to rename` : ''}
                    onDoubleClick={() => topic && setRenaming(topic.id)}
                  >
                    {topic?.label ?? 'Unsorted'}
                  </span>
                )}
                <span className="count">{members.length}</span>
                {topic && topics.length > 1 && (
                  <select
                    className="merge"
                    value=""
                    title="Merge this topic into another"
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
                  {members.map((d) => (
                    <li key={d.id} className={selected.has(d.id) ? 'doc selected' : 'doc'}>
                      <label>
                        <input type="checkbox" checked={selected.has(d.id)} onChange={() => onToggle(d.id)} />
                        <span className="doc-text">
                          <span className="doc-title" title={d.summary}>{d.title}</span>
                          <span className="doc-meta">
                            <span className={`kind kind-${d.kind}`}>{d.kind}</span> {d.label}
                          </span>
                          {d.tags.length > 0 && (
                            <span className="tags">
                              {d.tags.map((t) => (
                                <span key={t} className="tag">{t}</span>
                              ))}
                            </span>
                          )}
                        </span>
                      </label>
                      <button
                        className="icon"
                        title="Remove from library"
                        onClick={() => run('Removing…', () => api.deleteDocument(d.id))}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
        {docs.length === 0 && (
          <p className="empty">Add papers, notes, slides, scans or web pages to build your knowledge base.</p>
        )}
      </div>
    </aside>
  )
}
