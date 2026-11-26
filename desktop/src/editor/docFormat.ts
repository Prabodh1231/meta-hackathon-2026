import { Extension, Mark, Node, mergeAttributes, type Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import type { Node as PMNode } from '@tiptap/pm/model'

// Everything here is saved in the draft's JSON and read by the backend's Word, PDF and print export
// (export_docx.py), so names and values are shared with it: change both together.

/** Page setup for Word, PDF and print. On screen the draft stays one long page. */
export interface PageSetup {
  size: 'a4' | 'letter'
  orientation: 'portrait' | 'landscape'
  margins: 'narrow' | 'normal' | 'wide'
  pageNumbers: boolean
  lineNumbers: boolean // Word only: for a reviewer's copy
}
export const DEFAULT_PAGE: PageSetup = { size: 'a4', orientation: 'portrait', margins: 'normal', pageNumbers: true, lineNumbers: false }

/** The draft's own settings live on its document node: page setup, space between paragraphs, word goal. */
export const DraftDocument = Document.extend({
  addAttributes() {
    return {
      page: { default: null }, // PageSetup, or null for DEFAULT_PAGE
      spaced: { default: true }, // a blank line's worth of space between paragraphs, as before
      wordGoal: { default: 0 },
    }
  },
})

export function pageSetupOf(editor: Editor): PageSetup {
  return { ...DEFAULT_PAGE, ...(editor.state.doc.attrs.page as Partial<PageSetup> | null) }
}

/** Change one of the draft's own settings: an undo step, saved with the draft. */
export function setDocAttr(editor: Editor, name: 'page' | 'spaced' | 'wordGoal', value: unknown) {
  editor.view.dispatch(editor.state.tr.setDocAttribute(name, value))
}

// ---------- paragraphs: line spacing and indent ----------

export const LINE_HEIGHTS = ['1.15', '1.5', '2'] as const
export const MAX_INDENT = 8 // steps of 2em (half an inch in Word)

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphFormat: {
      /** null is single spacing. */
      setLineHeight: (value: string | null) => ReturnType
      /** In a list this nests or un-nests the item; elsewhere it indents the paragraph. */
      changeIndent: (delta: 1 | -1) => ReturnType
    }
    textColor: {
      setTextColor: (name: string) => ReturnType
      unsetTextColor: () => ReturnType
    }
    pageBreak: { setPageBreak: () => ReturnType }
    footnote: { insertFootnote: () => ReturnType }
    tableOfContents: { insertTableOfContents: () => ReturnType }
  }
}

const BLOCKS = ['paragraph', 'heading']

export const ParagraphFormat = Extension.create({
  name: 'paragraphFormat',
  addGlobalAttributes: () => [
    {
      types: BLOCKS,
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el) => ((LINE_HEIGHTS as readonly string[]).includes(el.style.lineHeight) ? el.style.lineHeight : null),
          renderHTML: (a) => (a.lineHeight ? { style: `line-height: ${a.lineHeight}` } : {}),
        },
        indent: {
          default: 0,
          parseHTML: (el) => Math.min(MAX_INDENT, Math.max(0, Number(el.getAttribute('data-indent')) || 0)),
          renderHTML: (a) => (a.indent ? { 'data-indent': a.indent, style: `margin-left: ${a.indent * 2}em` } : {}),
        },
      },
    },
  ],
  addCommands: () => ({
    setLineHeight:
      (value) =>
      ({ tr, state, dispatch }) => {
        const { from, to } = state.selection
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (BLOCKS.includes(node.type.name)) tr.setNodeAttribute(pos, 'lineHeight', value)
        })
        dispatch?.(tr)
        return true
      },
    changeIndent:
      (delta) =>
      ({ editor, tr, state, dispatch }) => {
        if (editor.isActive('listItem') || editor.isActive('taskItem')) {
          const item = editor.isActive('taskItem') ? 'taskItem' : 'listItem'
          return delta > 0 ? editor.commands.sinkListItem(item) : editor.commands.liftListItem(item)
        }
        const { from, to } = state.selection
        let changed = false
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!BLOCKS.includes(node.type.name)) return true
          const next = Math.min(MAX_INDENT, Math.max(0, (node.attrs.indent || 0) + delta))
          if (next !== node.attrs.indent) {
            tr.setNodeAttribute(pos, 'indent', next)
            changed = true
          }
          return false
        })
        if (changed) dispatch?.(tr)
        return changed
      },
  }),
})

// ---------- text colour and highlight, stored by name ----------

// Names, not CSS colours: the page draws each from a theme token (--tc-*, --hl-*), so coloured text
// stays readable in the dark theme, and Word gets the printed colour (export_docx.py).
export const TEXT_COLORS = ['red', 'orange', 'green', 'blue', 'purple', 'grey'] as const
export const HIGHLIGHTS = ['yellow', 'green', 'blue', 'pink', 'orange'] as const

export const TextColor = Extension.create({
  name: 'textColor',
  addGlobalAttributes: () => [
    {
      types: ['textStyle'],
      attributes: {
        textColor: {
          default: null,
          parseHTML: (el) => {
            const c = el.getAttribute('data-text-color')
            return c && (TEXT_COLORS as readonly string[]).includes(c) ? c : null
          },
          renderHTML: (a) => (a.textColor ? { 'data-text-color': a.textColor, style: `color: var(--tc-${a.textColor})` } : {}),
        },
      },
    },
  ],
  addCommands: () => ({
    setTextColor:
      (name) =>
      ({ chain }) =>
        chain().setMark('textStyle', { textColor: name }).run(),
    unsetTextColor:
      () =>
      ({ chain }) =>
        chain().setMark('textStyle', { textColor: null }).removeEmptyTextStyle().run(),
  }),
})

/** The colour Ctrl+Shift+H and the toolbar's highlighter put on: the last one picked. */
export const highlightPen = { color: 'yellow' as string }

export const NamedHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: 'yellow',
        parseHTML: (el) => {
          const c = el.getAttribute('data-color')
          return c && (HIGHLIGHTS as readonly string[]).includes(c) ? c : 'yellow'
        },
        renderHTML: (a) => ({ 'data-color': a.color, class: `hl hl-${a.color}` }),
      },
    }
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-h': () => this.editor.commands.toggleHighlight({ color: highlightPen.color }) }
  },
}).configure({ multicolor: true })

// ---------- images ----------

export type FigureSize = 's' | 'm' | 'l'
/** Share of the text width, on screen and in Word. */
export const FIGURE_WIDTH: Record<FigureSize, number> = { s: 0.35, m: 0.6, l: 1 }

export const Figure = Image.extend({
  draggable: true,
  addAttributes() {
    return {
      ...this.parent?.(),
      size: {
        default: 'm',
        parseHTML: (el) => (['s', 'm', 'l'].includes(el.getAttribute('data-size') ?? '') ? el.getAttribute('data-size') : 'm'),
        renderHTML: (a) => ({ 'data-size': a.size }),
      },
      align: {
        default: 'center',
        parseHTML: (el) => (['left', 'center', 'right'].includes(el.getAttribute('data-align') ?? '') ? el.getAttribute('data-align') : 'center'),
        renderHTML: (a) => ({ 'data-align': a.align }),
      },
    }
  },
}).configure({ inline: false, allowBase64: true, resize: false })

const MAX_IMAGE = 1600 // px on the long side: pictures are stored in the draft, so big ones are scaled down

/** A picked, pasted or dropped image as a data URL, scaled down to MAX_IMAGE. Photos become JPEG. */
export async function imageData(file: File): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') return url
  const img = new window.Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error(`Can't read ${file.name} as a picture`))
    img.src = url
  })
  const scale = Math.min(1, MAX_IMAGE / Math.max(img.naturalWidth, img.naturalHeight))
  if (scale === 1 && file.size < 600_000) return url
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.naturalWidth * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.88)
}

// ---------- page break ----------

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div[data-page-break]' }],
  renderHTML: () => ['div', { 'data-page-break': '', class: 'page-break', contenteditable: 'false' }],
  renderText: () => '\n',
  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ chain }) =>
          chain().insertContent({ type: this.name }).run(),
    }
  },
})

/** Ctrl+Enter starts a new page, as in Word. Its own extension, ranked above HardBreak (which also
 * takes Ctrl+Enter), so the page break node keeps its ordinary place in the schema. */
export const PageBreakKeys = Extension.create({
  name: 'pageBreakKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() }
  },
})

// ---------- footnotes ----------

/** A footnote: a number in the text (counted by CSS, so it renumbers itself) with its note kept on
 * the node. The notes are listed under the page (FootnotesArea) and become real Word footnotes. */
export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ note: { default: '', rendered: false } }),
  parseHTML: () => [{ tag: 'sup[data-footnote]', getAttrs: (el) => ({ note: el.getAttribute('data-note') ?? '' }) }],
  renderHTML: ({ node }) => [
    'sup',
    { 'data-footnote': '', 'data-note': node.attrs.note, class: 'fn-ref', role: 'button', title: node.attrs.note || 'Footnote (empty)' },
  ],
  renderText: () => '',
  addCommands() {
    return {
      insertFootnote:
        () =>
        ({ chain }) =>
          chain().insertContent({ type: this.name, attrs: { note: '' } }).run(),
    }
  },
})

/** Footnotes in document order, with their positions. */
export function footnotesOf(doc: PMNode): { pos: number; note: string }[] {
  const out: { pos: number; note: string }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'footnote') out.push({ pos, note: node.attrs.note })
  })
  return out
}

// ---------- table of contents ----------

/** A block listing the draft's headings, kept up to date (drawn by TocView). Word gets a real
 * table-of-contents field holding the same entries, which Word can update with page numbers. */
export function headingsOf(doc: PMNode): { pos: number; level: number; text: string }[] {
  const out: { pos: number; level: number; text: string }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim()
      if (text) out.push({ pos, level: node.attrs.level, text })
      return false
    }
    return !node.isTextblock
  })
  return out
}

// ---------- comments to self ----------

/** A note the writer leaves on a passage, shown in the margin and exported as a Word comment.
 * Comments may overlap, so the mark doesn't exclude itself; one comment's ranges share its id. */
export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',
  addAttributes: () => ({
    id: { default: null, parseHTML: (el) => el.getAttribute('data-comment'), renderHTML: (a) => ({ 'data-comment': a.id }) },
    note: { default: '', rendered: false },
    at: { default: null, rendered: false }, // when it was written, ms
  }),
  parseHTML: () => [{ tag: 'span[data-comment]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { class: 'comment-mark' }), 0],
})

export interface CommentInfo {
  id: string
  note: string
  at: number | null
  from: number
  to: number
}

/** Each comment once, in document order, with the span from its first to its last range. */
export function commentsOf(doc: PMNode): CommentInfo[] {
  const byId = new Map<string, CommentInfo>()
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    for (const m of node.marks) {
      if (m.type.name !== 'comment' || !m.attrs.id) continue
      const c = byId.get(m.attrs.id)
      if (c) c.to = pos + node.nodeSize
      else byId.set(m.attrs.id, { id: m.attrs.id, note: m.attrs.note, at: m.attrs.at, from: pos, to: pos + node.nodeSize })
    }
    return false
  })
  return [...byId.values()]
}

export function addComment(editor: Editor): string | null {
  const { from, to, empty } = editor.state.selection
  if (empty) return null
  const id = `n${Date.now().toString(36)}`
  const type = editor.schema.marks.comment
  editor.view.dispatch(editor.state.tr.addMark(from, to, type.create({ id, note: '', at: Date.now() })))
  return id
}

/** Replace a comment's note (on every range it covers), or remove the comment with `note` null. */
export function updateComment(editor: Editor, id: string, note: string | null) {
  const type = editor.schema.marks.comment
  const { tr } = editor.state
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return true
    const m = node.marks.find((x) => x.type === type && x.attrs.id === id)
    if (!m) return false
    tr.removeMark(pos, pos + node.nodeSize, m)
    if (note !== null) tr.addMark(pos, pos + node.nodeSize, type.create({ ...m.attrs, note }))
    return false
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}

// ---------- whole-selection helpers for the toolbar ----------

/** Character formatting, as opposed to the app's own marks (citations' Muse mark, comments, links). */
export const FORMAT_MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'superscript', 'subscript', 'textStyle', 'highlight']

/** Clear formatting: character formatting off, and paragraphs back to left-aligned, single, not indented.
 * Headings stay headings; links, comments and Muse's mark stay. */
export function clearFormatting(editor: Editor) {
  const { from, to } = editor.state.selection
  const { tr, schema } = editor.state
  for (const name of FORMAT_MARKS) if (schema.marks[name]) tr.removeMark(from, to, schema.marks[name])
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!BLOCKS.includes(node.type.name)) return true
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: null, lineHeight: null, indent: 0 })
    return false
  })
  tr.setStoredMarks([])
  editor.view.dispatch(tr)
}

export type CaseKind = 'sentence' | 'lower' | 'upper' | 'title'
const SMALL_WORDS = /^(a|an|and|as|at|but|by|for|in|nor|of|on|or|per|the|to|vs|via)$/i

/** Change the case of the selected text, keeping its formatting, citations and footnotes. */
export function changeCase(editor: Editor, kind: CaseKind) {
  const { from, to, empty } = editor.state.selection
  if (empty) return
  const { tr } = editor.state
  let startOfSentence = true
  let first = true
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) startOfSentence = true
    if (!node.isText) return true
    const a = Math.max(from, pos)
    const b = Math.min(to, pos + node.nodeSize)
    const text = node.text!.slice(a - pos, b - pos)
    let out = text
    if (kind === 'lower') out = text.toLowerCase()
    else if (kind === 'upper') out = text.toUpperCase()
    else if (kind === 'title') {
      out = text.toLowerCase().replace(/\p{L}[\p{L}'’]*/gu, (w) => {
        const keep = SMALL_WORDS.test(w) && !first
        first = false
        return keep ? w : w[0].toUpperCase() + w.slice(1)
      })
    } else {
      out = [...text.toLowerCase()]
        .map((ch) => {
          if (/\p{L}/u.test(ch) && startOfSentence) {
            startOfSentence = false
            return ch.toUpperCase()
          }
          if (/[.!?]/.test(ch)) startOfSentence = true
          else if (/\p{L}|\d/u.test(ch)) startOfSentence = false
          return ch
        })
        .join('')
    }
    if (out !== text) tr.replaceWith(tr.mapping.map(a), tr.mapping.map(b), editor.schema.text(out, node.marks))
    return false
  })
  if (tr.docChanged) editor.view.dispatch(tr.setSelection(editor.state.selection.map(tr.doc, tr.mapping)))
}

/** The format painter: the character formatting at the cursor, to put on another passage. */
export type PaintedFormat = { name: string; attrs: Record<string, unknown> }[]

export function copyFormat(editor: Editor): PaintedFormat {
  const { $from, empty, from } = editor.state.selection
  const marks = empty ? (editor.state.storedMarks ?? $from.marks()) : (editor.state.doc.nodeAt(from)?.marks ?? $from.marks())
  return marks.filter((m) => FORMAT_MARKS.includes(m.type.name)).map((m) => ({ name: m.type.name, attrs: { ...m.attrs } }))
}

export function pasteFormat(editor: Editor, format: PaintedFormat) {
  const { from, to, empty } = editor.state.selection
  if (empty) return
  const { tr, schema } = editor.state
  for (const name of FORMAT_MARKS) if (schema.marks[name]) tr.removeMark(from, to, schema.marks[name])
  for (const m of format) tr.addMark(from, to, schema.marks[m.name].create(m.attrs))
  editor.view.dispatch(tr)
}
