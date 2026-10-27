import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Citation, Suggestion } from '../types'
import { StatusBadge } from './StatusBadge'

export interface CiteRequest {
  id: number // bumps on every Cite click, so citing the same text again re-runs
  claim: string
}

interface Props {
  request: CiteRequest | null
  scope: number[]
  onInsert: (c: Citation, claim: string) => boolean
  onOpenSource: (c: Citation) => void
  onError: (msg: string) => void
}

/** Sources for a sentence the user wrote themselves: best supported first, ready to insert. */
export function CitePanel({ request, scope, onInsert, onOpenSource, onError }: Props) {
  const [results, setResults] = useState<Suggestion[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [inserted, setInserted] = useState<string | null>(null)

  useEffect(() => {
    if (!request) return
    let cancelled = false
    setResults(null)
    setInserted(null)
    setBusy(true)
    api
      .suggestCitations(request.claim, scope.length ? scope : null)
      .then((r) => !cancelled && setResults(r))
      .catch((e) => !cancelled && onError(`Could not find sources: ${e instanceof Error ? e.message : e}`))
      .finally(() => !cancelled && setBusy(false))
    return () => {
      cancelled = true
    }
    // Re-run only for a new Cite click, not when the library selection changes later.
  }, [request?.id])

  if (!request) {
    return (
      <div className="empty">
        <p>Put your cursor in a sentence you wrote, or select some text, then click <strong>Cite</strong> in the toolbar (Ctrl+Shift+C).</p>
        <p>You'll get the best supporting passages from your library, each already checked against your sentence.</p>
      </div>
    )
  }

  const supported = results?.some((r) => r.status === 'verified' || r.status === 'weak')
  return (
    <div className="cite-panel">
      <blockquote className="cite-claim">{request.claim}</blockquote>
      <div className="muted">{scope.length ? `Searching ${scope.length} selected docs` : 'Searching whole library'}</div>
      {busy && <p className="busy">Finding and checking sources…</p>}
      {results && results.length === 0 && <p className="empty">Nothing in your library matches this sentence.</p>}
      {results && results.length > 0 && !supported && (
        <p className="warn">No source in your library supports this claim. You may need to add one.</p>
      )}
      {results?.map((r, i) => {
        const key = `${r.chunk_id}:${i}`
        return (
          <div key={key} className={`suggestion suggestion-${r.status}`}>
            <div className="row">
              <StatusBadge status={r.status} />
              <span className="suggestion-label">{r.label}</span>
            </div>
            <p className="suggestion-quote">“{r.quote}”</p>
            {r.reason && <p className="reason">{r.reason}</p>}
            <div className="row">
              <button onClick={() => onOpenSource(r)}>View source</button>
              {inserted === key ? (
                <span className="muted">Inserted</span>
              ) : (
                <button
                  className={r.status === 'verified' ? 'primary' : ''}
                  disabled={r.status === 'quote_not_found'}
                  onClick={() => {
                    if (onInsert(r, request.claim)) setInserted(key)
                    else onError('That sentence was deleted. Click Cite again on the text you want to cite.')
                  }}
                >
                  Insert citation
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
