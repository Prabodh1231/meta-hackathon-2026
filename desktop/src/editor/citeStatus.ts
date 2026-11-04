import type { CitationStatus } from '../types'
import type { CiteMarkState } from './citeMark'

/** What a citation's check found, said in words: shapes and colours alone don't tell everyone
 * (colour-blind readers, screen readers). The symbols themselves are drawn in CSS. */
export const CITATION_WORD: Record<CitationStatus, string> = {
  pending: 'not checked yet',
  verified: 'supported',
  weak: 'partly supported',
  unsupported: 'not supported',
  quote_not_found: 'quote not found in the source',
}

export const MARK_WORD: Record<CiteMarkState, string> = {
  searching: 'looking for a source',
  verified: 'a source supports this',
  weak: 'partial support found',
  unsupported: 'nothing supports this',
  none: 'nothing in your library matches',
  error: "search didn't finish",
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
