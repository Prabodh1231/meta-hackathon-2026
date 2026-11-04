import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Citation, DraftSentence, FetchedHighlight } from '../types'
import { DraftPreview, verifyAll, withCids } from './DraftPreview'
import { WaitStatus } from './WaitStatus'

interface Props {
  /** Shown: it ranks for where the cursor is when shown, and again as the cursor moves to another paragraph. */
  visible: boolean
  /** The paragraph being written (or the draft's end), to rank highlights for. */
  getContext: () => string
  getDraft: () => string
  /** A highlight inserted as a quote: the paper's own words. */
  onInsert: (sentences: DraftSentence[]) => void
  /** Sentences Muse wrote from the ticked highlights. */
  onInsertDraft: (sentences: DraftSentence[]) => void
  onVerified: (cid: string, result: Citation) => void
  onOpenCitation: (c: Citation) => void
  onOpenPage: (docId: number, page: number) => void
  onError: (msg: string) => void
}

const SHOWN = 3 // highlights shown before "Show all", so the Muse box below stays in view

/** What was highlighted and noted while reading, ranked for the paragraph being written: insert a
 * highlight as a quote (already cited and verified), or have Muse write from the ticked ones. It
 * updates by itself as the cursor moves between paragraphs. */
export function HighlightsPanel({ visible, getContext, getDraft, onInsert, onInsertDraft, onVerified, onOpenCitation, onOpenPage, onError }: Props) {
  const [items, setItems] = useState<FetchedHighlight[] | null>(null)
  const [forText, setForText] = useState('') // the paragraph they were ranked for
  const [fetching, setFetching] = useState(false)
  const [all, setAll] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [sentences, setSentences] = useState<DraftSentence[] | null>(null)
  const [writing, setWriting] = useState(false)
  const [writeNo, setWriteNo] = useState(0)
  const [startedAt, setStartedAt] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const busy = useRef(false)

  async function fetchFor() {
    if (busy.current) return
    const context = getContext().trim()
    busy.current = true
    setFetching(true)
    try {
      setItems(await api.fetchHighlights(context))
      setForText(context)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      busy.current = false
      setFetching(false)
    }
  }

  useEffect(() => {
    if (visible) fetchFor()
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

  // The cursor moved to another paragraph: rank again for it (not while some are ticked, so a pick
  // in progress isn't reordered under the pointer). Ranking is local and quick, so a light poll will do.
  useEffect(() => {
    if (!visible || picked.size || writing) return
    const t = window.setInterval(() => {
      const now = getContext().trim()
      if (now && now !== forText) fetchFor()
    }, 2500)
    return () => window.clearInterval(t)
  }, [visible, picked, writing, forText]) // eslint-disable-line react-hooks/exhaustive-deps

  // Back from the reader's window with new highlights: show them. (Only once nothing's ticked.)
  useEffect(() => {
    if (!visible) return
    const onFocus = () => !picked.size && fetchFor()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [visible, picked]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: number) =>
    setPicked((p) => {
      const n = new Set(p)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  function insertQuote(h: FetchedHighlight) {
    if (!h.citation) return
    // The chip keeps the page's exact text (line breaks too), to find it again; the sentence reads as one line.
    const [s] = withCids([{ text: `“${h.citation.quote.replace(/\s+/g, ' ').trim()}”`, citations: [h.citation] }])
    onInsert([s])
  }

  async function write() {
    const ctrl = new AbortController()
    controller.current = ctrl
    setWriting(true)
    setStartedAt(Date.now())
    setSentences(null)
    setWriteNo((n) => n + 1)
    try {
      const res = await api.writeFromHighlights([...picked], getDraft(), ctrl.signal)
      if (ctrl.signal.aborted) return
      const withIds = withCids(res.sentences)
      setSentences(withIds)
      verifyAll(withIds, setSentences, onVerified, onError)
    } catch (e) {
      if (!ctrl.signal.aborted) onError(e instanceof Error ? e.message : String(e))
    } finally {
      if (controller.current === ctrl) setWriting(false)
    }
  }

  const citable = items?.filter((h) => h.citation) ?? []
  // Ticked ones stay in view even past the first few.
  const shown = items ? (all ? items : items.filter((h, i) => i < SHOWN || picked.has(h.id))) : []

  return (
    <section className="highlights-panel" aria-label="From your reading">
      <div className="hl-head">
        <h4 className="eyebrow">From your reading{items && items.length > 0 ? ` · ${items.length}` : ''}</h4>
        <span className="hl-for muted" title={forText || undefined}>
          {fetching ? 'ranking…' : !items?.length ? '' : forText ? 'best for the paragraph at your cursor' : 'newest first'}
        </span>
      </div>

      {items && items.length === 0 && (
        <p className="hl-empty muted">
          No highlights yet. Open a paper (double-click it in the Library), select text and click Highlight; add a note for an idea.
          They show here, best first for the paragraph you're writing.
        </p>
      )}

      {items && items.length > 0 && (
        <ul className="hl-list">
          {shown.map((h) => (
            <li key={h.id} className={`hl-item${picked.has(h.id) ? ' picked' : ''}`}>
              <label className="hl-pick">
                <input
                  type="checkbox"
                  disabled={!h.citation}
                  checked={picked.has(h.id)}
                  onChange={() => toggle(h.id)}
                  aria-label="Write from this highlight"
                />
                <blockquote>{h.text}</blockquote>
              </label>
              {h.note && <p className="hl-note">✎ {h.note}</p>}
              <div className="hl-meta">
                <button className="link" onClick={() => onOpenPage(h.doc_id, h.page)} title={h.doc_title}>
                  {h.label}
                </button>
                <span className="spacer" />
                {h.citation ? (
                  <button onClick={() => insertQuote(h)} title="Insert it as a quote, cited and verified">
                    Insert quote
                  </button>
                ) : (
                  <span className="muted" title="The highlighted text wasn't found in the paper's stored text, so it can't be cited">
                    Can't be cited
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {citable.length > 0 && (
        <div className="row hl-actions">
          {items && items.length > SHOWN ? (
            <button className="link" onClick={() => setAll((a) => !a)}>
              {all ? 'Show fewer' : `Show all ${items.length}`}
            </button>
          ) : (
            <span />
          )}
          <button className="link" onClick={() => setPicked(picked.size ? new Set() : new Set(citable.map((h) => h.id)))}>
            {picked.size ? 'Tick none' : 'Tick all'}
          </button>
          <button className="primary" disabled={!picked.size || writing} onClick={write} title="Muse writes sentences from the ticked highlights, guided by their notes, each cited and checked">
            {writing ? 'Writing…' : picked.size ? `Write from ${picked.size}` : 'Tick highlights to write from'}
          </button>
        </div>
      )}

      {writing && (
        <WaitStatus
          label="Writing from your highlights…"
          startedAt={startedAt}
          usual="This usually takes 10 to 30 seconds."
          onCancel={() => {
            controller.current?.abort()
            setWriting(false)
          }}
          cancelTitle="Stop waiting. Muse may still finish in the background; nothing is inserted."
        />
      )}
      {sentences && sentences.length === 0 && <p className="empty">Muse couldn't write anything these highlights back. Try ticking others.</p>}
      {sentences && sentences.length > 0 && (
        <DraftPreview key={writeNo} sentences={sentences} onInsert={onInsertDraft} onOpenCitation={onOpenCitation} />
      )}
    </section>
  )
}
