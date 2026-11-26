import { Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react'
import { headingsOf } from './docFormat'
import type { Node as PMNode } from '@tiptap/pm/model'

/** The headings a table of contents lists: levels 1 to 3, leaving out a first-line heading 1,
 * which is the draft's title. export_docx.py lists the same ones. */
export function contentsOf(doc: PMNode) {
  const first = doc.firstChild
  const titled = first?.type.name === 'heading' && first.attrs.level === 1
  return headingsOf(doc).filter((h, i) => h.level <= 3 && !(titled && i === 0 && h.pos === 0))
}

function TocView({ editor, selected }: NodeViewProps) {
  // Redrawn only when the headings change, not on every keystroke.
  const key = useEditorState({ editor, selector: ({ editor: e }) => JSON.stringify(contentsOf(e.state.doc).map((h) => [h.level, h.text])) })
  const entries = JSON.parse(key) as [number, string][]
  const top = Math.min(...entries.map(([l]) => l))

  function jump(i: number) {
    const h = contentsOf(editor.state.doc)[i]
    if (!h) return
    editor.chain().focus().setTextSelection(h.pos + 1).run()
    const dom = editor.view.nodeDOM(h.pos)
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <NodeViewWrapper className={`toc${selected ? ' toc-selected' : ''}`} contentEditable={false} data-toc="">
      <div className="toc-head">
        <b>Contents</b>
        <span>updates as you write · Word adds page numbers</span>
      </div>
      {entries.length ? (
        <ol>
          {entries.map(([level, text], i) => (
            <li key={i} className={`toc-l${level - top + 1}`}>
              <button type="button" onClick={() => jump(i)} title="Go to this heading">
                {text}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="toc-empty">Headings you add (Heading 1 to 3) are listed here.</p>
      )}
    </NodeViewWrapper>
  )
}

export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML: () => [{ tag: 'div[data-toc]' }],
  renderHTML: () => ['div', { 'data-toc': '' }],
  renderText: () => '',
  addNodeView: () => ReactNodeViewRenderer(TocView),
  addCommands() {
    return {
      insertTableOfContents:
        () =>
        ({ chain }) =>
          chain().insertContent({ type: this.name }).run(),
    }
  },
})
