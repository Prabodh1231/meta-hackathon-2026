import { Mark, mergeAttributes, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

/** Meta on a transaction that inserts Muse's text (or loads a saved draft): its marks are kept. */
export const MUSE_META = 'museInsert'

/** Text Muse wrote, so it's never mistaken for the writer's own: a quiet dotted underline, "Written
 * by Muse" on hover. Saved with the draft. Text the writer types, even inside it, isn't marked, so
 * the mark keeps to the words Muse chose; it's not exported. */
export const MuseMark = Mark.create({
  name: 'muse',
  inclusive: false,
  parseHTML() {
    return [{ tag: 'span[data-muse]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-muse': '', class: 'muse-text', title: 'Written by Muse' }), 0]
  },
  addProseMirrorPlugins() {
    const type = this.type
    return [
      new Plugin({
        key: new PluginKey('museTyped'),
        // Typing (or pasting) inside Muse's text would carry the mark on: take it off what's new.
        appendTransaction(trs, _old, state) {
          const ranges: [number, number][] = []
          trs.forEach((t, ti) => {
            if (!t.docChanged || t.getMeta(MUSE_META) || t.getMeta('history$') || t.getMeta('addToHistory') === false) return
            t.mapping.maps.forEach((map, mi) => {
              map.forEach((_a, _b, from, to) => {
                let f = from
                let e = to
                for (let k = mi + 1; k < t.mapping.maps.length; k++) {
                  f = t.mapping.maps[k].map(f, 1)
                  e = t.mapping.maps[k].map(e, -1)
                }
                for (let tj = ti + 1; tj < trs.length; tj++) {
                  f = trs[tj].mapping.map(f, 1)
                  e = trs[tj].mapping.map(e, -1)
                }
                if (e > f) ranges.push([f, e])
              })
            })
          })
          if (!ranges.length) return null
          const tr = state.tr
          for (const [f, e] of ranges) if (state.doc.rangeHasMark(f, e, type)) tr.removeMark(f, e, type)
          return tr.steps.length ? tr.setMeta('addToHistory', false) : null
        },
      }),
    ]
  },
})

/** Insert content Muse wrote at the cursor (or the end) and mark its text as Muse's. */
export function insertMuse(editor: Editor, content: Parameters<Editor['commands']['insertContent']>[0], at: 'end' | undefined) {
  let start = 0
  let steps = 0
  editor
    .chain()
    .focus(at)
    .command(({ tr }) => {
      tr.setMeta(MUSE_META, true)
      start = tr.selection.from
      steps = tr.steps.length
      return true
    })
    .insertContent(content)
    .command(({ tr }) => {
      const type = tr.doc.type.schema.marks.muse
      const from = tr.mapping.slice(steps).map(start, -1)
      const to = tr.selection.to
      if (type && to > from) {
        tr.doc.nodesBetween(from, to, (node, pos) => {
          if (node.isText && node.text?.trim()) tr.addMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), type.create())
        })
      }
      return true
    })
    .scrollIntoView()
    .run()
}
