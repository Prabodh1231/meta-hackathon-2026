import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CitationStatus, Doc } from '../types'
import { StatusBadge } from './StatusBadge'

export interface SourceTarget {
  docId: number
  page: number
  start: number | null
  end: number | null
  quote: string
  status: CitationStatus
  reason: string
  label: string
}

export function SourceViewer({ target, doc }: { target: SourceTarget | null; doc: Doc | undefined }) {
  const [text, setText] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const markRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (target) setPage(target.page)
  }, [target])

  useEffect(() => {
    if (!target) return
    setText(null)
    setError(null)
    api
      .page(target.docId, page)
      .then((p) => setText(p.text))
      .catch((e) => setError(String(e)))
  }, [target, page])

  useEffect(() => {
    markRef.current?.scrollIntoView({ block: 'center' })
  }, [text])

  if (!target) {
    return <p className="empty">Click a citation in your document or in a draft to see the exact source passage.</p>
  }

  const highlight = page === target.page && target.start != null && target.end != null
  return (
    <div className="source-viewer">
      <div className="source-head">
        <div>
          <div className="doc-title">{doc?.title ?? 'Source'}</div>
          <div className="muted">{target.label}</div>
        </div>
        <StatusBadge status={target.status} />
      </div>
      {target.reason && <p className="reason">{target.reason}</p>}
      {target.status === 'quote_not_found' && (
        <blockquote className="missing-quote">Claimed quote: “{target.quote}”</blockquote>
      )}
      {doc && doc.page_count > 1 && (
        <div className="pager">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
          <span>
            {doc.kind === 'pptx' ? 'Slide' : 'Page'} {page} / {doc.page_count}
          </span>
          <button disabled={page >= doc.page_count} onClick={() => setPage(page + 1)}>›</button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      {text != null && (
        <pre className="page-text">
          {highlight ? (
            <>
              {text.slice(0, target.start!)}
              <mark ref={markRef}>{text.slice(target.start!, target.end!)}</mark>
              {text.slice(target.end!)}
            </>
          ) : (
            text
          )}
        </pre>
      )}
    </div>
  )
}
