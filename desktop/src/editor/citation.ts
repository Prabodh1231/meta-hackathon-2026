import { Node, mergeAttributes } from '@tiptap/core'
import type { CitationStatus } from '../types'
import { CITATION_WORD } from './citeStatus'

/** Inline, non-editable citation chip. All the data needed to open and re-verify the
 * source lives in its attributes, so drafts saved as JSON keep working citations. */
export const CitationNode = Node.create({
  name: 'citation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    const attr = (fallback: unknown) => ({ default: fallback, rendered: false })
    return {
      cid: attr(null),
      chunkId: attr(null),
      docId: attr(null),
      page: attr(null),
      start: attr(null),
      end: attr(null),
      quote: attr(''),
      claim: attr(''),
      label: attr(''),
      status: attr('pending'),
      reason: attr(''),
      finding: attr(null), // written from a review matrix: the kept finding it's checked against
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-citation]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const { status, label, cid, finding } = node.attrs
    // No title: pointing at a chip shows ChipCard, with the verdict, quote and reason laid out.
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-citation': '',
        'data-cid': cid ?? '',
        class: `cite cite-${status}${finding ? ' cite-matrix' : ''}`,
        role: 'button',
        'aria-label': `${label}, ${CITATION_WORD[status as CitationStatus] ?? status}${finding ? ', from your review matrix' : ''}`,
      }),
      label,
    ]
  },
})
