import { Node, mergeAttributes } from '@tiptap/core'
import type { Suggestion } from '../types'
import { MARK_WORD } from './citeStatus'

/** Where the background search for a cite marker stands. */
export type CiteMarkState = 'searching' | 'verified' | 'weak' | 'unsupported' | 'none' | 'error'

export interface CiteMarkAttrs {
  cid: string
  claim: string // the sentence as it read when Cite was pressed (or re-checked)
  state: CiteMarkState
  results: Suggestion[] // candidate sources, best first, each already checked against the claim
}

const TITLES: Record<CiteMarkState, string> = {
  searching: 'Looking for a source… keep writing',
  verified: 'A source supports this. Click to confirm it',
  weak: 'Only partial support found. Click to review',
  unsupported: 'Nothing found supports this. Click to review',
  none: 'Nothing in your library matches. Click to review',
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
