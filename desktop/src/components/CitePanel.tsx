import { useEffect, useState } from 'react'
import type { CiteMarkAttrs, CiteMarkState } from '../editor/citeMark'
import type { Citation } from '../types'
import { StatusBadge } from './StatusBadge'
import { WaitStatus } from './WaitStatus'
import { useCheckingMarkers, type ChipAttrs } from './WritingEditor'
import { CITATION_RANK, CITATION_WORD, isFlagged } from '../editor/citeStatus'

interface Props {
  /** The draft's cite markers, in document order. */
  marks: CiteMarkAttrs[]
  /** The marker being reviewed (clicked in the draft or picked from the list), if any. */
  focus: string | null
  onFocus: (cid: string | null) => void
  onConfirm: (cid: string, c: Citation) => void
  onRecheck: (cid: string) => void
  /** Citation chips in the draft, for the Recheck all button. */
  citations: number
  rechecking: boolean
  onRecheckAll: () => void
  onRemove: (cid: string) => void
  onOpenSource: (c: Citation) => void
  /** The draft's citation chips, in document order. */
  chips: ChipAttrs[]
  /** Open a chip's quote on its page, as clicking it in the draft does. */
  onOpenChip: (chip: ChipAttrs) => void
  /** Select a chip in the draft and scroll to it, leaving this tab open. */
  onShowChip: (cid: string) => void
  /** Check one citation again, for its sentence as it reads now. */
  onCheckChip: (chip: ChipAttrs) => void
}

/** Every citation in the draft, what needs attention first; ‹ › step through the flagged ones in
 * the draft. A row opens the quote, as the chip does. */
function CitationList({ chips, onOpen, onShow, onCheck }: { chips: ChipAttrs[]; onOpen: (c: ChipAttrs) => void; onShow: (cid: string) => void; onCheck: (c: ChipAttrs) => void }) {
  const flagged = chips.filter((c) => isFlagged(c.status)) // in document order, for ‹ ›
  const [current, setCurrent] = useState<string | null>(null)
  const at = flagged.findIndex((c) => c.cid === current)
  const sorted = [...chips].sort((a, b) => CITATION_RANK[a.status] - CITATION_RANK[b.status]) // stable: draft order within a state

  function step(by: 1 | -1) {
    if (!flagged.length) return
    const next = flagged[at < 0 ? (by > 0 ? 0 : flagged.length - 1) : (at + by + flagged.length) % flagged.length]
    setCurrent(next.cid)
    onShow(next.cid)
  }

  return (
    <section className="cite-list" aria-label="Citations in this draft">
      <div className="cite-list-head">
        <h4 className="eyebrow">
          In this draft · {chips.length}
          {flagged.length > 0 && <span className="cite-list-flagged"> · {flagged.length} flagged</span>}
        </h4>
        {flagged.length > 0 && (
          <div className="cite-step">
            <button className="icon" onClick={() => step(-1)} aria-label="Previous flagged citation" title="Previous flagged citation">‹</button>
            <span aria-live="polite">{at < 0 ? `${flagged.length} flagged` : `${at + 1} of ${flagged.length}`}</span>
            <button className="icon" onClick={() => step(1)} aria-label="Next flagged citation" title="Next flagged citation">›</button>
          </div>
        )}
      </div>
      <ul className="cite-list-rows">
        {sorted.map((c) => (
          <li key={c.cid}>
            <button
              className={`cite-list-row${isFlagged(c.status) ? ' flagged' : ''}${c.cid === current ? ' current' : ''}`}
              onClick={() => {
                setCurrent(c.cid)
                onOpen(c)
              }}
              title="Show this citation's quote on its page"
              // A short name; the reason, when flagged, is read as the description.
              aria-label={`${c.label}, ${CITATION_WORD[c.status]}${c.claim ? `: ${c.claim.length > 90 ? c.claim.slice(0, 90) + '…' : c.claim}` : ''}`}
              aria-describedby={isFlagged(c.status) && c.reason ? `cite-why-${c.cid}` : undefined}
            >
              <span className={`cite cite-${c.status}${c.finding != null ? ' cite-matrix' : ''}`} aria-hidden="true">{c.label}</span>
              <span className="cite-list-claim" aria-hidden="true">{c.claim || 'No sentence recorded'}</span>
              {isFlagged(c.status) && c.reason && <span className="cite-list-reason" id={`cite-why-${c.cid}`}>{c.reason}</span>}
            </button>
            <div className="cite-list-actions">
              <button className="link" onClick={() => onOpen(c)}>
                See quote ›
              </button>
              <button className="link" onClick={() => onShow(c.cid)}>
                Show in draft
              </button>
              <button className="link" disabled={c.status === 'pending'} onClick={() => onCheck(c)} title="Check it again against its sentence as it reads now">
                {c.status === 'pending' ? 'Checking…' : 'Check again'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

const HEADLINE: Record<CiteMarkState, string> = {
  searching: 'Looking for a source…',
  verified: 'A source supports this sentence',
  weak: 'Only partial support found',
  unsupported: 'No source supports this sentence',
  none: 'Nothing in your library matches this sentence',
  error: "The search didn't finish",
}

/** Cite markers waiting for the writer: what each search found, and confirming a source. */
export function CitePanel({ marks, chips, citations, rechecking, onRecheckAll, focus, onFocus, onConfirm, onRecheck, onRemove, onOpenSource, onOpenChip, onShowChip, onCheckChip }: Props) {
  const mark = focus ? marks.find((m) => m.cid === focus) : undefined
  const checking = useCheckingMarkers()
  // While any marker is still searching: since when (the wait line counts from the first).
  const searchingCount = marks.filter((m) => m.state === 'searching').length
  const [searchingSince, setSearchingSince] = useState<number | null>(null)
  useEffect(() => {
    setSearchingSince((t) => (searchingCount ? t ?? Date.now() : null))
  }, [searchingCount])

  if (!mark) {
    const intro = (
      <p className="cite-intro">
        Put the cursor in a sentence (or select text) and press <strong>Cite</strong> (Ctrl+Shift+C). A grey{' '}
        <span className="cite-mark cite-mark-searching">cite</span> marker appears and you keep writing; it turns{' '}
        <span className="cite-mark cite-mark-verified">cite</span> when a source supports the sentence,{' '}
        <span className="cite-mark cite-mark-weak">cite</span> for partial support, and{' '}
        <span className="cite-mark cite-mark-unsupported">cite</span> when nothing does. Click it to confirm a source.
        <br />
        Confirmed citations show the same: <span className="cite cite-verified">Smith 2020</span> supported,{' '}
        <span className="cite cite-weak">Smith 2020</span> and <span className="cite cite-unsupported">Smith 2020</span>. Blue ones,{' '}
        <span className="cite cite-verified cite-matrix">Smith 2020</span>, were written from a review matrix and are checked against it.
      </p>
    )
    return (
      <div className="cite-panel">
        {searchingCount > 0 && searchingSince && (
          <WaitStatus
            label={`Checking ${searchingCount} sentence${searchingCount === 1 ? '' : 's'} against your library…`}
            startedAt={searchingSince}
            usual="Three are checked at a time; each takes a few seconds. Keep writing."
          />
        )}
        {chips.length + marks.length > 0 ? (
          <details className="cite-howto">
            <summary>How citing works</summary>
            {intro}
          </details>
        ) : (
          intro
        )}
        {citations + marks.length > 0 && (
          <div className="cite-recheck">
            <button onClick={onRecheckAll} disabled={rechecking}>
              {rechecking ? 'Rechecking…' : 'Recheck all citations'}
            </button>
            <span className="hint">
              {rechecking
                ? 'Each citation shows as grey until its check finishes. Keep writing.'
                : 'Checks every citation against its sentence as it reads now (blue ones, written from a review matrix, against the matrix), and searches again for every marker.'}
            </span>
          </div>
        )}
        {marks.length > 0 && (
          <>
            <h4 className="eyebrow">Waiting for you · {marks.length}</h4>
            <ul className="cite-queue">
              {marks.map((m) => (
                <li key={m.cid}>
                  <button onClick={() => onFocus(m.cid)} title={HEADLINE[m.state]}>
                    <span className={`cite-mark cite-mark-${m.state}`}>cite</span>
                    <span className="cite-queue-claim">
                      {m.claim}
                      {m.state === 'searching' && <em className="cite-queue-state">{checking.has(m.cid) ? 'Checking…' : 'Waiting its turn'}</em>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {chips.length > 0 && <CitationList chips={chips} onOpen={onOpenChip} onShow={onShowChip} onCheck={onCheckChip} />}
      </div>
    )
  }

  const results = mark.results ?? []
  return (
    <div className="cite-panel">
      {marks.length > 1 && (
        <button className="link cite-back" onClick={() => onFocus(null)}>
          ‹ All {marks.length} waiting
        </button>
      )}
      <div className={`cite-head cite-head-${mark.state}`}>
        <span className={`cite-mark cite-mark-${mark.state}`}>cite</span>
        <b>{HEADLINE[mark.state]}</b>
      </div>
      <blockquote className="cite-claim">{mark.claim}</blockquote>
      {mark.state === 'searching' && <p className="busy">Searching your library and checking each passage against the sentence. Keep writing.</p>}
      {mark.state === 'error' && <p className="warn">The backend didn't answer. Try again in a moment.</p>}
      {(mark.state === 'unsupported' || mark.state === 'none') && (
        <p className="warn">You may need to add a source for this, reword the sentence, or remove the marker.</p>
      )}

      {results.map((r, i) => (
        <div key={`${r.chunk_id}:${i}`} className={`suggestion suggestion-${r.status}`}>
          <div className="row">
            <StatusBadge status={r.status} />
            <span className="suggestion-label">{r.label}</span>
          </div>
          <p className="suggestion-quote">“{r.quote}”</p>
          {r.reason && <p className="reason">{r.reason}</p>}
          <div className="row">
            <button onClick={() => onOpenSource(r)}>View source</button>
            <button
              className={i === 0 && r.status === 'verified' ? 'primary' : ''}
              disabled={r.status === 'quote_not_found'}
              onClick={() => onConfirm(mark.cid, r)}
            >
              Use this source
            </button>
          </div>
        </div>
      ))}

      <div className="cite-foot">
        <button onClick={() => onRecheck(mark.cid)} disabled={mark.state === 'searching'} title="Search again for the sentence as it reads now">
          Check again
        </button>
        <button className="link danger-link" onClick={() => onRemove(mark.cid)}>
          Remove marker
        </button>
      </div>
    </div>
  )
}
