import { Node, mergeAttributes } from '@tiptap/core'
import type { Suggestion } from '../types'
import { MARK_WORD } from './citeStatus'

/** Where the background search for a cite marker stands. */
export type CiteMarkState = 'searching' | 'verified' | 'weak' | 'unsupported' | 'none' | 'error'

export interface CiteMarkAttrs {
  cid: string
  claim: string // the sentence as it read when Cite was pressed (or re-checked)
  state: CiteMarkState
  results: Suggestion[] // candidate sources, best first, each checked against the claim ("pending" while its check runs)
}

/** How many of a marker's candidates are still being checked. */
export const stillChecking = (results: Suggestion[] | undefined) => (results ?? []).filter((r) => r.status === 'pending').length

/** A marker whose search was cut short (the draft or the app was closed meanwhile): it searches again. */
export const unfinished = (m: CiteMarkAttrs) => m.state === 'searching' || stillChecking(m.results) > 0

const TITLES: Record<CiteMarkState, string> = {
  searching: 'Finding a source… keep writing',
  verified: 'Source found. Click to confirm it',
  weak: 'Partly supported. Click to review',
  unsupported: 'Not supported by what was found. Click to review',
  none: 'No source found in your library. Click to review',
  error: "The search didn't finish. Click to try again",
}

/** A citation still being found: the word "cite", coloured by what the background search found.
 * It stays the same width whatever it finds, so the line being typed never moves; it becomes a
 * real citation chip only when the writer confirms a source. Its results travel with the draft. */
export const CiteMarkNode = Node.create({
  name: 'citeMark',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    const attr = (fallback: unknown) => ({ default: fallback, rendered: false })
    return {
      cid: attr(null),
      claim: attr(''),
      state: attr('searching'),
      results: attr([]),
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-cite-mark]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const state = node.attrs.state as CiteMarkState
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-cite-mark': '',
        'data-cid': node.attrs.cid ?? '',
        class: `cite-mark cite-mark-${state}`,
        role: 'button',
        'aria-label': `Cite marker: ${MARK_WORD[state] ?? state}`,
        title: TITLES[state] ?? '',
      }),
      'cite',
    ]
  },
})

/** The marker's colour from the search results (the backend returns them best first). */
export function stateOf(results: Suggestion[]): CiteMarkState {
  if (!results.length) return 'none'
  const best = results[0].status
  return best === 'verified' ? 'verified' : best === 'weak' ? 'weak' : 'unsupported'
}

/** The marker's colour while checks are still coming in: green as soon as one candidate is
 * supported (nothing later can beat that), otherwise still searching until the last check. */
export function stateSoFar(results: Suggestion[]): CiteMarkState {
  if (results.some((r) => r.status === 'verified')) return 'verified'
  return stillChecking(results) ? 'searching' : stateOf(results)
}
