import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Citation, DraftSentence, FetchedHighlight } from '../types'
import { DraftPreview, verifyAll, withCids } from './DraftPreview'
import { WaitStatus } from './WaitStatus'

interface Props {
  /** Shown: each time the tab opens, it fetches for where the cursor is now. */
  visible: boolean
  /** The paragraph being written (or the draft's end), to rank highlights for. */
  getContext: () => string
  getDraft: () => string
  onInsert: (sentences: DraftSentence[]) => void
  onVerified: (cid: string, result: Citation) => void
  onOpenCitation: (c: Citation) => void
  onOpenPage: (docId: number, page: number) => void
  onError: (msg: string) => void
}

/** What was highlighted and noted while reading, fetched for the paragraph being written: insert a
 * highlight as a quote (already cited and verified), or have Muse write from the ticked ones. */
export function HighlightsPanel({ visible, getContext, getDraft, onInsert, onVerified, onOpenCitation, onOpenPage, onError }: Props) {
  const [items, setItems] = useState<FetchedHighlight[] | null>(null)
  const [forText, setForText] = useState('') // the paragraph they were ranked for
  const [fetching, setFetching] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [sentences, setSentences] = useState<DraftSentence[] | null>(null)
  const [writing, setWriting] = useState(false)
  const [writeNo, setWriteNo] = useState(0)
  const [startedAt, setStartedAt] = useState(0)
  const controller = useRef<AbortController | null>(null)

  async function fetchFor() {
    const context = getContext().trim()
    setFetching(true)
    try {
      setItems(await api.fetchHighlights(context))
      setForText(context)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setFetching(false)
    }
  }

  useEffect(() => {
    if (visible) fetchFor()
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
    <div className="assistant highlights-panel">
      <div className="row">
        <span className="muted">
          {forText ? (
            <>
              For: <i title={forText}>“{forText.length > 70 ? forText.slice(0, 70) + '…' : forText}”</i>
            </>
          ) : (
            'Newest first. Click into a paragraph and fetch to rank them for it.'
          )}
        </span>
        <button className="primary" disabled={fetching} onClick={fetchFor} title="Rank your highlights and notes for the paragraph the cursor is in">
          {fetching ? 'Fetching…' : 'Fetch'}
        </button>
      </div>

      {items && items.length === 0 && (
        <div className="lib-empty">
          <div className="lib-empty-title">No highlights yet</div>
          <p>Open a paper (double-click it in the Library), select text and click Highlight. Add a note for an idea while you read.</p>
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="hl-list">
          {items.map((h) => (
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
          <button className="link" onClick={() => setPicked(picked.size ? new Set() : new Set(citable.map((h) => h.id)))}>
            {picked.size ? 'Select none' : 'Select all'}
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
        <DraftPreview key={writeNo} sentences={sentences} onInsert={onInsert} onOpenCitation={onOpenCitation} />
      )}
    </div>
  )
}
