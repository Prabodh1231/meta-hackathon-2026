import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'

// Values are CSS, stored on the text as-is; Word export maps them to Word fonts/sizes.
export const FONT_FAMILIES = [
  { label: 'Default font', value: '' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Calibri', value: 'Calibri, sans-serif' },
  { label: 'Segoe UI', value: '"Segoe UI", sans-serif' },
  { label: 'Consolas', value: 'Consolas, monospace' },
]
export const FONT_SIZES = ['10pt', '11pt', '12pt', '14pt', '16pt', '18pt', '24pt', '32pt']

// Paragraph styles, as in a word processor. Word export maps headings to Word's Heading styles.
const STYLES = [
  { value: 'p', label: 'Normal text' },
  { value: '1', label: 'Heading 1' },
  { value: '2', label: 'Heading 2' },
  { value: '3', label: 'Heading 3' },
]

const ICONS = {
  bullets: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  numbers: 'M10 6h10M10 12h10M10 18h10M4 5h1v4M4 9h2M4 14.5c0-.8.6-1.5 1.5-1.5S7 13.6 7 14.3c0 1.2-3 1.7-3 3.7h3',
  quote: 'M5 7h5v5H7.5c0 1.6 1 2.7 2.5 3V17c-3-.4-5-2.5-5-5.6zm9 0h5v5h-2.5c0 1.6 1 2.7 2.5 3V17c-3-.4-5-2.5-5-5.6z',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  cite: 'M7 4h10v16l-5-4-5 4z',
}

function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

export function FormatToolbar({ editor, onCite }: { editor: Editor | null; onCite: () => void }) {
  const [fontsOpen, setFontsOpen] = useState(false)
  const fontsRef = useRef<HTMLDivElement>(null)
  // Re-render only when the formatting at the cursor changes.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e && {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        bullets: e.isActive('bulletList'),
        numbers: e.isActive('orderedList'),
        quote: e.isActive('blockquote'),
        table: e.isActive('table'),
        heading: ([1, 2, 3] as const).find((level) => e.isActive('heading', { level })) ?? 0,
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        fontFamily: (e.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
        fontSize: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      },
  })

  useEffect(() => {
    if (!fontsOpen) return
    const close = (ev: MouseEvent) => !fontsRef.current?.contains(ev.target as Node) && setFontsOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [fontsOpen])

  if (!editor || !state) return null
  const chain = () => editor.chain().focus()
  // Keep the editor's selection: a normal mousedown would move focus out of it.
  const keep = (e: React.MouseEvent) => e.preventDefault()
  const toggle = (label: string, shortcut: string, on: boolean, run: () => void, child: React.ReactNode) => (
    <button className={on ? 'active' : ''} aria-pressed={on} aria-label={label} title={`${label} (${shortcut})`} onMouseDown={keep} onClick={run}>
      {child}
    </button>
  )

  return (
    <div className="format-toolbar" role="toolbar" aria-label="Text formatting">
      <select
        className="style-select"
        aria-label="Paragraph style"
        title="Paragraph style"
        value={state.heading ? String(state.heading) : 'p'}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'p') chain().setParagraph().run()
          else chain().setHeading({ level: Number(v) as 1 | 2 | 3 }).run()
        }}
      >
        {STYLES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <span className="sep" />
      {toggle('Bold', 'Ctrl+B', state.bold, () => chain().toggleBold().run(), <b>B</b>)}
      {toggle('Italic', 'Ctrl+I', state.italic, () => chain().toggleItalic().run(), <i>I</i>)}
      {toggle('Underline', 'Ctrl+U', state.underline, () => chain().toggleUnderline().run(), <u>U</u>)}
      <span className="sep" />
      {toggle('Bulleted list', 'Ctrl+Shift+8', state.bullets, () => chain().toggleBulletList().run(), <Glyph d={ICONS.bullets} />)}
      {toggle('Numbered list', 'Ctrl+Shift+7', state.numbers, () => chain().toggleOrderedList().run(), <Glyph d={ICONS.numbers} />)}
      {toggle('Quote', 'Ctrl+Shift+B', state.quote, () => chain().toggleBlockquote().run(), <Glyph d={ICONS.quote} />)}
      <span className="sep hide-narrow" />
      <button className="hide-narrow" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!state.canUndo} onMouseDown={keep} onClick={() => chain().undo().run()}>
        <Glyph d={ICONS.undo} />
      </button>
      <button className="hide-narrow" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!state.canRedo} onMouseDown={keep} onClick={() => chain().redo().run()}>
        <Glyph d={ICONS.redo} />
      </button>
      <span className="sep" />
      <div className="fonts" ref={fontsRef}>
        <button
          className={fontsOpen || state.fontFamily || state.fontSize ? 'active' : ''}
          aria-expanded={fontsOpen}
          aria-label="Font and size"
          title="Font and size"
          onMouseDown={keep}
          onClick={() => setFontsOpen((o) => !o)}
        >
          Aa
        </button>
        {fontsOpen && (
          <div className="fonts-pop" role="group" aria-label="Font and size">
            <select
              aria-label="Font"
              value={FONT_FAMILIES.some((f) => f.value === state.fontFamily) ? state.fontFamily : ''}
              onChange={(e) => (e.target.value ? chain().setFontFamily(e.target.value).run() : chain().unsetFontFamily().run())}
            >
              {FONT_FAMILIES.map((f) => (
                <option key={f.label} value={f.value} style={{ fontFamily: f.value || undefined }}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Font size"
              value={FONT_SIZES.includes(state.fontSize) ? state.fontSize : ''}
              onChange={(e) => (e.target.value ? chain().setFontSize(e.target.value).run() : chain().unsetFontSize().run())}
            >
              <option value="">Default size</option>
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('pt', ' pt')}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <button
        className="cite-button"
        title="Mark the sentence at the cursor (or the selection) for a citation; a source is found in the background (Ctrl+Shift+C)"
        onMouseDown={keep}
        onClick={onCite}
      >
        <Glyph d={ICONS.cite} />
        <span className="cite-label">Cite</span>
      </button>
      {state?.table && (
        <>
          <span className="sep" />
          <button className="table-btn" onMouseDown={keep} onClick={() => editor?.chain().focus().deleteRow().run()} title="Delete this row of the table">
            −Row
          </button>
          <button className="table-btn" onMouseDown={keep} onClick={() => editor?.chain().focus().deleteColumn().run()} title="Delete this column of the table">
            −Col
          </button>
          <button className="table-btn" onMouseDown={keep} onClick={() => editor?.chain().focus().deleteTable().run()} title="Delete the whole table">
            ×Table
          </button>
        </>
      )}
    </div>
  )
}
