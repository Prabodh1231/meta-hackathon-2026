import { useEffect, useState } from 'react'
import { stillChecking, type CiteMarkAttrs, type CiteMarkState } from '../editor/citeMark'
import type { Citation } from '../types'
import { StatusBadge } from './StatusBadge'
import { WaitStatus } from './WaitStatus'
import { useCheckingMarkers, type ChipAttrs } from './WritingEditor'
import { CITATION_WORD, MARK_WORD, isFlagged } from '../editor/citeStatus'

interface Props {
  /** The draft's cite markers, in document order. */
  marks: CiteMarkAttrs[]
  /** The marker being reviewed (clicked in the draft or picked from the list), if any. */
  focus: string | null
  onFocus: (cid: string | null) => void
  onConfirm: (cid: string, c: Citation) => void
  onRecheck: (cid: string) => void
  onRemove: (cid: string) => void
  onOpenSource: (c: Citation) => void
  /** The draft's citation chips, in document order. */
  chips: ChipAttrs[]
  /** Open a chip's quote on its page, as clicking it in the draft does. */
  onOpenChip: (chip: ChipAttrs) => void
  /** Select a chip or marker in the draft and scroll to it, leaving this panel open. */
  onShowChip: (cid: string) => void
  /** Check one citation again, for its sentence as it reads now. */
  onCheckChip: (chip: ChipAttrs) => void
}

function ChipRow({ c, current, onOpen, onShow, onCheck, onPick }: { c: ChipAttrs; current: boolean; onOpen: (c: ChipAttrs) => void; onShow: (cid: string) => void; onCheck: (c: ChipAttrs) => void; onPick: (cid: string) => void }) {
  const flagged = isFlagged(c.status)
  return (
    <li>
      <button
        className={`cite-list-row${flagged ? ' flagged' : ''}${current ? ' current' : ''}`}
        onClick={() => {
          onPick(c.cid)
          onOpen(c)
        }}
        title="Show this citation's quote on its page"
        // A short name; the reason, when flagged, is read as the description.
        aria-label={`${c.label}, ${CITATION_WORD[c.status]}${c.claim ? `: ${c.claim.length > 90 ? c.claim.slice(0, 90) + '…' : c.claim}` : ''}`}
        aria-describedby={flagged && c.reason ? `cite-why-${c.cid}` : undefined}
      >
        <span className={`cite cite-${c.status}${c.finding != null ? ' cite-matrix' : ''}`} aria-hidden="true">{c.label}</span>
        <span className="cite-list-claim" aria-hidden="true">{c.claim || 'No sentence recorded'}</span>
        {flagged && c.reason && <span className="cite-list-reason" id={`cite-why-${c.cid}`}>{c.reason}</span>}
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
  )
}

function MarkRow({ m, checking, onFocus }: { m: CiteMarkAttrs; checking: boolean; onFocus: (cid: string) => void }) {
  return (
    <li>
      <button onClick={() => onFocus(m.cid)} title={m.state === 'searching' ? MARK_WORD.searching : 'See what was found and confirm a source'}>
        <span className={`cite-mark cite-mark-${m.state}`}>cite</span>
        <span className="cite-queue-text">
          <span className="cite-queue-claim">{m.claim}</span>
          <em className={`cite-queue-state cite-queue-${m.state}`}>
            {m.state === 'searching' ? (checking ? 'Finding a source…' : 'Waiting its turn') : MARK_WORD[m.state]}
          </em>
        </span>
      </button>
    </li>
  )
}

const HEADLINE: Record<CiteMarkState, string> = {
  searching: 'Finding a source…',
  verified: 'Source found: confirm it',
  weak: 'Partly supported by what was found',
  unsupported: 'Not supported by what was found',
  none: 'No source found in your library',
  error: "The search didn't finish",
}

/** Check's citations: what needs the writer first (flagged citations, and markers waiting to be
 * confirmed), then what's still being checked; supported ones fold away. ‹ › step through the
 * ones that need attention in the draft. A marker opens what its search found, to confirm a source. */
export function CitePanel({ marks, chips, focus, onFocus, onConfirm, onRecheck, onRemove, onOpenSource, onOpenChip, onShowChip, onCheckChip }: Props) {
  const mark = focus ? marks.find((m) => m.cid === focus) : undefined
  const checking = useCheckingMarkers()
  const [current, setCurrent] = useState<string | null>(null)
  // While any marker is still searching: since when (the wait line counts from the first).
  const searchingCount = marks.filter((m) => m.state === 'searching').length
  const [searchingSince, setSearchingSince] = useState<number | null>(null)
  useEffect(() => {
    setSearchingSince((t) => (searchingCount ? t ?? Date.now() : null))
  }, [searchingCount])

  if (!mark) {
    const waiting = marks.filter((m) => m.state !== 'searching')
    const looking = marks.filter((m) => m.state === 'searching')
    const flagged = chips.filter((c) => isFlagged(c.status))
    const pending = chips.filter((c) => c.status === 'pending')
    const supported = chips.filter((c) => c.status === 'verified')
    const attention = [...waiting.map((m) => m.cid), ...flagged.map((c) => c.cid)]
    const at = attention.indexOf(current ?? '')
    const step = (by: 1 | -1) => {
      if (!attention.length) return
      const next = attention[at < 0 ? (by > 0 ? 0 : attention.length - 1) : (at + by + attention.length) % attention.length]
      setCurrent(next)
      onShowChip(next)
    }
    const row = (c: ChipAttrs) => (
      <ChipRow key={c.cid} c={c} current={c.cid === current} onOpen={onOpenChip} onShow={onShowChip} onCheck={onCheckChip} onPick={setCurrent} />
    )

    if (!chips.length && !marks.length) {
      return (
        <div className="cite-panel">
          <p className="cite-intro">
            Nothing to check yet. Put the cursor in a sentence (or select text) and press <strong>Cite</strong> (Ctrl+Shift+C): a{' '}
            <span className="cite-mark cite-mark-searching">cite</span> marker appears while a source is found, and you keep writing.
            Click it to confirm the source. Drafts from <strong>Compose</strong> arrive cited and checked.
          </p>
        </div>
      )
    }

    return (
      <div className="cite-panel">
        {searchingCount > 0 && searchingSince && (
          <WaitStatus
            label={`Finding sources for ${searchingCount} sentence${searchingCount === 1 ? '' : 's'}…`}
            startedAt={searchingSince}
            usual="Three are checked at a time; each takes a few seconds. Keep writing."
          />
        )}
        {attention.length > 0 ? (
          <section className="cite-list" aria-label="Citations that need your attention">
            <div className="cite-list-head">
              <h4 className="eyebrow">Needs your attention · {attention.length}</h4>
              <div className="cite-step">
                <button className="icon" onClick={() => step(-1)} aria-label="Previous one that needs attention" title="Previous">‹</button>
                <span aria-live="polite">{at < 0 ? `${attention.length}` : `${at + 1} of ${attention.length}`}</span>
                <button className="icon" onClick={() => step(1)} aria-label="Next one that needs attention" title="Next">›</button>
              </div>
            </div>
            {waiting.length > 0 && (
              <ul className="cite-queue">
                {waiting.map((m) => <MarkRow key={m.cid} m={m} checking={false} onFocus={onFocus} />)}
              </ul>
            )}
            <ul className="cite-list-rows">{flagged.map(row)}</ul>
          </section>
        ) : (
          <p className="cite-all-good">Nothing needs your attention{looking.length + pending.length ? ' yet' : ''}.</p>
        )}
        {looking.length + pending.length > 0 && (
          <section className="cite-list" aria-label="Citations still being checked">
            <h4 className="eyebrow">Still checking · {looking.length + pending.length}</h4>
            <ul className="cite-queue">
              {looking.map((m) => <MarkRow key={m.cid} m={m} checking={checking.has(m.cid)} onFocus={onFocus} />)}
            </ul>
            <ul className="cite-list-rows">{pending.map(row)}</ul>
          </section>
        )}
        {supported.length > 0 && (
          <details className="cite-list cite-supported">
            <summary className="eyebrow">Supported · {supported.length}</summary>
            <ul className="cite-list-rows">{supported.map(row)}</ul>
          </details>
        )}
      </div>
    )
  }

  const results = mark.results ?? []
  const unchecked = stillChecking(results) // candidates whose check is still running
  return (
    <div className="cite-panel">
      <button className="link cite-back" onClick={() => onFocus(null)}>
        ‹ All citations
      </button>
      <div className={`cite-head cite-head-${mark.state}`}>
        <span className={`cite-mark cite-mark-${mark.state}`}>cite</span>
        <b>{HEADLINE[mark.state]}</b>
      </div>
      <blockquote className="cite-claim">{mark.claim}</blockquote>
      {mark.state === 'searching' && <p className="busy">Searching your library and checking each passage against the sentence. Keep writing.</p>}
      {mark.state !== 'searching' && unchecked > 0 && (
        <p className="busy" role="status">
          Checking {unchecked} more passage{unchecked === 1 ? '' : 's'}… You can confirm this source now.
        </p>
      )}
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
              disabled={r.status === 'quote_not_found' || r.status === 'pending'}
              title={r.status === 'pending' ? 'Still being checked against your sentence' : undefined}
              onClick={() => onConfirm(mark.cid, r)}
            >
              Use this source
            </button>
          </div>
        </div>
      ))}

      <div className="cite-foot">
        <button onClick={() => onRecheck(mark.cid)} disabled={mark.state === 'searching' || unchecked > 0} title="Search again for the sentence as it reads now">
          Check again
        </button>
        <button className="link danger-link" onClick={() => onRemove(mark.cid)}>
          Remove marker
        </button>
      </div>
    </div>
  )
}
