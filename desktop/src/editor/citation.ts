import { Node, mergeAttributes } from '@tiptap/core'

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
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-citation]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const { status, label, reason, quote } = node.attrs
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-citation': '',
        class: `cite cite-${status}`,
        title: reason ? `${reason}\n\n“${quote}”` : `“${quote}”`,
      }),
      label,
    ]
  },
})
