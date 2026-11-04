import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { api } from '../api'
import { type Box, loadPdfjs, pdfDocument, placeQuote } from '../pdf'
import type { Doc, Highlight } from '../types'

const MAX_WIDTH = 900 // the page's width on a wide screen; narrower windows fit the page to the window
const NEAR = '1200px' // pages this far outside the view are drawn in advance

type TextItem = { str: string; transform: number[]; width: number }

/** A popup for a selection (Highlight / Add note), or the note of a highlight being edited. */
type Popup =
  | { kind: 'select'; page: number; text: string; x: number; y: number }
  | { kind: 'tooLong'; x: number; y: number }
  | { kind: 'note'; hid: number; x: number; y: number }

/** The reader as a window of its own (the desktop app): the paper's record is loaded first. */
export function ReaderWindow({ docId, page }: { docId: number; page: number }) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .document(docId)
      .then((d) => {
        setDoc(d)
        document.title = `${d.title} · Reader`
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [docId])
  if (!doc) return <p className={error ? 'error-text pdf-view-note' : 'muted pdf-view-note'}>{error ?? 'Opening…'}</p>
  return <ReaderDialog doc={doc} page={page} standalone onClose={() => window.close()} />
}

/** A library PDF read in the app: every page drawn with its text selectable, so passages can be
 * highlighted and given a note. Highlights are kept with the paper and fetched while writing.
 * `standalone`: filling a window of its own rather than a dialog over the app. */
export function ReaderDialog({ doc, page, standalone = false, onClose }: { doc: Doc; page: number; standalone?: boolean; onClose: () => void }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [aspect, setAspect] = useState(1.294) // page height / width, from page 1 (A4 until it's read)
  const [error, setError] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [popup, setPopup] = useState<Popup | null>(null)
  const [draft, setDraft] = useState('') // the note being written
  const [busy, setBusy] = useState(false)
  const [width, setWidth] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)

  useEffect(() => {
    let stale = false
    pdfDocument(doc.id)
      .then(async (p) => {
        const first = (await p.getPage(1)).getViewport({ scale: 1 })
        if (stale) return
        setAspect(first.height / first.width)
        setPdf(p)
      })
      .catch((e) => !stale && setError(e instanceof Error ? e.message : String(e)))
    api
      .documentHighlights(doc.id)
      .then((hs) => !stale && setHighlights(hs))
      .catch((e) => !stale && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      stale = true
    }
  }, [doc.id])

  // Fit the page to the window, redrawing after a resize settles rather than at every pixel.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    let t: number | undefined
    const measure = () => setWidth(Math.min(MAX_WIDTH, Math.round(el.clientWidth - 48)))
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

  // Open at the page asked for, once the pages have their size.
  useEffect(() => {
    if (!pdf || !width || scrolled.current) return
    scrolled.current = true
    scroller.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'start' })
  }, [pdf, width, page])

  const closePopup = useCallback(() => {
    setPopup(null)
    setDraft('')
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (popup) closePopup()
      else if (!standalone) onClose() // a window of its own closes like any window, not on Esc
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, popup, closePopup, standalone])

  // A click anywhere else dismisses the popup, as a menu would: the Highlight bar always, a note
  // only when nothing typed in it would be lost.
  useEffect(() => {
    if (!popup) return
    const onDown = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.('.reader-popup')) return
      if (popup.kind === 'note' && draft.trim() !== (highlights.find((h) => h.id === popup.hid)?.note ?? '')) return
      closePopup()
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [popup, draft, highlights, closePopup])

  /** A selection made with the mouse: offer to highlight it, if it's on one page. */
  function onMouseUp(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('.reader-popup')) return
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    if (!sel || sel.isCollapsed || !text) return
    const pageOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>('[data-page]')
    const from = pageOf(sel.anchorNode)
    const to = pageOf(sel.focusNode)
    if (!from) return
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const at = { x: rect.left + rect.width / 2, y: rect.bottom + 8 }
    if (from !== to) return setPopup({ kind: 'tooLong', ...at })
    setPopup({ kind: 'select', page: Number(from.dataset.page), text, ...at })
  }

  async function highlight(withNote: boolean) {
    if (popup?.kind !== 'select') return
    setBusy(true)
    try {
      const h = await api.addHighlight(doc.id, popup.page, popup.text)
      setHighlights((hs) => [...hs, h])
      window.getSelection()?.removeAllRanges()
      if (withNote) setPopup({ kind: 'note', hid: h.id, x: popup.x, y: popup.y })
      else closePopup()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveNote() {
    if (popup?.kind !== 'note') return
    setBusy(true)
    try {
      const h = await api.setHighlightNote(popup.hid, draft)
      setHighlights((hs) => hs.map((x) => (x.id === h.id ? h : x)))
      closePopup()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(hid: number) {
    setBusy(true)
    try {
      await api.deleteHighlight(hid)
      setHighlights((hs) => hs.filter((x) => x.id !== hid))
      closePopup()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openNote = useCallback((h: Highlight, x: number, y: number) => {
    window.getSelection()?.removeAllRanges()
    setDraft(h.note)
    setPopup({ kind: 'note', hid: h.id, x, y })
  }, [])

  const editing = popup?.kind === 'note' ? highlights.find((h) => h.id === popup.hid) : undefined
  const noted = highlights.filter((h) => h.note).length

  return (
    <div className={standalone ? 'reader-window' : 'modal-backdrop'} onMouseDown={(e) => !standalone && e.target === e.currentTarget && onClose()}>
      <div className="modal pdf-view" role={standalone ? 'main' : 'dialog'} aria-modal={!standalone} aria-label={`PDF: ${doc.title}`}>
        <header className="pdf-view-head">
          <span className="kind kind-pdf">PDF</span>
          <h2 title={doc.title}>{doc.title}</h2>
          <span className="muted reader-count">
            {highlights.length ? `${highlights.length} highlight${highlights.length === 1 ? '' : 's'}${noted ? `, ${noted} with notes` : ''}` : 'Select text to highlight it'}
          </span>
          <span className="spacer" />
          {window.rc?.openPdf && (
            <button className="link" title="Chromium's PDF viewer, with search and print" onClick={() => window.rc!.openPdf!(doc.source, page, doc.title).catch(() => {})}>
              Open in PDF viewer
            </button>
          )}
          {window.rc?.showFile && (
            <button className="link" onClick={() => window.rc!.showFile!(doc.source).catch(() => {})}>
              Show in folder
            </button>
          )}
          <button className="icon" onClick={onClose} aria-label="Close the PDF" title={standalone ? 'Close' : 'Close (Esc)'}>
            ×
          </button>
        </header>
        {error && (
          <p className="error-text pdf-view-note">
            {error}{' '}
            <button className="link" onClick={() => setError(null)}>
              Dismiss
            </button>
          </p>
        )}
        <div className="reader" ref={scroller} onMouseUp={onMouseUp} onScroll={() => popup?.kind !== 'note' && popup && closePopup()}>
          {!pdf && !error && <p className="muted pdf-view-note">Opening…</p>}
          {pdf &&
            width > 0 &&
            Array.from({ length: pdf.numPages }, (_, i) => (
              <ReaderPage
                key={i + 1}
                pdf={pdf}
                n={i + 1}
                width={width}
                aspect={aspect}
                root={scroller.current}
                highlights={highlights.filter((h) => h.page === i + 1)}
                onOpenNote={openNote}
              />
            ))}
        </div>
        {popup?.kind === 'select' && (
          <div className="reader-popup" style={place(popup)} role="toolbar" aria-label="Highlight the selection">
            <button className="primary" disabled={busy} onClick={() => highlight(false)}>
              Highlight
            </button>
            <button disabled={busy} onClick={() => highlight(true)}>
              Add note
            </button>
          </div>
        )}
        {popup?.kind === 'tooLong' && (
          <div className="reader-popup" style={place(popup)} role="status">
            <span className="muted">Select text on one page to highlight it.</span>
          </div>
        )}
        {popup?.kind === 'note' && editing && (
          <div className="reader-popup reader-note" style={place(popup)} role="dialog" aria-label="Note on this highlight">
            <blockquote title={editing.text}>{editing.text}</blockquote>
            <textarea
              autoFocus
              rows={3}
              value={draft}
              placeholder="An idea while reading… (your own words, never cited as a source)"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && saveNote()}
            />
            <div className="row">
              <button className="link danger-link" disabled={busy} onClick={() => remove(editing.id)}>
                Remove highlight
              </button>
              <span className="spacer" />
              <button className="link" onClick={closePopup}>
                Cancel
              </button>
              <button className="primary" disabled={busy || draft.trim() === editing.note} onClick={saveNote}>
                Save note
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** A popup's place: under the selection, kept inside the window. */
function place(p: { x: number; y: number }): React.CSSProperties {
  const w = 340
  return { left: Math.max(12, Math.min(window.innerWidth - w - 12, p.x - w / 2)), top: Math.min(window.innerHeight - 200, p.y) }
}

/** One page: drawn when it comes near the view, with pdf.js's text layer over it for selecting, and
 * the page's highlights under the text. A highlight with a note shows a note mark in the margin. */
function ReaderPage({ pdf, n, width, aspect, root, highlights, onOpenNote }: {
  pdf: PDFDocumentProxy
  n: number
  width: number
  aspect: number
  root: HTMLElement | null
  highlights: Highlight[]
  onOpenNote: (h: Highlight, x: number, y: number) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textLayer = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [size, setSize] = useState<{ w: number; h: number; scale: number } | null>(null)
  const [layout, setLayout] = useState<{ items: TextItem[]; viewport: { transform: number[]; scale: number } } | null>(null)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { root, rootMargin: NEAR })
    io.observe(el)
    return () => io.disconnect()
  }, [root])

  useEffect(() => {
    if (!near) return
    let stale = false
    let task: { cancel: () => void } | null = null
    let text: { cancel: () => void } | null = null
    ;(async () => {
      try {
        const [lib, pg] = await Promise.all([loadPdfjs(), pdf.getPage(n)])
        if (stale) return
        const viewport = pg.getViewport({ scale: width / pg.getViewport({ scale: 1 }).width })
        const dpr = window.devicePixelRatio || 1
        const c = canvas.current!
        c.width = Math.floor(viewport.width * dpr)
        c.height = Math.floor(viewport.height * dpr)
        setSize({ w: viewport.width, h: viewport.height, scale: viewport.scale })
        const render = pg.render({ canvas: c, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
        task = render
        const content = await pg.getTextContent()
        if (stale) return
        const layer = textLayer.current!
        layer.replaceChildren()
        const tl = new lib.TextLayer({ textContentSource: content, container: layer, viewport })
        text = tl
        await Promise.all([render.promise, tl.render()])
        if (stale) return
        // An end mark keeps a selection dragged past the last line from jumping to the page's start.
        const end = document.createElement('div')
        end.className = 'endOfContent'
        layer.append(end)
        setLayout({ items: content.items.filter((it): it is (typeof content.items)[number] & TextItem => 'str' in it), viewport })
      } catch (e) {
        if (stale || (e instanceof Error && e.name === 'RenderingCancelledException')) return
        console.warn(`Page ${n} couldn't be drawn`, e)
      }
    })()
    return () => {
      stale = true
      task?.cancel()
      text?.cancel()
    }
  }, [near, pdf, n, width])

  const boxes: [Highlight, Box[]][] = layout ? highlights.map((h) => [h, placeQuote(layout.items, h.text, layout.viewport)]) : []

  /** A click (not a selection) on a highlight opens its note. */
  function onClick(e: React.MouseEvent) {
    if (!window.getSelection()?.isCollapsed || !wrap.current) return
    const r = wrap.current.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const hit = boxes.find(([, bs]) => bs.some((b) => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height))
    if (hit) onOpenNote(hit[0], e.clientX, e.clientY + 12)
  }

  const w = size?.w ?? width
  const h = size?.h ?? width * aspect
  return (
    <div
      ref={wrap}
      className="reader-page"
      data-page={n}
      style={{ width: w, height: h, ['--total-scale-factor' as string]: size?.scale ?? 1 }}
      onClick={onClick}
    >
      <canvas ref={canvas} style={{ width: w, height: h }} aria-label={`Page ${n}`} />
      {boxes.map(([hl, bs]) =>
        bs.map((b, i) => <div key={`${hl.id}-${i}`} className={`reader-hl${hl.note ? ' noted' : ''}`} style={b} />),
      )}
      <div ref={textLayer} className="textLayer" />
      {boxes.map(([hl, bs]) =>
        hl.note && bs.length ? (
          <button
            key={hl.id}
            className="reader-note-mark"
            style={{ top: Math.min(...bs.map((b) => b.top)) }}
            title={hl.note}
            aria-label={`Note: ${hl.note}`}
            onClick={(e) => {
              e.stopPropagation()
              onOpenNote(hl, e.clientX, e.clientY + 12)
            }}
          >
            ✎
          </button>
        ) : null,
      )}
      <span className="reader-page-no">{n}</span>
    </div>
  )
}
