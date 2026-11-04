import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../useFocusTrap'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { api } from '../api'
import { type Box, loadPdfjs, pdfDocument, placeQuote } from '../pdf'
import type { Citation, Doc, Highlight } from '../types'

const MAX_WIDTH = 900 // the page's width on a wide screen; narrower windows fit the page to the window
const NEAR = '1200px' // pages this far outside the view are drawn in advance
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] // of the fitted width
const FIND = 'reader-find' // the CSS highlight that marks the current search match
const FIND_ALL = 'reader-find-all' // and the other matches on its page

type TextItem = { str: string; transform: number[]; width: number }

/** A popup for a selection (Highlight / Add note), or the note of a highlight being edited. */
type Popup =
  | { kind: 'select'; page: number; text: string; x: number; y: number }
  | { kind: 'tooLong'; x: number; y: number }
  | { kind: 'note'; hid: number; x: number; y: number }
  | { kind: 'said'; text: string; x: number; y: number } // what Insert in draft did

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
export function ReaderDialog({ doc, page, standalone = false, onClose, onInsertQuote }: {
  doc: Doc
  page: number
  standalone?: boolean
  onClose: () => void
  /** Over the app: put a quote and its citation into the draft. (As a window of its own, the
   * reader sends it to the main window through the bridge instead.) */
  onInsertQuote?: (c: Citation) => void
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [aspect, setAspect] = useState(1.294) // page height / width, from page 1 (A4 until it's read)
  const [error, setError] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [popup, setPopup] = useState<Popup | null>(null)
  const [draft, setDraft] = useState('') // the note being written
  const [busy, setBusy] = useState(false)
  const [room, setRoom] = useState(0) // the width a page can have in the window
  const [zoom, setZoom] = useState(1)
  const base = Math.min(MAX_WIDTH, room) // 100%: a comfortable reading width, or the window if narrower
  const width = Math.round(base * zoom)
  const fitZoom = base ? room / base : 1 // the zoom that fills the window's width
  const [current, setCurrent] = useState(page) // the page in view
  const [pageInput, setPageInput] = useState<string | null>(null) // while a page number is being typed
  const [railOpen, setRailOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<{ page: number; k: number }[]>([])
  const [at, setAt] = useState(-1) // the match shown
  const scroller = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)
  const keepPage = useRef<number | null>(null) // the page to stay on across a zoom
  const texts = useRef<Promise<string[]> | null>(null) // every page's text, lowercased, for Find
  const findBox = useRef<HTMLInputElement>(null)
  const pageBox = useRef<HTMLInputElement>(null)
  const frame = useRef(0)
  const numPages = pdf?.numPages ?? 0
  const dialog = useRef<HTMLDivElement>(null)
  useFocusTrap(dialog, !standalone) // over the app, Tab stays in the reader; as a window it needn't

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
      .then((hs) => {
        if (stale) return
        setHighlights(hs)
        if (hs.length) setRailOpen(true) // a paper with highlights opens with their list
      })
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
    const measure = () => setRoom(Math.max(0, Math.round(el.clientWidth - 48)))
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

  // A zoom keeps the page that was in view.
  useLayoutEffect(() => {
    if (keepPage.current == null) return
    scrollToPage(keepPage.current)
    keepPage.current = null
  }, [width])

  const closePopup = useCallback(() => {
    setPopup(null)
    setDraft('')
  }, [])

  function scrollToPage(n: number, block: ScrollLogicalPosition = 'start') {
    scroller.current?.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block })
  }

  function goToPage(n: number) {
    const p = Math.max(1, Math.min(numPages, n))
    setCurrent(p)
    scrollToPage(p)
  }

  function changeZoom(z: number) {
    keepPage.current = current
    setZoom(Math.max(ZOOMS[0], Math.min(Math.max(ZOOMS[ZOOMS.length - 1], fitZoom), z)))
  }
  const zoomIn = () => changeZoom(ZOOMS.find((z) => z > zoom + 0.001) ?? zoom)
  const zoomOut = () => changeZoom([...ZOOMS].reverse().find((z) => z < zoom - 0.001) ?? zoom)

  // The page in view: the first whose bottom is below a third of the way down.
  function onScroll() {
    if (popup && popup.kind !== 'note') closePopup()
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = scroller.current
      if (!el) return
      const y = el.getBoundingClientRect().top + el.clientHeight / 3
      for (const p of el.querySelectorAll<HTMLElement>('[data-page]')) {
        if (p.getBoundingClientRect().bottom >= y) {
          setCurrent(Number(p.dataset.page))
          break
        }
      }
    })
  }

  // Keys: Ctrl+F finds, Ctrl +/−/0 zoom the pages (not the window), Esc closes the innermost thing.
  // Re-attached every render, so it always sees the current state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        findBox.current?.focus()
        findBox.current?.select()
        return
      }
      if (ctrl && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
        e.preventDefault()
        e.stopPropagation()
        if (e.key === '0') changeZoom(1)
        else if (e.key === '-') zoomOut()
        else zoomIn()
        return
      }
      if (e.key !== 'Escape') return
      e.stopPropagation()
      const active = document.activeElement
      if (popup) closePopup()
      else if (active === findBox.current) {
        if (query) setQuery('')
        else findBox.current?.blur()
      } else if (active === pageBox.current) pageBox.current?.blur()
      else if (!standalone) onClose() // a window of its own closes like any window, not on Esc
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // Find: every page's text is read once, the first time something is searched for.
  useEffect(() => {
    const q = query.trim().toLowerCase()
    if (!pdf || q.length < 2) {
      setMatches([])
      setAt(-1)
      return
    }
    let stale = false
    const t = window.setTimeout(async () => {
      texts.current ??= Promise.all(
        Array.from({ length: pdf.numPages }, async (_, i) => {
          const content = await (await pdf.getPage(i + 1)).getTextContent()
          return content.items.map((it) => ('str' in it ? it.str : '')).join('').toLowerCase()
        }),
      )
      const all = await texts.current
      if (stale) return
      const found: { page: number; k: number }[] = []
      all.forEach((text, i) => {
        let from = 0
        let k = 0
        for (let idx = text.indexOf(q); idx >= 0 && found.length < 2000; idx = text.indexOf(q, from)) {
          found.push({ page: i + 1, k: k++ })
          from = idx + q.length
        }
      })
      setMatches(found)
      const next = found.findIndex((m) => m.page >= current)
      setAt(found.length ? Math.max(0, next) : -1)
    }, 200)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
    // `current` only picks where the first match is; it mustn't search again on every scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, pdf])

  // Show the current match: bring its page in, wait for its text layer, and mark the words.
  useEffect(() => {
    const m = matches[at]
    const q = query.trim().toLowerCase()
    markFind(null)
    if (!m) return
    const pageEl = scroller.current?.querySelector(`[data-page="${m.page}"]`)
    pageEl?.scrollIntoView({ block: 'center' })
    setCurrent(m.page)
    let cancelled = false
    const started = performance.now()
    const tryMark = () => {
      if (cancelled) return
      const layer = pageEl?.querySelector('.textLayer')
      if (layer?.querySelector('.endOfContent')) {
        const ranges = rangesOf(layer, q)
        const range = ranges[m.k]
        markFind(range ?? null, ranges)
        range?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
        return
      }
      if (performance.now() - started < 6000) requestAnimationFrame(tryMark)
    }
    requestAnimationFrame(tryMark)
    return () => {
      cancelled = true
    }
    // A new search sets new matches; a zoom redraws the text layer, so the mark is placed again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, matches, width])

  useEffect(() => () => markFind(null), [])

  const stepMatch = (by: 1 | -1) => {
    if (matches.length) setAt((a) => (a + by + matches.length) % matches.length)
  }

  /** Scroll to a highlight on its page and make it flash. */
  function showHighlight(h: Highlight) {
    const pageEl = scroller.current?.querySelector(`[data-page="${h.page}"]`)
    pageEl?.scrollIntoView({ block: 'start' })
    const started = performance.now()
    const find = () => {
      const boxes = pageEl?.querySelectorAll<HTMLElement>(`.reader-hl[data-hid="${h.id}"]`)
      if (boxes?.length) {
        boxes[0].scrollIntoView({ block: 'center' })
        boxes.forEach((b) => {
          b.classList.remove('flash')
          void b.offsetWidth // restart the animation
          b.classList.add('flash')
        })
        return
      }
      if (performance.now() - started < 6000) requestAnimationFrame(find)
    }
    requestAnimationFrame(find)
  }

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

  // Where a quote can go: the app's draft, directly or from this window through the bridge.
  const sendQuote = standalone ? window.rc?.insertQuote : onInsertQuote && (async (c: Citation) => onInsertQuote(c))

  /** The selection, into the draft as a quote citing this page. Its place in the paper's stored text is
   * found first, so the citation can be opened and checked like any other. */
  async function insertQuote() {
    if (popup?.kind !== 'select' || !sendQuote) return
    const { page: at, text, x, y } = popup
    setBusy(true)
    try {
      const [found] = await api.resolveCitations([{ doc_id: doc.id, page: at, quote: text }])
      if (!found) {
        setPopup({ kind: 'said', text: "This text couldn't be found in the paper's stored text, so it can't be cited. Try a shorter passage.", x, y })
        return
      }
      await sendQuote({
        chunk_id: found.chunk_id,
        doc_id: doc.id,
        page: found.page,
        page_label: found.page_label,
        quote: text,
        start: found.start,
        end: found.end,
        match: found.match,
        label: found.label,
        status: 'verified',
        reason: 'Quoted from the paper while reading it.',
      })
      window.getSelection()?.removeAllRanges()
      setPopup({ kind: 'said', text: `Quoted in your draft as ${found.label}.`, x, y })
      window.setTimeout(() => setPopup((p) => (p?.kind === 'said' ? null : p)), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      closePopup()
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
  const inOrder = [...highlights].sort((a, b) => a.page - b.page || (a.start ?? 0) - (b.start ?? 0))
  const searching = query.trim().length >= 2

  return (
    <div className={standalone ? 'reader-window' : 'modal-backdrop'} onMouseDown={(e) => !standalone && e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="modal pdf-view" role={standalone ? 'main' : 'dialog'} aria-modal={!standalone} aria-label={`PDF: ${doc.title}`}>
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
        <div className="reader-tools" role="toolbar" aria-label="Reader tools">
          <div className="reader-group">
            <button className="icon" onClick={() => goToPage(current - 1)} disabled={!pdf || current <= 1} aria-label="Previous page" title="Previous page">
              ‹
            </button>
            <label className="reader-pager">
              Page
              <input
                ref={pageBox}
                inputMode="numeric"
                aria-label="Page number"
                value={pageInput ?? String(current)}
                disabled={!pdf}
                onFocus={(e) => {
                  setPageInput(String(current))
                  e.currentTarget.select()
                }}
                onBlur={() => setPageInput(null)}
                onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  if (pageInput) goToPage(Number(pageInput))
                  e.currentTarget.blur()
                }}
              />
              of {numPages || '…'}
            </label>
            <button className="icon" onClick={() => goToPage(current + 1)} disabled={!pdf || current >= numPages} aria-label="Next page" title="Next page">
              ›
            </button>
          </div>
          <div className="reader-group">
            <button className="icon" onClick={zoomOut} disabled={zoom <= ZOOMS[0]} aria-label="Zoom out" title="Zoom out (Ctrl −)">
              −
            </button>
            <span className="reader-zoom" aria-live="polite" title="100% is a comfortable reading width (Ctrl 0)">
              {Math.round(zoom * 100)}%
            </span>
            <button className="icon" onClick={zoomIn} disabled={zoom >= ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in" title="Zoom in (Ctrl +)">
              +
            </button>
            <button className="link" onClick={() => changeZoom(fitZoom)} disabled={Math.abs(zoom - fitZoom) < 0.01} title="Fill the window's width with the page">
              Fit width
            </button>
          </div>
          <div className="reader-group reader-find">
            <input
              ref={findBox}
              type="search"
              value={query}
              placeholder="Find in this paper (Ctrl F)"
              aria-label="Find in this paper"
              disabled={!pdf}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  stepMatch(e.shiftKey ? -1 : 1)
                }
              }}
            />
            {searching && (
              <span className="reader-find-count" aria-live="polite">
                {matches.length ? `${at + 1} of ${matches.length}${matches.length >= 2000 ? '+' : ''}` : 'No matches'}
              </span>
            )}
            {searching && matches.length > 1 && (
              <>
                <button className="icon" onClick={() => stepMatch(-1)} aria-label="Previous match" title="Previous match (Shift Enter)">
                  ↑
                </button>
                <button className="icon" onClick={() => stepMatch(1)} aria-label="Next match" title="Next match (Enter)">
                  ↓
                </button>
              </>
            )}
          </div>
          <span className="spacer" />
          <button className={`reader-rail-toggle${railOpen ? ' on' : ''}`} aria-pressed={railOpen} onClick={() => setRailOpen((o) => !o)}>
            Highlights · {highlights.length}
          </button>
        </div>
        <div className="reader-body">
          <div className="reader" ref={scroller} onMouseUp={onMouseUp} onScroll={onScroll}>
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
          {railOpen && (
            <aside className="reader-rail" aria-label="Highlights in this paper">
              <div className="reader-rail-head">
                <b>Highlights</b>
                <span className="muted">{highlights.length}</span>
                <span className="spacer" />
                <button className="icon" onClick={() => setRailOpen(false)} aria-label="Close the highlights list" title="Close the list">
                  ×
                </button>
              </div>
              {inOrder.length === 0 ? (
                <p className="muted reader-rail-empty">
                  Select text on a page, then <b>Highlight</b> or <b>Add note</b>. Your highlights are listed here, and in the{' '}
                  <b>Highlights</b> tab while you write.
                </p>
              ) : (
                <ul>
                  {inOrder.map((h) => (
                    <li key={h.id}>
                      <button onClick={() => showHighlight(h)} title="Show it on the page">
                        <span className="reader-rail-page">p. {h.page}</span>
                        <span className="reader-rail-text">{h.text}</span>
                        {h.note && <span className="reader-rail-note">✎ {h.note}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          )}
        </div>
        {popup?.kind === 'select' && (
          <div className="reader-popup" style={place(popup)} role="toolbar" aria-label="Highlight the selection">
            <button className="primary" disabled={busy} onClick={() => highlight(false)}>
              Highlight
            </button>
            <button disabled={busy} onClick={() => highlight(true)}>
              Add note
            </button>
            {sendQuote && (
              <button disabled={busy} onClick={insertQuote} title="Put this passage into your draft as a quote, citing this page">
                Insert in draft
              </button>
            )}
          </div>
        )}
        {popup?.kind === 'said' && (
          <div className="reader-popup" style={place(popup)} role="status">
            <span>{popup.text}</span>
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

/** Every occurrence of `q` (lowercase) in a page's text layer, as DOM ranges, in order. The layer's
 * text is the page's text items joined, as Find reads them, so the k-th here is Find's k-th. */
function rangesOf(layer: Element, q: string): Range[] {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    starts.push(text.length)
    nodes.push(n as Text)
    text += (n as Text).data
  }
  text = text.toLowerCase()
  if (!nodes.length) return []
  const locate = (pos: number, end: boolean) => {
    let i = starts.length - 1
    while (i > 0 && (end ? starts[i] >= pos : starts[i] > pos)) i--
    return [nodes[i], pos - starts[i]] as const
  }
  const out: Range[] = []
  for (let idx = text.indexOf(q); idx >= 0; idx = text.indexOf(q, idx + q.length)) {
    const [startNode, startAt] = locate(idx, false)
    const [endNode, endAt] = locate(idx + q.length, true)
    const r = document.createRange()
    r.setStart(startNode, startAt)
    r.setEnd(endNode, endAt)
    out.push(r)
  }
  return out
}

/** Mark the current match, and the page's other matches more lightly, with CSS custom highlights
 * (no DOM changes); with no range, clear both. `Highlight` here is the DOM's, not the paper's. */
function markFind(current: Range | null, all: Range[] = []) {
  if (!('highlights' in CSS)) return
  CSS.highlights.delete(FIND)
  CSS.highlights.delete(FIND_ALL)
  if (!current) return
  const others = all.filter((r) => r !== current)
  if (others.length) CSS.highlights.set(FIND_ALL, new globalThis.Highlight(...others))
  const strong = new globalThis.Highlight(current)
  strong.priority = 1 // drawn over the lighter marks
  CSS.highlights.set(FIND, strong)
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

  // Until a zoomed page is drawn again, it takes its new size from its own shape.
  const w = width
  const h = size ? (Math.abs(size.w - width) < 1 ? size.h : (width * size.h) / size.w) : width * aspect
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
        bs.map((b, i) => <div key={`${hl.id}-${i}`} data-hid={hl.id} className={`reader-hl${hl.note ? ' noted' : ''}`} style={b} />),
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
