import { useEffect, useState } from 'react'
import { api } from '../api'
import type { CitedWork, CitedWorks, FetchStatus } from '../types'
import { FetchActions, type FetchState, fetchReason, useFetcher } from './fetching'

interface Props {
  docId: number
  onOpenPaper: (docId: number) => void
  onChanged: () => Promise<void> // the library changed: reload it
  onClose: () => void
  onError: (msg: string) => void
}

function byline(r: CitedWork): string {
  return [r.first_author, r.year, r.doi && `doi:${r.doi}`].filter(Boolean).join(' · ')
}

/** The works a paper cites: which are already in the library, and free, legal copies of the rest
 *  (found through OpenAlex and Semantic Scholar) downloaded into it. Paywalled works are only listed. */
export function CitedPapersDialog({ docId, onOpenPaper, onChanged, onClose, onError }: Props) {
  const [data, setData] = useState<CitedWorks | null>(null)
  const fetcher = useFetcher(onChanged)

  useEffect(() => {
    api.citedWorks(docId).then(setData).catch((e) => {
      onError(`Could not read the reference list: ${e instanceof Error ? e.message : e}`)
      onClose()
    })
  }, [docId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const refs = data?.references ?? []
  const stateOf = (r: CitedWork): FetchState | null =>
    fetcher.results[r.idx] ?? (r.in_library != null ? { status: 'in_library', doc_id: r.in_library } : null)
  const todo = refs.filter((r) => r.searchable && !stateOf(r))
  const target = (r: CitedWork) => ({ key: String(r.idx), docId, idx: r.idx })
  const count = (...s: FetchStatus[]) => refs.filter((r) => { const st = stateOf(r); return st && st !== 'working' && s.includes(st.status) }).length
  const open = (id: number) => { onOpenPaper(id); onClose() }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dupfiles cited" role="dialog" aria-modal="true" aria-labelledby="cited-title">
        <header className="modal-head">
          <div>
            <h2 id="cited-title">Cited papers</h2>
            <span className="muted">{data ? `The works “${data.title}” cites` : 'Reading the reference list…'}</span>
          </div>
          <span className="spacer" />
          {fetcher.running ? (
            <button onClick={fetcher.stop}>Stop</button>
          ) : (
            <button className="primary" onClick={() => fetcher.fetchAll(todo.map(target))} disabled={!data || todo.length === 0}>
              Download all free copies{todo.length ? ` (${todo.length})` : ''}
            </button>
          )}
          <button className="icon" onClick={onClose} aria-label="Close cited papers">×</button>
        </header>

        {data && (
          <section className="df-summary">
            <div className="df-stat"><b>{count('in_library', 'downloaded')}</b><span>of {refs.length} in your library</span></div>
            <div className="df-stat"><b>{count('downloaded')}</b><span>downloaded now</span></div>
            <div className="df-stat"><b>{count('link', 'no_free_copy', 'not_found')}</b><span>with no free PDF found</span></div>
            <p className="muted df-scope">
              Looks each work up in OpenAlex and Semantic Scholar and downloads only free, legal copies: open-access journals,
              arXiv and university repositories. Paywalled works are listed, never downloaded. Downloads are saved in your data
              folder and added to the library like any other file.
            </p>
          </section>
        )}

        {(fetcher.running || fetcher.working > 0) && (
          <div className="lib-busy" role="status">
            <span className="bar" />
            {fetcher.running ? `Finding free copies… ${todo.length + fetcher.working} left` : 'Searching…'}
          </div>
        )}

        {data && refs.length === 0 && (
          <div className="lib-empty">
            <div className="lib-empty-title">No reference list found</div>
            <p>No References or Bibliography section could be read from this document.</p>
          </div>
        )}

        <ol className="cited-list">
          {refs.map((r) => {
            const st = stateOf(r)
            return (
              <li key={r.idx} className="cited-item">
                <div className="cited-main">
                  <div className="lib-doc-title">{r.title || r.raw}</div>
                  {(byline(r) || r.from_index) && (
                    <div className="lib-doc-by">
                      {byline(r)}
                      {r.from_index && (
                        <span className="from-index" title="Listed by OpenAlex; not found in the paper's own reference list">from OpenAlex</span>
                      )}
                    </div>
                  )}
                  {r.title && !r.from_index && <div className="cited-raw" title={r.raw}>{r.raw}</div>}
                  {fetchReason(st) && <div className="cited-reason">{fetchReason(st)}</div>}
                  {!st && !r.searchable && <div className="cited-reason">No DOI and too short a title to look up automatically</div>}
                </div>
                <FetchActions
                  state={st}
                  searchable={r.searchable}
                  searchFor={r.title || r.raw}
                  disabled={fetcher.running}
                  onFetch={() => fetcher.fetchOne(target(r))}
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
