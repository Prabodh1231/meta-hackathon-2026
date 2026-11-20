import { useEffect, useState } from 'react'
import { api } from '../api'
import type { NewArrivals } from '../types'
import { Abstract } from './CitingPapersDialog'
import { FetchActions, type FetchState, fetchReason, useFetcher } from './fetching'

interface Props {
  folderId: number
  onOpenPaper: (docId: number) => void
  onChanged: () => Promise<void> // the library changed: reload it
  onClose: () => void
  onError: (msg: string) => void
}

type Work = NewArrivals['works'][number]

const ago = (at: string) => {
  const mins = Math.round((Date.now() - Date.parse(at.replace(' ', 'T') + 'Z')) / 60000)
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`
}

/** What's new in a topic: recent works outside the library that cite its papers, the ones citing
 *  more of the topic first. Asked for on demand (one OpenAlex request per 50 papers, kept a few
 *  hours), never just because the topic was opened. A free copy goes into the library and the topic. */
export function TopicNewArrivalsDialog({ folderId, onOpenPaper, onChanged, onClose, onError }: Props) {
  const [data, setData] = useState<NewArrivals | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState('')
  const [lookingUp, setLookingUp] = useState(false)
  const fetcher = useFetcher(onChanged)

  const load = (refresh: boolean) => {
    setLoading(true)
    setProblem('')
    return api
      .topicNewArrivals(folderId, refresh)
      .then(setData)
      .catch((e) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    load(false)
  }, [folderId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const lookUp = async () => {
    if (!data) return
    setLookingUp(true)
    try {
      await api.enrich(data.not_looked_up, true)
      await onChanged().catch(() => {})
      await load(true)
    } catch (e) {
      onError(`Could not look the papers up: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLookingUp(false)
    }
  }

  const works = data?.works ?? []
  const target = (w: Work) => ({
    key: w.openalex_id,
    work: { title: w.title, doi: w.doi, year: w.year, first_author: w.first_author, folder_id: folderId },
  })
  const searchable = (w: Work) => !!w.doi || w.title.trim().split(/\s+/).length >= 4
  const waiting = works.filter((w) => !fetcher.results[w.openalex_id] && searchable(w))
  const open = (id: number) => {
    onOpenPaper(id)
    onClose()
  }
  const name = data?.name ?? 'this topic'
  const notLooked = data?.not_looked_up.length ?? 0

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dupfiles cited" role="dialog" aria-modal="true" aria-labelledby="new-arrivals-title">
        <header className="modal-head">
          <div>
            <h2 id="new-arrivals-title">What's new in {name}</h2>
            <span className="muted">
              Recent works that cite this topic's papers and aren't in your library.
              {data?.checked_at && ` Checked ${ago(data.checked_at)} from OpenAlex.`}
            </span>
          </div>
          <span className="spacer" />
          <button className="link" onClick={() => load(true)} disabled={loading}>
            Check again
          </button>
          <button className="icon" onClick={onClose} aria-label="Close what's new">
            ×
          </button>
        </header>

        {data && notLooked > 0 && (
          <div className="na-note">
            <span>
              {notLooked} of this topic's {data.papers} papers {notLooked === 1 ? "hasn't" : "haven't"} been looked up in the index yet, so works
              citing {notLooked === 1 ? 'it' : 'them'} can't be found.
            </span>
            <button onClick={lookUp} disabled={lookingUp}>
              {lookingUp ? 'Looking up…' : 'Look them up'}
            </button>
          </div>
        )}
        {data?.capped && (
          <p className="muted na-scope">
            A large topic: asked about its {data.asked} most-cited papers of {data.known} in OpenAlex.
          </p>
        )}

        {(loading || fetcher.working > 0) && (
          <div className="lib-busy" role="status">
            <span className="bar" />
            {loading ? `Asking OpenAlex about ${data?.asked || 'its'} papers…` : 'Finding a free copy…'}
          </div>
        )}

        {problem && !loading && (
          <div className="lib-empty">
            <div className="lib-empty-title">Couldn't reach OpenAlex</div>
            <p>
              Check your connection and try again. <button className="link" onClick={() => load(true)}>Try again</button>
            </p>
          </div>
        )}

        {data && !loading && !problem && works.length === 0 && (
          <div className="lib-empty">
            <div className="lib-empty-title">{data.asked ? 'Nothing new' : 'Nothing to ask about yet'}</div>
            <p>
              {data.asked
                ? "No works outside your library cite this topic's papers yet. New citations show up as OpenAlex indexes them."
                : data.not_in_index && !notLooked
                  ? "OpenAlex doesn't know this topic's papers, so works citing them can't be found."
                  : "None of this topic's papers has been looked up in OpenAlex yet."}
            </p>
          </div>
        )}

        <ol className="cited-list">
          {works.map((w) => {
            const st: FetchState | null = fetcher.results[w.openalex_id] ?? null
            const n = w.cites_titles.length
            return (
              <li key={w.openalex_id} className="cited-item">
                <div className="cited-main">
                  <div className="lib-doc-title">{w.title}</div>
                  <div className="lib-doc-by">
                    {[w.authors.length > 2 ? `${w.authors[0]} et al.` : w.authors.join(', '), w.year, w.venue].filter(Boolean).join(' · ')}
                  </div>
                  <span className={`na-cites${n > 1 ? ' many' : ''}`} title={`Cites:\n${w.cites_titles.join('\n')}`}>
                    {n > 1 ? `cites ${n} of this topic's papers` : 'cites 1 of its papers'}
                  </span>
                  <Abstract text={w.abstract} />
                  {st && st !== 'working' && st.status === 'downloaded' && <div className="cited-reason">Added to {name}.</div>}
                  {fetchReason(st) && <div className="cited-reason">{fetchReason(st)}</div>}
                </div>
                <FetchActions
                  state={st}
                  searchable={searchable(w)}
                  searchFor={w.title}
                  disabled={false}
                  fetchLabel="Get a free copy"
                  doi={w.doi}
                  onFetch={() => fetcher.fetchOne(target(w))}
                  onOpenPaper={open}
                />
              </li>
            )
          })}
        </ol>

        {works.length > 1 && (
          <footer className="na-foot muted">
            {(data?.found ?? 0) > works.length ? `The ${works.length} closest of ${data?.found} new works. ` : ''}
            {fetcher.running ? (
              <button className="link" onClick={fetcher.stop}>Stop</button>
            ) : (
              waiting.length > 1 && (
                <button className="link" onClick={() => fetcher.fetchAll(waiting.map(target))}>
                  Get free copies of all {waiting.length}
                </button>
              )
            )}
          </footer>
        )}
      </div>
    </div>
  )
}
