import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { FetchResult, FetchStatus } from '../types'

/** Fetching free copies of cited works, shared by the Cited papers and Missing papers dialogs. */

const WORKERS = 3 // works fetched at once: each waits on two indexes, a download and an import

const LABEL: Record<FetchStatus | 'working', string> = {
  working: 'Searching…',
  in_library: 'In your library',
  downloaded: 'Downloaded',
  link: 'Free to read online',
  no_free_copy: 'No free copy',
  not_found: 'Not found',
  failed: 'Failed',
}

export type FetchState = FetchResult | 'working'

/** What to fetch: an entry in a library paper's reference list (the paper and the entry's place
 *  in it), or any work by its title and DOI (one citing a library paper, say). */
export type FetchTarget =
  | { key: string; docId: number; idx: number }
  | { key: string; work: { title: string; doi: string; year: number | null; first_author: string } }

/** Results per key, and fetching one work or a queue of them (a few at a time, stoppable). */
export function useFetcher(onChanged: () => Promise<void>) {
  const [results, setResults] = useState<Record<string, FetchState>>({})
  const [running, setRunning] = useState(false)
  const stop = useRef(false)
  useEffect(() => () => { stop.current = true }, []) // closing stops a batch after the downloads in progress

  async function fetchOne(t: FetchTarget) {
    const key = t.key
    setResults((r) => ({ ...r, [key]: 'working' }))
    let res: FetchResult
    try {
      res = 'work' in t ? await api.fetchWork(t.work) : await api.fetchCitedWork(t.docId, t.idx)
    } catch (e) {
      res = { status: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
    setResults((r) => ({ ...r, [key]: res }))
    if (res.status === 'downloaded') await onChanged().catch(() => {})
  }

  async function fetchAll(targets: FetchTarget[]) {
    stop.current = false
    setRunning(true)
    const queue = [...targets]
    const worker = async () => {
      while (queue.length && !stop.current) await fetchOne(queue.shift()!)
    }
    await Promise.all(Array.from({ length: WORKERS }, worker))
    setRunning(false)
  }

  const working = Object.values(results).filter((s) => s === 'working').length
  return { results, running, working, fetchOne, fetchAll, stop: () => { stop.current = true } }
}

/** Why nothing was downloaded, when the result says. */
export function fetchReason(state: FetchState | null): string {
  return state && state !== 'working' && state.status !== 'link' ? state.reason ?? '' : ''
}

/** A work's fetch status and what can be done next: fetch it, open it, read it online, search for it. */
export function FetchActions({ state, searchable, searchFor, disabled, onFetch, onOpenPaper }: {
  state: FetchState | null
  searchable: boolean
  searchFor: string // what to search Google Scholar for
  disabled: boolean
  onFetch: () => void
  onOpenPaper: (docId: number) => void
}) {
  const res = state && state !== 'working' ? state : null
  const status = state === 'working' ? 'working' : res?.status
  const scholar = `https://scholar.google.com/scholar?q=${encodeURIComponent(searchFor.slice(0, 200))}`
  return (
    <div className="cited-side">
      {status && <span className={`cited-badge cited-${status}`}>{LABEL[status]}</span>}
      {res?.found_in && res.status === 'downloaded' && <span className="muted cited-from">via {res.found_in}</span>}
      <div className="cited-actions">
        {res?.doc_id != null && (
          <button className="link" onClick={() => onOpenPaper(res.doc_id!)}>Open in library</button>
        )}
        {res?.status === 'downloaded' && res.document && window.rc?.showFile && (
          <button className="link" onClick={() => window.rc!.showFile!(res.document!.source).catch(() => {})}>Show file</button>
        )}
        {res?.status === 'link' && res.url && (
          <a className="link" href={res.url} target="_blank" rel="noreferrer">Read online</a>
        )}
        {(res?.status === 'no_free_copy' || res?.status === 'not_found' || (!state && !searchable)) && (
          <a className="link" href={scholar} target="_blank" rel="noreferrer">Search Google Scholar</a>
        )}
        {!state && searchable && (
          <button onClick={onFetch} disabled={disabled}>Find free copy</button>
        )}
        {res?.status === 'failed' && (
          <button onClick={onFetch} disabled={disabled}>Try again</button>
        )}
      </div>
    </div>
  )
}
