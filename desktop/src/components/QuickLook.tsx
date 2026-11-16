import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { pdfDocument } from '../pdf'
import type { Doc, Highlight } from '../types'
import { useFocusTrap } from '../useFocusTrap'
import { MuseTag } from './MuseTag'
import { TrustBadges } from './TrustBadges'

const PAGE_W = 400 // the first page is drawn this wide, in CSS pixels
const TEXT_SHOWN = 2200 // characters of a first page shown as text
const HIGHLIGHTS_SHOWN = 6
const SETTLE_MS = 140 // holding an arrow key runs through papers: only the one it stops on is loaded

type FirstPage = { as: 'wait' } | { as: 'pdf' } | { as: 'image'; url: string } | { as: 'text'; text: string } | { as: 'none'; why: string }

/** The first page of a source: a PDF's as it's printed, an image as it is, anything else as its text. */
function FirstPageView({ doc }: { doc: Doc }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [page, setPage] = useState<FirstPage>({ as: 'wait' })
  const isFile = !/^https?:\/\//i.test(doc.source)

  useEffect(() => {
    let stale = false
    let task: { cancel: () => void } | null = null
    let url = ''
    const asText = async (why = '') => {
      try {
        const p = await api.page(doc.id, 1)
        if (!stale) setPage(p.text.trim() ? { as: 'text', text: p.text.trim() } : { as: 'none', why: why || 'Its first page has no text.' })
      } catch (e) {
        if (!stale) setPage({ as: 'none', why: why || (e instanceof Error ? e.message : String(e)) })
      }
    }
    const timer = window.setTimeout(async () => {
      if (isFile && doc.kind === 'pdf') {
        try {
          const pdf = await pdfDocument(doc.id)
          const pg = await pdf.getPage(1)
          if (stale) return
          setPage({ as: 'pdf' })
          const viewport = pg.getViewport({ scale: PAGE_W / pg.getViewport({ scale: 1 }).width })
          const dpr = window.devicePixelRatio || 1
          const c = canvas.current
          if (!c) return
          c.width = Math.floor(viewport.width * dpr)
          c.height = Math.floor(viewport.height * dpr)
          c.style.width = `${viewport.width}px`
          c.style.height = `${viewport.height}px`
          const render = pg.render({ canvas: c, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
          task = render
          await render.promise
        } catch (e) {
          if (stale || (e instanceof Error && e.name === 'RenderingCancelledException')) return
          await asText(`The PDF couldn't be drawn (${e instanceof Error ? e.message : e}).`) // moved, or not really a PDF: its stored text instead
        }
      } else if (isFile && doc.kind === 'image') {
        try {
          const bytes = await api.documentFile(doc.id)
          if (stale) return
          const ext = doc.source.split('.').pop()?.toLowerCase() ?? ''
          const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
          url = URL.createObjectURL(new Blob([bytes], { type }))
          setPage({ as: 'image', url })
        } catch {
          await asText()
        }
      } else {
        await asText()
      }
    }, SETTLE_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
      task?.cancel()
      if (url) URL.revokeObjectURL(url)
    }
  }, [doc.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ql-page" aria-label="First page">
      {/* The canvas is always there, so the page can be drawn on it as soon as it's read. */}
      <canvas ref={canvas} className="ql-sheet" hidden={page.as !== 'pdf'} />
      {page.as === 'wait' && <div className="ql-sheet ql-wait" aria-hidden="true" />}
      {page.as === 'image' && <img className="ql-sheet" src={page.url} alt={`First page of ${doc.title}`} />}
      {page.as === 'text' && (
        <div className="ql-sheet ql-text">
          {page.text.slice(0, TEXT_SHOWN)}
          {page.text.length > TEXT_SHOWN && '…'}
        </div>
      )}
      {page.as === 'none' && <p className="muted ql-none">No first page to show. {page.why}</p>}
    </div>
  )
}

/** A peek at one paper without opening it: its first page, its abstract (or Muse's summary) and
 * what the reader highlighted in it. The arrow keys move through the list with the peek open;
 * Space or Esc closes it. Looking doesn't mark the paper as read. */
export function QuickLook({ doc, at, of, kindLabel, onStep, onOpen, onClose }: {
  doc: Doc
  at: number // its place in the list, from 1
  of: number
  kindLabel: string
  onStep: (dir: 1 | -1) => void
  /** Open the paper itself (the reader for a PDF); null when there's nothing to open it with. */
  onOpen: (() => void) | null
  onClose: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  const [marks, setMarks] = useState<Highlight[] | null>(null)
  useFocusTrap(ref)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  useEffect(() => {
    let stale = false
    setMarks(null)
    const t = window.setTimeout(() => {
      api.documentHighlights(doc.id).then((h) => !stale && setMarks(h)).catch(() => !stale && setMarks([]))
    }, SETTLE_MS)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
  }, [doc.id])

  const facts = [doc.year && doc.year > 0 ? doc.year : '', doc.venue, doc.page_count > 1 ? `${doc.page_count} ${doc.kind === 'pptx' ? 'slides' : 'pages'}` : '']
    .filter(Boolean)
    .join(' · ')
  const isFile = !/^https?:\/\//i.test(doc.source)
  const openLabel = !isFile ? 'Open page' : doc.kind === 'pdf' ? 'Open PDF' : 'Open file'

  return (
    <div className="ql-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        ref={ref}
        className="ql"
        role="dialog"
        aria-modal="true"
        aria-label={`Quick look: ${doc.title}`}
        tabIndex={-1}
        onKeyDown={(e) => {
          const onButton = (e.target as HTMLElement).closest('button, a')
          if (e.key === 'Escape' || (e.key === ' ' && !onButton)) {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            e.preventDefault()
            onStep(e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1)
          } else if (e.key === 'Enter' && !onButton && onOpen) {
            e.preventDefault()
            onOpen()
          }
        }}
      >
        <header className="ql-top">
          <span className={`kind kind-${doc.kind}`}>{kindLabel}</span>
          <TrustBadges doc={doc} />
          {doc.unread && <span className="lib-unread-mark" title="Looking here doesn't mark it as read">Unread</span>}
          <span className="muted ql-at" role="status">{at} of {of}</span>
          <span className="spacer" />
          <span className="ql-keys" aria-hidden="true">
            <kbd>↑</kbd><kbd>↓</kbd> next paper{onOpen && <> · <kbd>Enter</kbd> open</>} · <kbd>Space</kbd> close
          </span>
          <button className="icon" onClick={onClose} aria-label="Close quick look" title="Close (Space or Esc)">×</button>
        </header>
        <div className="ql-body">
          <FirstPageView key={doc.id} doc={doc} />
          <div className="ql-info">
            <h3 className="ql-title">{doc.title}</h3>
            {doc.authors.length > 0 && <p className="ql-authors">{doc.authors.join(doc.authors.some((a) => a.includes(',')) ? '; ' : ', ')}</p>}
            {facts && <p className="ql-facts">{facts}</p>}

            {doc.abstract ? (
              <>
                <h4 className="lib-doc-label">Abstract</h4>
                <p className="ql-prose">{doc.abstract}</p>
              </>
            ) : doc.summary ? (
              <>
                <h4 className="lib-doc-label">
                  Summary <MuseTag from="this paper's text" />
                </h4>
                <p className="ql-prose">{doc.summary}</p>
              </>
            ) : (
              <p className="muted ql-prose">No abstract or summary yet.</p>
            )}

            {marks && marks.length > 0 && (
              <>
                <h4 className="lib-doc-label">Your highlights ({marks.length})</h4>
                <ul className="ql-marks">
                  {marks.slice(0, HIGHLIGHTS_SHOWN).map((h) => (
                    <li key={h.id}>
                      <q>{h.text.length > 260 ? h.text.slice(0, 260) + '…' : h.text}</q>
                      <span className="ql-mark-page" title={h.page_label ? 'The page number printed on the paper' : "The PDF's own page count: this page prints no number"}>
                        p. {h.page_label || h.page}
                      </span>
                      {h.note && <span className="ql-mark-note">{h.note}</span>}
                    </li>
                  ))}
                </ul>
                {marks.length > HIGHLIGHTS_SHOWN && <p className="muted ql-more">and {marks.length - HIGHLIGHTS_SHOWN} more in the reader</p>}
              </>
            )}
            {marks && marks.length === 0 && doc.kind === 'pdf' && isFile && (
              <p className="muted ql-more">You haven't highlighted anything in this paper yet.</p>
            )}
          </div>
        </div>
        {onOpen && (
          <footer className="ql-foot">
            <button className="primary" onClick={onOpen}>{openLabel}</button>
          </footer>
        )}
      </section>
    </div>
  )
}
