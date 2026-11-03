import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import { type Box, pdfDocument, placeQuote } from '../pdf'
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

// PDFs open on the page itself or its extracted text, whichever was picked last.
const VIEW_KEY = 'rc.sourceView'
type View = 'page' | 'text'
function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'text' ? 'text' : 'page'
  } catch {
    return 'page'
  }
}

/** One PDF page drawn as it's printed, with the cited passage highlighted on it. */
function PdfPage({ docId, page, needle, onFail }: { docId: number; page: number; needle: string | null; onFail: (why: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const firstHit = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [boxes, setBoxes] = useState<Box[]>([])
  const [width, setWidth] = useState(0)

  // Redraw when the panel's width changes (a window resize), not at every pixel of it.
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    let t: number | undefined
    const measure = () => setWidth(Math.round(el.clientWidth))
    measure()
    const ro = new ResizeObserver(() => {
      window.clearTimeout(t)
      t = window.setTimeout(measure, 150)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      window.clearTimeout(t)
    }
  }, [])

  useEffect(() => {
    if (!width) return
    let stale = false
    let task: { cancel: () => void } | null = null
    ;(async () => {
      try {
        const pdf = await pdfDocument(docId)
        const pg = await pdf.getPage(page)
        if (stale) return
        const viewport = pg.getViewport({ scale: width / pg.getViewport({ scale: 1 }).width })
        const dpr = window.devicePixelRatio || 1
        const c = canvas.current!
        c.width = Math.floor(viewport.width * dpr)
        c.height = Math.floor(viewport.height * dpr)
        setSize({ w: viewport.width, h: viewport.height })
        const render = pg.render({ canvas: c, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
        task = render
        await render.promise
        if (stale) return
        if (!needle) return setBoxes([])
        const text = await pg.getTextContent()
        if (stale) return
        const items = text.items.filter((it): it is (typeof text.items)[number] & { str: string; transform: number[]; width: number } => 'str' in it)
        const found = placeQuote(items, needle, viewport)
        setBoxes(found)
        if (!found.length) onFail("The quote couldn't be placed on the page image, so here's the page's text with it highlighted.")
      } catch (e) {
        if (stale || (e instanceof Error && e.name === 'RenderingCancelledException')) return
        onFail(`The PDF couldn't be shown (${e instanceof Error ? e.message : e}), so here's the page's text.`)
      }
    })()
    return () => {
      stale = true
      task?.cancel()
    }
  }, [docId, page, needle, width]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    firstHit.current?.scrollIntoView({ block: 'center' })
  }, [boxes])

  return (
    <div className="pdf-page" ref={wrap}>
      <div className="pdf-sheet" style={size ? { width: size.w, height: size.h } : undefined}>
        <canvas ref={canvas} style={size ? { width: size.w, height: size.h } : undefined} />
        {boxes.map((b, i) => (
          <div key={i} ref={i === 0 ? firstHit : undefined} className="pdf-hit" style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
        ))}
        {!size && <p className="muted pdf-loading">Loading the page…</p>}
      </div>
    </div>
  )
}

export function SourceViewer({ target, doc, onOpenPdf }: {
  target: SourceTarget | null
  doc: Doc | undefined
  /** Show the whole PDF in the app's viewer, at this page. */
  onOpenPdf?: (doc: Doc, page: number) => void
}) {
  const [pageData, setPageData] = useState<PageText | null>(null)
  // The page turned to, for the citation it was turned for. Another citation opens on its own page
  // straight away, so its page is fetched once rather than the old page number first.
  const [turned, setTurned] = useState<{ target: SourceTarget | null; page: number }>({ target: null, page: 1 })
  const page = turned.target === target ? turned.page : target?.page ?? 1
  const setPage = (p: number) => setTurned({ target, page: p })
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>(storedView)
  const [fallback, setFallback] = useState<{ target: SourceTarget | null; page: number; why: string } | null>(null)
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

  const isPdf = doc?.kind === 'pdf' && !/^https?:\/\//i.test(doc.source)
  // The page image couldn't show this passage: fall back to the text, for this page only.
  const failed = fallback && fallback.target === target && fallback.page === page ? fallback.why : null
  const showPage = isPdf && view === 'page' && !failed

  useEffect(() => {
    markRef.current?.scrollIntoView({ block: 'center' })
  }, [pageData, showPage])

  if (!target) {
    return <p className="empty">Click a citation in your document or in a draft to see the exact source passage.</p>
  }

  const text = pageData?.text ?? null
  const highlight = page === target.page && target.start != null && target.end != null
  // Highlight what the backend matched on its own extracted text; the model's quote otherwise.
  const needle = page !== target.page ? null : text != null && highlight ? text.slice(target.start!, target.end!) : target.quote || null
  const pick = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* storage unavailable */
    }
  }

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
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">‹</button>
          <span>{pageCaption(doc, page, pageData)}</span>
          <button disabled={page >= doc.page_count} onClick={() => setPage(page + 1)} aria-label="Next page">›</button>
          <span className="spacer" />
          {isPdf && (
            <div className="segmented small view-switch" role="radiogroup" aria-label="Show">
              <button role="radio" aria-checked={view === 'page'} className={view === 'page' ? 'active' : ''} onClick={() => pick('page')} title="The page as printed">
                Page
              </button>
              <button role="radio" aria-checked={view === 'text'} className={view === 'text' ? 'active' : ''} onClick={() => pick('text')} title="The text read from the page">
                Text
              </button>
            </div>
          )}
        </div>
      )}
      {isPdf && onOpenPdf && doc && (
        <button className="link open-pdf" onClick={() => onOpenPdf(doc, page)}>
          Open the whole PDF at this page
        </button>
      )}
      {error && <p className="error-text">{error}</p>}
      {failed && view === 'page' && <p className="muted">{failed}</p>}
      {showPage ? (
        // Wait for the extracted text when there's a passage to place, so it's found the same way.
        (!highlight || text != null) && (
          <PdfPage key={`${target.docId}`} docId={target.docId} page={page} needle={needle} onFail={(why) => setFallback({ target, page, why })} />
        )
      ) : (
        text != null && (
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
        )
      )}
    </div>
  )
}
