import type { Tally } from '../editor/citeStatus'
import { needWord } from '../editor/citeStatus'
import type { DuplicateReport } from '../types'
import { CiteLegend } from './CiteLegend'
import { ago } from './Meters'
import { CheckExplainer } from './NightPanel'
import { useState } from 'react'

interface Props {
  tally: Tally
  rechecking: boolean
  onRecheckAll: () => void
  dup: { report: DuplicateReport | null; at: number | null; busy: boolean; stale: boolean; error: string | null }
  onCheckDup: () => void
  /** How many sources the library holds, for the explainer. */
  sources: number
}

/** The top of Check: how the draft's citations stand, in the words the chips use, with the legend;
 * and the duplication share, checked in the background as you write. */
export function CheckSummary({ tally, rechecking, onRecheckAll, dup, onCheckDup, sources }: Props) {
  const [explaining, setExplaining] = useState(false)
  const { supported, attention, toConfirm, checking, total } = tally
  const pct = (n: number) => `${total ? (100 * n) / total : 0}%`
  const passages = dup.report ? dup.report.source_matches.length + dup.report.repeated_sentences.length + dup.report.repeated_paragraphs.length : 0
  const uncitedMatches = dup.report?.source_matches.filter((m) => !m.cited).length ?? 0

  return (
    <section className="check-summary" aria-label="Draft check summary">
      {total > 0 && (
        <p className="live-line">
          Citations in this draft backed by a source: <b>{Math.round((100 * supported) / total)}%</b>
        </p>
      )}
      <div className="cs-top">
        {!total ? (
          <p className="say say-sm">
            <b>No citations yet.</b> Cite a sentence, or draft from your sources in Compose.
          </p>
        ) : (
        <div>
          <b className="cs-big">
            {attention ? `${attention} of ${total}` : checking ? 'Checking…' : 'All supported'}
          </b>
          <span className="cs-sub">
            {attention
                ? `citations ${needWord(attention)}${toConfirm ? ` (${toConfirm === attention ? 'a source found' : `${toConfirm} with a source found`}, to confirm)` : ''}`
                : `${supported} of ${total} citations supported${checking ? `, ${checking} still checking` : ''}`}
          </span>
        </div>
        )}
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
      {explaining ? (
        <CheckExplainer tally={tally} sources={sources} onClose={() => setExplaining(false)} />
      ) : (
        <button className="link-go cs-how" onClick={() => setExplaining(true)}>
          How a citation gets checked ›
        </button>
      )}
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
