import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CitedWork, CitedWorks, FetchResult, FetchStatus } from '../types'

const WORKERS = 3 // references fetched at once: each waits on two indexes, a download and an import

const LABEL: Record<FetchStatus | 'working', string> = {
  working: 'Searching…',
  in_library: 'In your library',
  downloaded: 'Downloaded',
  link: 'Free to read online',
  no_free_copy: 'No free copy',
  not_found: 'Not found',
  failed: 'Failed',
}

interface Props {
  docId: number
  onOpenPaper: (docId: number) => void
  onChanged: () => Promise<void> // the library changed: reload it
  onClose: () => void
  onError: (msg: string) => void
}

type State = FetchResult | 'working'

function byline(r: CitedWork): string {
  return [r.first_author, r.year, r.doi && `doi:${r.doi}`].filter(Boolean).join(' · ')
}

function scholarSearch(r: CitedWork): string {
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(r.title || r.raw.slice(0, 200))}`
}

/** The works a paper cites: which are already in the library, and free, legal copies of the rest
 *  (found through OpenAlex and Semantic Scholar) downloaded into it. Paywalled works are only listed. */
export function CitedPapersDialog({ docId, onOpenPaper, onChanged, onClose, onError }: Props) {
  const [data, setData] = useState<CitedWorks | null>(null)
  const [results, setResults] = useState<Record<number, State>>({})
  const [running, setRunning] = useState(false)
  const stop = useRef(false)

  useEffect(() => {
    api.citedWorks(docId).then(setData).catch((e) => {
      onError(`Could not read the reference list: ${e instanceof Error ? e.message : e}`)
      onClose()
    })
    return () => { stop.current = true } // closing stops a batch after the downloads in progress
  }, [docId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function fetchOne(idx: number) {
    setResults((r) => ({ ...r, [idx]: 'working' }))
    let res: FetchResult
    try {
      res = await api.fetchCitedWork(docId, idx)
    } catch (e) {
      res = { status: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
    setResults((r) => ({ ...r, [idx]: res }))
    if (res.status === 'downloaded') await onChanged().catch(() => {})
  }

  const refs = data?.references ?? []
  const stateOf = (r: CitedWork): State | null => results[r.idx] ?? (r.in_library != null ? { status: 'in_library', doc_id: r.in_library } : null)
  const todo = refs.filter((r) => r.searchable && !stateOf(r))

  async function fetchAll() {
    stop.current = false
    setRunning(true)
    const queue = todo.map((r) => r.idx)
    const worker = async () => {
      while (queue.length && !stop.current) await fetchOne(queue.shift()!)
    }
    await Promise.all(Array.from({ length: WORKERS }, worker))
    setRunning(false)
  }

  const count = (...s: FetchStatus[]) => refs.filter((r) => { const st = stateOf(r); return st && st !== 'working' && s.includes(st.status) }).length
  const working = Object.values(results).filter((s) => s === 'working').length

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dupfiles cited" role="dialog" aria-modal="true" aria-labelledby="cited-title">
        <header className="modal-head">
          <div>
            <h2 id="cited-title">Cited papers</h2>
            <span className="muted">{data ? `The works “${data.title}” cites` : 'Reading the reference list…'}</span>
          </div>
          <span className="spacer" />
          {running ? (
            <button onClick={() => { stop.current = true }}>Stop</button>
          ) : (
            <button className="primary" onClick={fetchAll} disabled={!data || todo.length === 0}>
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

        {(running || working > 0) && (
          <div className="lib-busy" role="status">
            <span className="bar" />
            {running ? `Finding free copies… ${todo.length + working} left` : 'Searching…'}
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
            const res = st && st !== 'working' ? st : null
            const status = st === 'working' ? 'working' : res?.status
            return (
              <li key={r.idx} className="cited-item">
                <div className="cited-main">
                  <div className="lib-doc-title">{r.title || r.raw}</div>
                  {byline(r) && <div className="lib-doc-by">{byline(r)}</div>}
                  {r.title && <div className="cited-raw" title={r.raw}>{r.raw}</div>}
                  {res?.reason && res.status !== 'link' && <div className="cited-reason">{res.reason}</div>}
                  {!st && !r.searchable && <div className="cited-reason">No DOI and too short a title to look up automatically</div>}
                </div>
                <div className="cited-side">
                  {status && <span className={`cited-badge cited-${status}`}>{LABEL[status]}</span>}
                  {res?.found_in && res.status === 'downloaded' && <span className="muted cited-from">via {res.found_in}</span>}
                  <div className="cited-actions">
                    {res?.doc_id != null && (
                      <button className="link" onClick={() => { onOpenPaper(res.doc_id!); onClose() }}>Open in library</button>
                    )}
                    {res?.status === 'downloaded' && res.document && window.rc?.showFile && (
                      <button className="link" onClick={() => window.rc!.showFile!(res.document!.source).catch(() => {})}>Show file</button>
                    )}
                    {res?.status === 'link' && res.url && (
                      <a className="link" href={res.url} target="_blank" rel="noreferrer">Read online</a>
                    )}
                    {(res?.status === 'no_free_copy' || res?.status === 'not_found' || (!st && !r.searchable)) && (
                      <a className="link" href={scholarSearch(r)} target="_blank" rel="noreferrer">Search Google Scholar</a>
                    )}
                    {!st && r.searchable && (
                      <button onClick={() => fetchOne(r.idx)} disabled={running}>Find free copy</button>
                    )}
                    {res?.status === 'failed' && (
                      <button onClick={() => fetchOne(r.idx)} disabled={running}>Try again</button>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
