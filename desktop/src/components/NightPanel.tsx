import type { Tally } from '../editor/citeStatus'
import { CITATION_WORD } from '../editor/citeStatus'

/** How a citation gets checked, on the night panel: the four steps as chips joined by dashed lines,
 * what each one does, and this draft's numbers. Opened from the legend in Check. */
export function CheckExplainer({ tally, sources, onClose }: { tally: Tally; sources: number; onClose: () => void }) {
  const pct = tally.total ? Math.round((100 * tally.supported) / tally.total) : null
  return (
    <section className="night check-explainer" aria-label="How a citation gets checked">
      <button className="night-close" onClick={onClose} aria-label="Close" title="Close">
        ×
      </button>
      <h4>
        <b>How a citation gets checked.</b> Four steps, all on your own sources.
      </h4>
      <ol className="night-flow" aria-hidden="true">
        <li><span>Your sentence</span></li>
        <li><span>Find a source</span></li>
        <li><span>Read the passage</span></li>
        <li><span>Verdict</span></li>
      </ol>
      <ol className="night-steps">
        <li><b>Your sentence.</b> The one you marked with Cite, as it reads now. Edit it and it's checked again.</li>
        <li><b>Find a source.</b> Your library is searched for passages about it, and the closest are kept.</li>
        <li><b>Read the passage.</b> The quote is matched to its exact place on the page, so it can't be invented.</li>
        <li>
          <b>Verdict.</b> The passage is read against your sentence: {CITATION_WORD.verified}, {CITATION_WORD.weak} or {CITATION_WORD.unsupported}. A source that was found waits for you to confirm it.
        </li>
      </ol>
      <div className="night-nums">
        <div>
          <strong>{sources.toLocaleString()}</strong>
          <span>{sources === 1 ? 'source' : 'sources'} to search</span>
        </div>
        <div>
          <strong>{tally.total}</strong>
          <span>{tally.total === 1 ? 'citation' : 'citations'} in this draft</span>
        </div>
        {pct != null && (
          <div>
            <strong>{pct}%</strong>
            <span>supported</span>
          </div>
        )}
      </div>
    </section>
  )
}
