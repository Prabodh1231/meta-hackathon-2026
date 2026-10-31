import { useEffect, useState } from 'react'
import { api } from '../api'
import type { IndexWork, MissingWork, MissingWorks } from '../types'
import { Abstract } from './CitingPapersDialog'
import { FetchActions, fetchReason, useFetcher } from './fetching'

const TOP = 10 // "Download top N" fetches this many of the works not tried yet
const SHOWN_CITERS = 3

interface Props {
  initialQuery: string
  onOpenPaper: (docId: number) => void
  onChanged: () => Promise<void> // the library changed: reload it
  onClose: () => void
  onError: (msg: string) => void
}

const target = (w: MissingWork) => ({ key: w.id, docId: w.ref.doc_id, idx: w.ref.idx })
const searchable = (w: MissingWork) => !!w.doi || w.title.trim().split(/\s+/).length >= 4 // as the backend decides

/** The works the papers about a topic cite most that the library doesn't have, and free copies of
 *  them. "Most cited" counts the library's own papers: that's what says a work matters to this topic. */
export function MissingPapersDialog({ initialQuery, onOpenPaper, onChanged, onClose, onError }: Props) {
  const [query, setQuery] = useState(initialQuery) // what the user is typing
  const [topic, setTopic] = useState(initialQuery.trim()) // the search the list is showing
  const [data, setData] = useState<MissingWorks | null>(null)
  const [loading, setLoading] = useState(true)
  const [info, setInfo] = useState<Record<string, IndexWork>>({}) // by DOI: citations worldwide, abstract
  const fetcher = useFetcher(onChanged)

  useEffect(() => {
    const t = setTimeout(() => setTopic(query.trim()), 350) // wait for the typing to pause
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    let current = true
    setLoading(true)
    api.missingWorks(topic)
      .then((d) => current && setData(d))
      .catch((e) => onError(`Could not read the reference lists: ${e instanceof Error ? e.message : e}`))
      .finally(() => current && setLoading(false))
    return () => { current = false }
  }, [topic])

  // What OpenAlex knows about the works with a DOI: extra, so the list never waits for it.
  useEffect(() => {
    const dois = (data?.works ?? []).map((w) => w.doi.toLowerCase()).filter((d) => d && !info[d])
    if (!dois.length) return
    let current = true
    api.worksInfo(dois.slice(0, 200)).then((got) => current && setInfo((old) => ({ ...old, ...got }))).catch(() => {})
    return () => { current = false }
  }, [data])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const works = data?.works ?? []
  const todo = works.filter((w) => searchable(w) && !fetcher.results[w.id])
  const top = todo.slice(0, TOP)
  const open = (id: number) => { onOpenPaper(id); onClose() }
  const about = data?.query ? ` about “${data.query}”` : ''

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dupfiles cited" role="dialog" aria-modal="true" aria-labelledby="missing-title">
        <header className="modal-head">
          <div>
            <h2 id="missing-title">Most-cited papers you don't have</h2>
            <span className="muted">What the papers in your library cite most, among the works it doesn't hold</span>
          </div>
          <span className="spacer" />
          {fetcher.running ? (
            <button onClick={fetcher.stop}>Stop</button>
          ) : (
            <button className="primary" onClick={() => fetcher.fetchAll(top.map(target))} disabled={top.length === 0}
              title="Look for free copies of the most cited works not tried yet, and add them to your library">
              {top.length ? `Download top ${top.length}` : works.length ? 'All tried' : `Download top ${TOP}`}
            </button>
          )}
          <button className="icon" onClick={onClose} aria-label="Close most-cited papers">×</button>
        </header>

        <div className="missing-search">
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="A topic, e.g. financial literacy. Leave it empty for your whole library."
            aria-label="Topic"
          />
        </div>

        {data && (
          <section className="df-summary">
            <div className="df-stat">
              <b>{data.papers}</b>
              <span>{data.query ? `paper${data.papers === 1 ? '' : 's'}${about}` : 'papers searched, your whole library'}</span>
            </div>
            <div className="df-stat"><b>{data.total}</b><span>works they cite that you don't have</span></div>
            <div className="df-stat"><b>{data.cited_twice}</b><span>of those cited by two or more</span></div>
            <p className="muted df-scope">
              Ranked by how many of {data.query ? 'these papers' : 'your papers'} cite each work, read from their reference lists
              {data.with_refs < data.papers && ` (${data.papers - data.with_refs} had no list that could be read)`}. Downloads are
              free, legal copies only, found through OpenAlex and Semantic Scholar, and go into your library.
            </p>
          </section>
        )}

        {(loading || fetcher.running || fetcher.working > 0) && (
          <div className="lib-busy" role="status">
            <span className="bar" />
            {loading ? 'Reading reference lists…' : fetcher.running ? 'Finding free copies…' : 'Searching…'}
          </div>
        )}

        {data && !loading && works.length === 0 && (
          <div className="lib-empty">
            <div className="lib-empty-title">
              {data.papers === 0 ? `No paper in your library is${about}` : data.with_refs === 0 ? 'No reference lists to read' : 'Nothing missing'}
            </div>
            <p>
              {data.papers === 0
                ? 'Try another word, or leave the field empty to look across your whole library.'
                : data.with_refs === 0
                  ? 'None of these papers has a References or Bibliography section that could be read.'
                  : 'Every work these papers cite that could be identified is already in your library.'}
            </p>
          </div>
        )}

        <ol className="cited-list">
          {works.map((w, i) => {
            const st = fetcher.results[w.id] ?? null
            const more = w.citers.length - SHOWN_CITERS
            const about = w.doi ? info[w.doi.toLowerCase()] : undefined
            return (
              <li key={w.id} className="cited-item">
                <span className="missing-rank">{i + 1}</span>
                <div className="cited-main">
                  <div className="lib-doc-title">{w.title}</div>
                  <div className="lib-doc-by">{[w.first_author, w.year, w.doi && `doi:${w.doi}`].filter(Boolean).join(' · ')}</div>
                  <div className="missing-citers">
                    <b>Cited by {w.cited_by} of your papers:</b>{' '}
                    {w.citers.slice(0, SHOWN_CITERS).map((c, j) => (
                      <span key={c.id}>
                        {j > 0 && '; '}
                        <button className="link" onClick={() => open(c.id)} title="Open in library">{c.title}</button>
                      </span>
                    ))}
                    {more > 0 && <span className="muted"> and {more} more</span>}
                  </div>
                  {about?.cited_by_count != null && (
                    <div className="muted cited-count">Cited {about.cited_by_count.toLocaleString()} times worldwide</div>
                  )}
                  <Abstract text={about?.abstract ?? ''} />
                  {fetchReason(st) && <div className="cited-reason">{fetchReason(st)}</div>}
                </div>
                <FetchActions
                  state={st}
                  searchable={searchable(w)}
                  searchFor={w.title}
                  disabled={fetcher.running}
                  onFetch={() => fetcher.fetchOne(target(w))}
                  onOpenPaper={open}
                />
              </li>
            )
          })}
        </ol>
        {data && data.total > works.length && (
          <p className="muted missing-foot">Showing the {works.length} most cited of {data.total}.</p>
        )}
      </div>
    </div>
  )
}
