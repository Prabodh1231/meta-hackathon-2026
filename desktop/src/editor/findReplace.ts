import { Extension, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/** Find and replace in the draft. Matches are found within each paragraph (across bold, links and
 * other formatting, not across a citation chip) and drawn as decorations, so the text isn't touched. */
export interface FindOptions {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
}
interface Match {
  from: number
  to: number
}
interface FindState extends FindOptions {
  matches: Match[]
  current: number // -1 when there are none
  decos: DecorationSet
}

export const findKey = new PluginKey<FindState>('findReplace')

function search(doc: PMNode, o: FindOptions): Match[] {
  if (!o.query) return []
  const body = o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(o.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body, o.caseSensitive ? 'gu' : 'giu')
  const out: Match[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = ''
    const at: number[] = [] // document position of each character of `text`
    node.forEach((child, offset) => {
      const start = pos + 1 + offset
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) at.push(start + i)
        text += child.text
      } else {
        at.push(start)
        text += '\u0000' // a chip or footnote: nothing matches across it
      }
    })
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue
      const a = m.index ?? 0
      out.push({ from: at[a], to: at[a + m[0].length - 1] + 1 })
    }
    return false
  })
  return out
}

function draw(doc: PMNode, matches: Match[], current: number): DecorationSet {
  return DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? 'find-hit find-current' : 'find-hit' })),
  )
}

const EMPTY: FindState = { query: '', caseSensitive: false, wholeWord: false, matches: [], current: -1, decos: DecorationSet.empty }

export const FindReplace = Extension.create<{ onOpen: (replace: boolean) => void }>({
  name: 'findReplace',
  addOptions: () => ({ onOpen: () => {} }),
  addKeyboardShortcuts() {
    return {
      'Mod-f': () => (this.options.onOpen(false), true),
      'Mod-h': () => (this.options.onOpen(true), true),
    }
  },
  addProseMirrorPlugins: () => [
    new Plugin<FindState>({
      key: findKey,
      state: {
        init: () => EMPTY,
        apply(tr, prev, _old, state) {
          const meta = tr.getMeta(findKey) as (Partial<FindOptions> & { current?: number }) | undefined
          if (!meta && !tr.docChanged) return prev
          const opts: FindOptions = {
            query: meta?.query ?? prev.query,
            caseSensitive: meta?.caseSensitive ?? prev.caseSensitive,
            wholeWord: meta?.wholeWord ?? prev.wholeWord,
          }
          if (!opts.query) return { ...EMPTY, caseSensitive: opts.caseSensitive, wholeWord: opts.wholeWord }
          const searchChanged = !!meta && ('query' in meta || 'caseSensitive' in meta || 'wholeWord' in meta)
          const matches = searchChanged || tr.docChanged ? search(state.doc, opts) : prev.matches
          let current = meta?.current ?? prev.current
          if (searchChanged && meta?.current === undefined) {
            // A new search starts at the first match after the cursor.
            const i = matches.findIndex((m) => m.from >= state.selection.from)
            current = matches.length ? (i < 0 ? 0 : i) : -1
          }
          current = matches.length ? Math.min(Math.max(current, 0), matches.length - 1) : -1
          return { ...opts, matches, current, decos: draw(state.doc, matches, current) }
        },
      },
      props: { decorations: (state) => findKey.getState(state)?.decos },
    }),
  ],
})

export function findState(editor: Editor): FindState {
  return findKey.getState(editor.state) ?? EMPTY
}

export function setFind(editor: Editor, opts: Partial<FindOptions>) {
  editor.view.dispatch(editor.state.tr.setMeta(findKey, opts))
}

/** Step to the next (1) or previous (-1) match, select it and bring it into view. */
export function findStep(editor: Editor, dir: 1 | -1 | 0) {
  const s = findState(editor)
  if (!s.matches.length) return
  const current = (s.current + dir + s.matches.length) % s.matches.length
  const m = s.matches[current]
  const tr = editor.state.tr.setMeta(findKey, { current }).setSelection(TextSelection.create(editor.state.doc, m.from, m.to))
  editor.view.dispatch(tr.scrollIntoView())
  const dom = editor.view.domAtPos(m.from).node
  ;(dom instanceof HTMLElement ? dom : dom.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/** Replace the current match and move on to the next. */
export function replaceCurrent(editor: Editor, text: string) {
  const s = findState(editor)
  const m = s.matches[s.current]
  if (!m) return
  editor.view.dispatch(editor.state.tr.insertText(text, m.from, m.to))
  findStep(editor, 0)
}

/** Replace every match, as one undo step. Returns how many were replaced. */
export function replaceAll(editor: Editor, text: string): number {
  const { matches } = findState(editor)
  if (!matches.length) return 0
  const tr = editor.state.tr
  for (const m of [...matches].reverse()) tr.insertText(text, m.from, m.to)
  editor.view.dispatch(tr)
  return matches.length
}

export function clearFind(editor: Editor) {
  setFind(editor, { query: '' })
}
