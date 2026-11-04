import { CITATION_WORD, MARK_WORD } from '../editor/citeStatus'

/** What the marks in the draft mean, drawn the way the draft draws them and in the same words. */
export function CiteLegend() {
  return (
    <div className="cite-legend" aria-label="What the citation marks mean">
      <span className="cite cite-verified legend-chip">{CITATION_WORD.verified}</span>
      <span className="cite cite-weak legend-chip">{CITATION_WORD.weak}</span>
      <span className="cite cite-unsupported legend-chip">{CITATION_WORD.unsupported}</span>
      <span className="cite cite-pending legend-chip">{CITATION_WORD.pending}</span>
      <span className="cite-legend-mark">
        <span className="cite-mark cite-mark-searching" aria-hidden="true">cite</span> {MARK_WORD.searching.replace('…', '')}, or waiting for you to confirm one
      </span>
    </div>
  )
}
