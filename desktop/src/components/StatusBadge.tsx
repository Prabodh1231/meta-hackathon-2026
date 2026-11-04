import { CITATION_WORD } from '../editor/citeStatus'
import type { CitationStatus } from '../types'

/** A verdict as a small badge, in the same words as the chips (see citeStatus.ts). */
export function StatusBadge({ status, text }: { status: CitationStatus; text?: string }) {
  return <span className={`badge badge-${status}`}>{text ?? CITATION_WORD[status].toLowerCase()}</span>
}
