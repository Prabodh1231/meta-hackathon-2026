import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/** Underlines from the duplication check: text matching a source (cited or not) and text the
 * draft repeats. They follow later edits and are replaced on the next check. */
export type ReviewKind = 'source' | 'cited' | 'repeat'
export interface ReviewRange {
  from: number
  to: number
  kind: ReviewKind
  title?: string
}

const key = new PluginKey<DecorationSet>('reviewMarks')

export const ReviewMarks = Extension.create({
  name: 'reviewMarks',
  addProseMirrorPlugins: () => [
    new Plugin<DecorationSet>({
      key,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          const ranges = tr.getMeta(key) as ReviewRange[] | undefined
          if (ranges) {
            return DecorationSet.create(
              tr.doc,
              ranges.map((r) => Decoration.inline(r.from, r.to, { class: `review-${r.kind}`, title: r.title ?? '' })),
            )
          }
          return set.map(tr.mapping, tr.doc)
        },
      },
      props: { decorations: (state) => key.getState(state) },
    }),
  ],
})

export function setReviewMarks(editor: Editor, ranges: ReviewRange[]) {
  editor.view.dispatch(editor.state.tr.setMeta(key, ranges))
}

const LEAF = '￼' // a citation chip in textBetween, one position wide like the chip itself

/** Text blocks in the order the backend numbers them (non-empty paragraphs and headings). */
export function textBlocks(editor: Editor): { pos: number; start: number; end: number; text: string }[] {
  const out: { pos: number; start: number; end: number; text: string }[] = []
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (node.textContent.trim()) {
      const start = pos + 1
      const end = pos + node.nodeSize - 1
      out.push({ pos, start, end, text: editor.state.doc.textBetween(start, end, ' ', LEAF) })
    }
    return false
  })
  return out
}

/** Document range of `text` inside block number `block`, ignoring spacing differences. Pass
 * `blocks` (from textBlocks) when looking up many passages, so the document is walked once. */
export function findInBlock(
  editor: Editor,
  block: number,
  text: string,
  blocks: ReturnType<typeof textBlocks> = textBlocks(editor),
): { from: number; to: number } | null {
  const b = blocks[block]
  if (!b) return null
  // Match on words so collapsed whitespace and chips between words don't break it.
  const words = text.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length) return null
  const m = new RegExp(words.join(`[\\s${LEAF}]+`)).exec(b.text)
  return m ? { from: b.start + m.index, to: b.start + m.index + m[0].length } : null
}
