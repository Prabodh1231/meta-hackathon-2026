import type { CiteMarkAttrs, CiteMarkState } from '../editor/citeMark'
import type { Citation } from '../types'
import { StatusBadge } from './StatusBadge'

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
export function CitePanel({ marks, citations, rechecking, onRecheckAll, focus, onFocus, onConfirm, onRecheck, onRemove, onOpenSource }: Props) {
  const mark = focus ? marks.find((m) => m.cid === focus) : undefined

  if (!mark) {
    return (
      <div className="cite-panel">
        <p className="cite-intro">
          Put the cursor in a sentence (or select text) and press <strong>Cite</strong> (Ctrl+Shift+C). A grey{' '}
          <span className="cite-mark cite-mark-searching">cite</span> marker appears and you keep writing; it turns{' '}
          <span className="cite-mark cite-mark-verified">cite</span> when a source supports the sentence,{' '}
          <span className="cite-mark cite-mark-weak">cite</span> for partial support, and{' '}
          <span className="cite-mark cite-mark-unsupported">cite</span> when nothing does. Click it to confirm a source.
        </p>
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
                    <span className="cite-queue-claim">{m.claim}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
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
