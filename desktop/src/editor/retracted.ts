import { Extension, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { CITATION_WORD } from './citeStatus'
import type { CitationStatus } from '../types'

/** Marks the draft's citations of retracted papers. Whether a paper is retracted belongs to the
 * library, not the citation (OpenAlex can flag it after it was cited), so it is drawn over the
 * chips rather than saved in them: a decoration that follows the library's current list. */
interface State {
  ids: Set<number>
  set: DecorationSet
}

const key = new PluginKey<State>('retractedCites')

function decorate(doc: PMNode, ids: Set<number>): DecorationSet {
  if (!ids.size) return DecorationSet.empty
  const out: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'citation' || !ids.has(node.attrs.docId)) return
    const word = CITATION_WORD[node.attrs.status as CitationStatus] ?? node.attrs.status
    out.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'cite-retracted',
        'aria-label': `${node.attrs.label}, cites a retracted paper, ${word}`,
      }),
    )
  })
  return DecorationSet.create(doc, out)
}

export const RetractedCites = Extension.create<object, { ids: Set<number> }>({
  name: 'retractedCites',
  // Kept here as well as in the plugin's state: opening another draft makes a fresh editor state,
  // and the new one starts from this list instead of from nothing.
  addStorage: () => ({ ids: new Set<number>() }),
  addProseMirrorPlugins() {
    const storage = this.storage
    return [
      new Plugin<State>({
        key,
        state: {
          init: (_, state) => ({ ids: storage.ids, set: decorate(state.doc, storage.ids) }),
          apply(tr, prev) {
            const ids = tr.getMeta(key) as Set<number> | undefined
            if (ids) return { ids, set: decorate(tr.doc, ids) }
            // A new chip of a retracted paper needs its mark too, so a changed draft is looked over again.
            return tr.docChanged ? { ids: prev.ids, set: decorate(tr.doc, prev.ids) } : prev
          },
        },
        props: { decorations: (state) => key.getState(state)?.set },
      }),
    ]
  },
})

export function setRetractedDocs(editor: Editor, ids: Set<number>) {
  ;(editor.storage as unknown as { retractedCites: { ids: Set<number> } }).retractedCites.ids = ids
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(key, ids).setMeta('addToHistory', false))
}
