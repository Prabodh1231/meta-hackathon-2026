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

export function FormatToolbar({ editor }: { editor: Editor | null }) {
  // Re-render only when the formatting at the cursor changes.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e && {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        fontFamily: (e.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
        fontSize: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      },
  })
  if (!editor || !state) return null
  const chain = () => editor.chain().focus()

  return (
    <div className="format-toolbar" role="toolbar" aria-label="Text formatting">
      <select
        aria-label="Font"
        value={FONT_FAMILIES.some((f) => f.value === state.fontFamily) ? state.fontFamily : ''}
        onChange={(e) =>
          e.target.value ? chain().setFontFamily(e.target.value).run() : chain().unsetFontFamily().run()
        }
      >
        {FONT_FAMILIES.map((f) => (
          <option key={f.label} value={f.value} style={{ fontFamily: f.value || undefined }}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Font size"
        className="size"
        value={FONT_SIZES.includes(state.fontSize) ? state.fontSize : ''}
        onChange={(e) => (e.target.value ? chain().setFontSize(e.target.value).run() : chain().unsetFontSize().run())}
      >
        <option value="">Size</option>
        {FONT_SIZES.map((s) => (
          <option key={s} value={s}>
            {s.replace('pt', '')}
          </option>
        ))}
      </select>
      <span className="sep" />
      <button
        className={state.bold ? 'active' : ''}
        aria-pressed={state.bold}
        title="Bold (Ctrl+B)"
        onClick={() => chain().toggleBold().run()}
      >
        <b>B</b>
      </button>
      <button
        className={state.italic ? 'active' : ''}
        aria-pressed={state.italic}
        title="Italic (Ctrl+I)"
        onClick={() => chain().toggleItalic().run()}
      >
        <i>I</i>
      </button>
      <button
        className={state.underline ? 'active' : ''}
        aria-pressed={state.underline}
        title="Underline (Ctrl+U)"
        onClick={() => chain().toggleUnderline().run()}
      >
        <u>U</u>
      </button>
    </div>
  )
}
