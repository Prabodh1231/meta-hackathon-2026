import type { CitationStatus } from '../types'
import type { CiteMarkState } from './citeMark'

/* One vocabulary for what a citation's check found, used everywhere it shows: the chip in the draft
 * (its word and its aria-label), the card on hover, the Check list, the legend and the status bar.
 * Shapes and colours alone don't tell everyone (colour-blind readers, screen readers); the symbols
 * themselves are drawn in CSS. A quote that's gone from the source counts as not supported (its
 * reason says why), so there are only three verdicts to learn. */
export const CITATION_WORD: Record<CitationStatus, string> = {
  pending: 'Checking…',
  verified: 'Supported',
  weak: 'Partly supported',
  unsupported: 'Not supported',
  quote_not_found: 'Not supported',
}

/** A cite marker is a citation still being found, in the same words plus the two only it has. */
export const MARK_WORD: Record<CiteMarkState, string> = {
  searching: 'Finding a source…',
  verified: 'Source found, confirm it',
  weak: 'Partly supported',
  unsupported: 'Not supported',
  none: 'No source found',
  error: "Search didn't finish",
}

/** Order for lists: what needs the writer first. */
export const CITATION_RANK: Record<CitationStatus, number> = {
  unsupported: 0,
  quote_not_found: 1,
  weak: 2,
  pending: 3,
  verified: 4,
}

export const isFlagged = (s: CitationStatus) => s !== 'verified' && s !== 'pending'

/** The draft's citations counted one way everywhere (status bar, Check's badge and summary).
 * Needs attention: chips that aren't fully supported, and every marker that has finished searching
 * (each waits for the writer to confirm a source). Checking: chips and markers not done yet. */
export interface Tally {
  supported: number
  attention: number
  /** Of `attention`: markers whose search found a source (fully or partly supporting), waiting for the writer to confirm it. */
  toConfirm: number
  checking: number
  total: number
}

export function tally(chips: { status: CitationStatus }[], marks: { state: CiteMarkState }[]): Tally {
  const t: Tally = { supported: 0, attention: 0, toConfirm: 0, checking: 0, total: chips.length + marks.length }
  for (const c of chips) {
    if (c.status === 'verified') t.supported++
    else if (c.status === 'pending') t.checking++
    else t.attention++
  }
  for (const m of marks) {
    if (m.state === 'searching') t.checking++
    else {
      t.attention++
      if (m.state === 'verified' || m.state === 'weak') t.toConfirm++
    }
  }
  return t
}

export const needWord = (n: number) => (n === 1 ? 'needs attention' : 'need attention')
