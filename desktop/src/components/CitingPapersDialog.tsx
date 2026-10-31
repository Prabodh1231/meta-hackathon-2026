import { useEffect, useState } from 'react'
import { api } from '../api'
import type { CitingWorks } from '../types'
import { FetchActions, type FetchState, fetchReason, useFetcher } from './fetching'

interface Props {
  docId: number
  onOpenPaper: (docId: number) => void
  onChanged: () => Promise<void> // the library changed: reload it
  onClose: () => void
  onError: (msg: string) => void
}

type Work = CitingWorks['works'][number]

const count = (n: number) => n.toLocaleString()

/** An abstract, cut to a few lines until it's opened. */
export function Abstract({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className={`abstract${open ? ' open' : ''}`}>
      <p>{text}</p>
      {text.length > 280 && (
        <button className="link" onClick={() => setOpen((o) => !o)}>{open ? 'Less' : 'Whole abstract'}</button>
      )}
    </div>
  )
}

/** Newer works that cite a library paper, as OpenAlex knows them: the most cited first, or the
 *  newest. Free, legal copies can be added to the library like a cited paper's. */
export function CitingPapersDialog({ docId, onOpenPaper, onChanged, onClose, onError }: Props) {
  const [sort, setSort] = useState<'cited' | 'recent'>('cited')
  const [data, setData] = useState<CitingWorks | null>(null)
  const [loading, setLoading] = useState(true)
  const fetcher = useFetcher(onChanged)

  useEffect(() => {
    let current = true
    setLoading(true)
    api.citingWorks(docId, sort)
      .then((d) => current && setData(d))
      .catch((e) => {
        onError(`Could not list the papers citing it: ${e instanceof Error ? e.message : e}`)
        onClose()
      })
      .finally(() => current && setLoading(false))
    return () => { current = false }
  }, [docId, sort])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const works = data?.works ?? []
  const stateOf = (w: Work): FetchState | null =>
    fetcher.results[w.openalex_id] ?? (w.in_library != null ? { status: 'in_library', doc_id: w.in_library } : null)
  const target = (w: Work) => ({ key: w.openalex_id, work: { title: w.title, doi: w.doi, year: w.year, first_author: w.first_author } })
  const open = (id: number) => { onOpenPaper(id); onClose() }
  const inLibrary = works.filter((w) => {
    const st = stateOf(w)
    return st && st !== 'working' && (st.status === 'in_library' || st.status === 'downloaded')
  }).length

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dupfiles cited" role="dialog" aria-modal="true" aria-labelledby="citing-title">
        <header className="modal-head">
          <div>
            <h2 id="citing-title">Papers citing this</h2>
            <span className="muted">{data ? `Works that cite “${data.title}”` : 'Asking OpenAlex…'}</span>
          </div>
          <span className="spacer" />
          <div className="segmented tl-seg" role="group" aria-label="Order">
            <button className={sort === 'cited' ? 'active' : ''} onClick={() => setSort('cited')}>Most cited</button>
            <button className={sort === 'recent' ? 'active' : ''} onClick={() => setSort('recent')}>Newest</button>
          </div>
          <button className="icon" onClick={onClose} aria-label="Close papers citing this">×</button>
        </header>

        {data?.found && (
          <section className="df-summary">
            <div className="df-stat"><b>{count(data.total)}</b><span>works cite it, as OpenAlex counts them</span></div>
            <div className="df-stat"><b>{inLibrary}</b><span>of those shown are in your library</span></div>
            <p className="muted df-scope">
              {data.total > works.length ? `The ${works.length} ${sort === 'cited' ? 'most cited' : 'newest'} are listed. ` : ''}
              Free, legal copies are found through OpenAlex and Semantic Scholar (and CORE, with your key), and go into your library.
            </p>
          </section>
        )}

        {(loading || fetcher.working > 0) && (
          <div className="lib-busy" role="status">
            <span className="bar" />
            {loading ? 'Asking OpenAlex…' : 'Finding a free copy…'}
          </div>
        )}

        {data && !loading && (!data.found || works.length === 0) && (
          <div className="lib-empty">
            <div className="lib-empty-title">{data.found ? 'No citing works yet' : 'Not in OpenAlex'}</div>
            <p>
              {data.found
                ? "OpenAlex knows this paper but no work citing it. New citations show up as they're indexed."
                : "OpenAlex couldn't find this paper by its DOI or title. Check them under Edit details, then try again."}
            </p>
          </div>
        )}

        <ol className="cited-list">
          {works.map((w) => {
            const st = stateOf(w)
            return (
              <li key={w.openalex_id} className="cited-item">
                <div className="cited-main">
                  <div className="lib-doc-title">{w.title}</div>
                  <div className="lib-doc-by">
                    {[w.authors.length > 2 ? `${w.authors[0]} et al.` : w.authors.join(', '), w.year, w.venue].filter(Boolean).join(' · ')}
                  </div>
                  {w.cited_by_count != null && <div className="muted cited-count">Cited {count(w.cited_by_count)} times</div>}
                  <Abstract text={w.abstract} />
                  {fetchReason(st) && <div className="cited-reason">{fetchReason(st)}</div>}
                </div>
                <FetchActions
                  state={st}
                  searchable={!!w.doi || w.title.trim().split(/\s+/).length >= 4}
                  searchFor={w.title}
                  disabled={false}
                  onFetch={() => fetcher.fetchOne(target(w))}
                  onOpenPaper={open}
                />
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
