import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CitationStatus, Doc, PageText } from '../types'
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
  badge?: string // badge text instead of the citation status (e.g. for a duplication match)
}

/** "p. 342 · PDF page 2 of 15", making clear which number is the printed one. */
function pageCaption(doc: Doc, page: number, data: PageText | null): string {
  if (doc.kind === 'pptx') return `Slide ${page} of ${doc.page_count}`
  if (doc.kind !== 'pdf') return `Page ${page} of ${doc.page_count}`
  const pdfPage = `PDF page ${page} of ${doc.page_count}`
  if (data?.label) return `p. ${data.label} · ${pdfPage}`
  if (doc.page_numbering === 'index') return `${pdfPage} · no printed page numbers found`
  return `${pdfPage} · unnumbered page`
}

export function SourceViewer({ target, doc }: { target: SourceTarget | null; doc: Doc | undefined }) {
  const [pageData, setPageData] = useState<PageText | null>(null)
  // The page turned to, for the citation it was turned for. Another citation opens on its own page
  // straight away, so its page is fetched once rather than the old page number first.
  const [turned, setTurned] = useState<{ target: SourceTarget | null; page: number }>({ target: null, page: 1 })
  const page = turned.target === target ? turned.page : target?.page ?? 1
  const setPage = (p: number) => setTurned({ target, page: p })
  const [error, setError] = useState<string | null>(null)
  const markRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!target) return
    // Only the latest answer may show, or a slow reply would put the wrong page on screen.
    let stale = false
    setPageData(null)
    setError(null)
    api
      .page(target.docId, page)
      .then((d) => !stale && setPageData(d))
      .catch((e) => !stale && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      stale = true
    }
  }, [target, page])

  useEffect(() => {
    markRef.current?.scrollIntoView({ block: 'center' })
  }, [pageData])

  if (!target) {
    return <p className="empty">Click a citation in your document or in a draft to see the exact source passage.</p>
  }

  const text = pageData?.text ?? null
  const highlight = page === target.page && target.start != null && target.end != null
  return (
    <div className="source-viewer">
      <div className="source-head">
        <div>
          <div className="doc-title">{doc?.title ?? 'Source'}</div>
          <div className="muted">{target.label}</div>
        </div>
        <StatusBadge status={target.status} text={target.badge} />
      </div>
      {target.reason && <p className="reason">{target.reason}</p>}
      {target.status === 'quote_not_found' && (
        <blockquote className="missing-quote">Claimed quote: “{target.quote}”</blockquote>
      )}
      {doc && (doc.page_count > 1 || doc.kind === 'pdf') && (
        <div className="pager">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
          <span>{pageCaption(doc, page, pageData)}</span>
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
