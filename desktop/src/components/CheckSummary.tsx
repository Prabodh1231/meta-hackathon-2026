import type { Tally } from '../editor/citeStatus'
import { needWord } from '../editor/citeStatus'
import type { DuplicateReport } from '../types'
import { CiteLegend } from './CiteLegend'
import { ago } from './Meters'

interface Props {
  tally: Tally
  rechecking: boolean
  onRecheckAll: () => void
  dup: { report: DuplicateReport | null; at: number | null; busy: boolean; stale: boolean; error: string | null }
  onCheckDup: () => void
}

/** The top of Check: how the draft's citations stand, in the words the chips use, with the legend;
 * and the duplication share, checked in the background as you write. */
export function CheckSummary({ tally, rechecking, onRecheckAll, dup, onCheckDup }: Props) {
  const { supported, attention, toConfirm, checking, total } = tally
  const pct = (n: number) => `${total ? (100 * n) / total : 0}%`
  const passages = dup.report ? dup.report.source_matches.length + dup.report.repeated_sentences.length + dup.report.repeated_paragraphs.length : 0
  const uncitedMatches = dup.report?.source_matches.filter((m) => !m.cited).length ?? 0

  return (
    <section className="check-summary" aria-label="Draft check summary">
      <div className="cs-top">
        <div>
          <b className="cs-big">
            {!total ? 'No citations yet' : attention ? `${attention} of ${total}` : checking ? 'Checking…' : 'All supported'}
          </b>
          <span className="cs-sub">
            {!total
              ? 'Cite a sentence, or draft from your sources in Compose.'
              : attention
                ? `citations ${needWord(attention)}${toConfirm ? ` (${toConfirm === attention ? 'a source found' : `${toConfirm} with a source found`}, to confirm)` : ''}`
                : `${supported} of ${total} citations supported${checking ? `, ${checking} still checking` : ''}`}
          </span>
        </div>
        {total > 0 && (
          <button onClick={onRecheckAll} disabled={rechecking} title="Check every citation against its sentence as it reads now, and search again for every marker">
            {rechecking ? 'Rechecking…' : 'Recheck all'}
          </button>
        )}
      </div>
      {total > 0 && (
        <>
          <div className="cs-meter" role="img" aria-label={`${supported} supported, ${attention} ${needWord(attention)}, ${checking} checking`}>
            <i className="ok" style={{ width: pct(supported) }} />
            <i className="bad" style={{ width: pct(attention - toConfirm) }} />
            <i className="warn" style={{ width: pct(toConfirm) }} />
            <i className="pend" style={{ width: pct(checking) }} />
          </div>
          <div className="cs-meter-labels" aria-hidden="true">
            <span><i className="ok" />Supported {supported}</span>
            <span><i className="bad" />Needs attention {Math.max(0, attention - toConfirm)}</span>
            <span><i className="warn" />Source found, to confirm {toConfirm}</span>
            <span><i className="pend" />Checking {checking}</span>
          </div>
        </>
      )}
      <CiteLegend />
      <div className="cs-dup">
        <span>
          Duplication{' '}
          {dup.busy && !dup.report ? (
            <span className="muted">checking…</span>
          ) : dup.report ? (
            <>
              <b>{dup.report.overall}%</b>
              <span className="muted">
                {' '}
                · {passages} passage{passages === 1 ? '' : 's'}
                {uncitedMatches > 0 && <span className="cs-uncited"> · {uncitedMatches} uncited match{uncitedMatches === 1 ? '' : 'es'}, needs attention</span>} · {dup.busy ? 'checking again…' : dup.stale ? 'out of date' : `checked ${dup.at ? ago(dup.at) : ''}`}
              </span>
            </>
          ) : dup.error ? (
            <span className="warn">didn't run</span>
          ) : (
            <span className="muted">not checked yet</span>
          )}
        </span>
        {!dup.busy && (dup.error || !dup.report || dup.stale) && (
          <button className="link" onClick={onCheckDup}>
            Check now
          </button>
        )}
      </div>
    </section>
  )
}
