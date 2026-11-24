import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { getMarkRange, type Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import {
  HIGHLIGHTS,
  LINE_HEIGHTS,
  TEXT_COLORS,
  addComment,
  changeCase,
  clearFormatting,
  copyFormat,
  highlightPen,
  imageData,
  pasteFormat,
  setDocAttr,
  type CaseKind,
  type PaintedFormat,
} from '../editor/docFormat'

// The writing toolbar: a slim column beside the page, so the page starts at the top of the window.
// Buttons that open more choices carry a small corner and open a menu to their right. Several icons
// are adapted from Lucide, lucide.dev (ISC License; portions MIT, from Feather).

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

const STYLES: { value: string; label: string; key: string; style: React.CSSProperties }[] = [
  { value: 'p', label: 'Normal text', key: 'Ctrl+Alt+0', style: { fontSize: 14 } },
  { value: '1', label: 'Heading 1', key: 'Ctrl+Alt+1', style: { fontSize: 20, fontWeight: 700, fontFamily: 'var(--doc-font)' } },
  { value: '2', label: 'Heading 2', key: 'Ctrl+Alt+2', style: { fontSize: 17, fontWeight: 700, fontFamily: 'var(--doc-font)' } },
  { value: '3', label: 'Heading 3', key: 'Ctrl+Alt+3', style: { fontSize: 15, fontWeight: 700, fontFamily: 'var(--doc-font)' } },
  { value: 'quote', label: 'Quote', key: 'Ctrl+Shift+B', style: { fontStyle: 'italic', borderLeft: '3px solid var(--border)', paddingLeft: 8, color: 'var(--muted)' } },
]

const SYMBOLS = '— – … · • § ¶ † ‡ ± × ÷ ≈ ≠ ≤ ≥ ∞ ° µ ‰ α β γ δ Δ ε θ λ μ π ρ σ Σ τ φ χ ω Ω ← → ↑ ↓ ⇒ ✓ © ® ™ € £ ¥ “ ” ‘ ’ « » ½ ¼ ² ³'.split(' ')

const ICONS = {
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  highlight: 'm9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  strike: 'M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16',
  sup: 'm4 19 8-8M12 19l-8-8M20 12h-4c0-1.5.44-2 1.5-2.5S20 8.33 20 7c0-.47-.17-.93-.48-1.29a2.1 2.1 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.06',
  sub: 'm4 5 8 8M12 5l-8 8M20 19h-4c0-1.5.44-2 1.5-2.5S20 15.33 20 14c0-.47-.17-.93-.48-1.29a2.1 2.1 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.07',
  clear: 'M4 7V4h16v3M5 20h6M13 4 8 20M15 15l5 5M20 15l-5 5',
  left: 'M15 12H3M17 18H3M21 6H3',
  center: 'M17 12H7M19 18H5M21 6H3',
  right: 'M21 12H9M21 18H7M21 6H3',
  justify: 'M3 6h18M3 12h18M3 18h18',
  indentMore: 'M21 12H11M21 18H11M21 6H11M3 8l4 4-4 4',
  indentLess: 'M21 12H11M21 18H11M21 6H11M7 8l-4 4 4 4',
  bullets: 'M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13',
  numbers: 'M10 12h11M10 18h11M10 6h11M4 10h2M4 6h1v4M6 18H4c0-1 2-2 2-3s-1-1.5-2-1',
  checklist: 'm3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8',
  insert: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 8v8M8 12h8',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 8a1 1 0 1 0 0 2 1 1 0 0 0 0-2M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21',
  table: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 3v18M3 9h18M3 15h18',
  hr: 'M3 12h18',
  pageBreak: 'M5 3v4h14V3M5 21v-4h14v4M3 12h2M8 12h3M13 12h3M19 12h2',
  toc: 'M3 6h11M3 12h11M3 18h11M18 6h3M18 12h3M18 18h3',
  find: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  outline: 'M21 12h-8M21 6H8M21 18h-8M3 6v4c0 1.1.9 2 2 2h3M3 10v6c0 1.1.9 2 2 2h3',
  painter:
    'M18.4 2.6a1 1 0 1 1 3 3L17.4 9.6a.5.5 0 0 0 0 .7l.9.9a2.4 2.4 0 0 1 0 3.4l-.9.9a.5.5 0 0 1-.7 0L8.4 7.3a.5.5 0 0 1 0-.7l.9-.9a2.4 2.4 0 0 1 3.4 0l.9.9a.5.5 0 0 0 .7 0zM9 8c-1.8 2.7-4 3.5-6.6 4a.5.5 0 0 0-.3.8l7.3 8.9a1 1 0 0 0 1.2.2C12.7 20.4 16 16.8 16 15',
  comment: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM12 7v6M9 10h6',
  cite: 'M7 8h4v4H8.5c0 1.4.9 2.5 2.5 2.9V17c-2.8-.4-4-2.4-4-5.2zm6 0h4v4h-2.5c0 1.4.9 2.5 2.5 2.9V17c-2.8-.4-4-2.4-4-5.2z',
  ask: 'M4 5h16v11h-9l-5 4v-4H4zM9.8 8.8a2.2 2.2 0 1 1 3 2c-.5.2-.8.6-.8 1.1M12 14h.01',
  rowUp: 'M3 14h18v6H3zM12 3v7M9 6l3-3 3 3',
  rowDown: 'M3 4h18v6H3zM12 21v-7M9 18l3 3 3-3',
  colLeft: 'M14 3h6v18h-6zM3 12h7M6 9l-3 3 3 3',
  colRight: 'M4 3h6v18H4zM21 12h-7M18 9l3 3-3 3',
  header: 'M3 5h18v5H3zM3 10v9h18v-9M12 10v9',
  merge: 'M3 5h18v14H3zM8 12h8M10 9l-2 3 2 3M14 9l2 3-2 3',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
}

function Glyph({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

/** Bigger or smaller by one step of the size list (Ctrl+] and Ctrl+[). */
export function stepFontSize(editor: Editor, dir: 1 | -1) {
  const set = editor.getAttributes('textStyle').fontSize as string | undefined
  const el = editor.view.domAtPos(editor.state.selection.from).node
  const shown = parseFloat(getComputedStyle(el instanceof HTMLElement ? el : el.parentElement ?? editor.view.dom).fontSize) * 0.75
  const now = set ? parseFloat(set) : shown
  const sizes = FONT_SIZES.map((s) => parseFloat(s))
  const next = dir > 0 ? sizes.find((s) => s > now + 0.1) : [...sizes].reverse().find((s) => s < now - 0.1)
  if (next) editor.chain().focus().setFontSize(`${next}pt`).run()
}

type Menu = 'style' | 'font' | 'more' | 'align' | 'insert' | 'link' | 'tableSize' | 'symbol' | 'table'

interface Props {
  editor: Editor | null
  onCite: () => void
  onAsk: () => void
  onFind: () => void
  outlineOpen: boolean
  onToggleOutline: () => void
  onShortcuts: () => void
  /** A comment was added: its card in the margin should take the typing. */
  onComment: (id: string) => void
  onError: (msg: string) => void
  /** Counts up on Ctrl+Shift+K: open the link form. */
  linkAsk: number
}

export function FormatToolbar({ editor, onCite, onAsk, onFind, outlineOpen, onToggleOutline, onShortcuts, onComment, onError, linkAsk }: Props) {
  const [menu, setMenu] = useState<{ name: Menu; anchor: HTMLElement } | null>(null)
  const [tip, setTip] = useState<{ name: string; key?: string; hint?: string; rect: DOMRect } | null>(null)
  const [paint, setPaint] = useState<PaintedFormat | null>(null)
  const [more, setMore] = useState(false) // the column scrolls: more buttons below
  const [two, setTwo] = useState(false) // two columns of buttons: one didn't fit
  const oneColumn = useRef(0) // the height one column needs, measured when it stopped fitting
  const scroller = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const tipTimer = useRef<number | undefined>(undefined)

  // Ctrl+Shift+K: the link form, beside the Insert button.
  useEffect(() => {
    const insert = bar.current?.querySelector<HTMLElement>('[data-menu="insert"]')
    if (linkAsk && insert) setMenu({ name: 'link', anchor: insert })
  }, [linkAsk])

  // Re-render only when the formatting at the cursor changes.
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e && {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        sup: e.isActive('superscript'),
        sub: e.isActive('subscript'),
        highlight: e.isActive('highlight'),
        bullets: e.isActive('bulletList'),
        numbers: e.isActive('orderedList'),
        tasks: e.isActive('taskList'),
        quote: e.isActive('blockquote'),
        table: e.isActive('table'),
        link: e.isActive('link'),
        heading: ([1, 2, 3] as const).find((level) => e.isActive('heading', { level })) ?? 0,
        align: (['center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ?? ('left' as const),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        canMerge: e.can().mergeCells(),
        canSplit: e.can().splitCell(),
        headerRow: (() => {
          const $f = e.state.selection.$from
          for (let d = $f.depth; d > 0; d--) if ($f.node(d).type.name === 'table') return $f.node(d).firstChild?.firstChild?.type.name === 'tableHeader'
          return false
        })(),
        fontFamily: (e.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
        fontSize: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
        textColor: (e.getAttributes('textStyle').textColor as string | undefined) ?? '',
        lineHeight: ((e.getAttributes('paragraph').lineHeight || e.getAttributes('heading').lineHeight) as string | null) ?? '',
        spaced: e.state.doc.attrs.spaced !== false,
        empty: e.state.selection.empty,
      },
  })

  // A short window: when one column of buttons doesn't fit, the bar takes two, so every tool stays in
  // sight; back to one once there's room for it again. Shorter still, it scrolls, its foot faded while
  // there's more below.
  useLayoutEffect(() => {
    const el = scroller.current
    const host = bar.current?.parentElement
    if (!el || !host) return
    const check = () => {
      const over = el.scrollHeight - el.clientHeight > 2
      if (!two && over) {
        oneColumn.current = el.scrollHeight + (bar.current!.offsetHeight - el.clientHeight)
        setTwo(true)
      } else if (two && oneColumn.current && host.clientHeight - 28 >= oneColumn.current) setTwo(false)
      setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    ro.observe(host)
    el.addEventListener('scroll', check)
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', check)
    }
  }, [s?.table, two])

  // Menus close on a click elsewhere and on Esc, and when the window resizes.
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      const t = e.target as Node
      if (document.querySelector('.tb-menu')?.contains(t) || menu.anchor.contains(t)) return
      setMenu(null)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setMenu(null)
      editor?.commands.focus()
    }
    const resize = () => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', resize)
    }
  }, [menu, editor])

  // A menu about the table goes away when the cursor leaves the table.
  useEffect(() => {
    if (menu?.name === 'table' && !s?.table) setMenu(null)
  }, [menu, s?.table])

  // The format painter: the next selection on the page takes the copied formatting. Esc puts it down.
  useEffect(() => {
    if (!editor || !paint) return
    const dom = editor.view.dom
    dom.classList.add('painting')
    const up = () =>
      setTimeout(() => {
        if (editor.state.selection.empty) return
        pasteFormat(editor, paint)
        setPaint(null)
      })
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setPaint(null)
    dom.addEventListener('mouseup', up)
    window.addEventListener('keydown', key)
    return () => {
      dom.classList.remove('painting')
      dom.removeEventListener('mouseup', up)
      window.removeEventListener('keydown', key)
    }
  }, [editor, paint])

  if (!editor || !s) return null
  const chain = () => editor.chain().focus()
  // Keep the editor's selection: a normal mousedown would move focus out of it.
  const keep = (e: React.MouseEvent) => e.preventDefault()
  const open = (name: Menu) => (e: React.MouseEvent<HTMLButtonElement>) => {
    setTip(null)
    const anchor = e.currentTarget
    setMenu((m) => (m?.anchor === anchor && m.name === name ? null : { name, anchor }))
  }
  const swap = (name: Menu) => menu && setMenu({ ...menu, name })
  const done = () => setMenu(null)
  const showTip = (name: string, key?: string, hint?: string) => (e: React.SyntheticEvent<HTMLElement>) => {
    const el = e.currentTarget
    window.clearTimeout(tipTimer.current)
    tipTimer.current = window.setTimeout(() => setTip({ name, key, hint, rect: el.getBoundingClientRect() }), e.type === 'focus' ? 0 : 280)
  }
  const hideTip = () => {
    window.clearTimeout(tipTimer.current)
    setTip(null)
  }

  /** A button on the bar. `menuName` makes it open a menu (with the corner mark). */
  const btn = (
    label: string,
    child: ReactNode,
    opts: { key?: string; hint?: string; on?: boolean; run?: () => void; menuName?: Menu; disabled?: boolean; className?: string },
  ) => {
    // Its menu is open (or a menu reached from it, like Insert → Link).
    const opened = !!opts.menuName && menu?.anchor.dataset.menu === opts.menuName
    return (
      <button
        className={[opts.className, opts.on ? 'on' : '', opts.menuName ? 'corner' : '', opened ? 'open' : ''].filter(Boolean).join(' ')}
        aria-label={label}
        aria-pressed={opts.menuName ? undefined : opts.on}
        aria-haspopup={opts.menuName ? 'menu' : undefined}
        aria-expanded={opts.menuName ? opened : undefined}
        data-menu={opts.menuName}
        disabled={opts.disabled}
        onMouseDown={keep}
        onClick={opts.menuName ? open(opts.menuName) : () => (hideTip(), opts.run?.())}
        onMouseEnter={showTip(label, opts.key, opts.hint)}
        onMouseLeave={hideTip}
        onFocus={showTip(label, opts.key, opts.hint)}
        onBlur={hideTip}
      >
        {child}
      </button>
    )
  }

  // Arrow keys move along the bar; the bar is one stop for Tab.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
  }

  const styleLabel = s.quote ? '❝' : s.heading ? `H${s.heading}` : '¶'

  return (
    <nav className={`vbar${two ? ' two' : ''}`} ref={bar} role="toolbar" aria-orientation="vertical" aria-label="Writing toolbar" onKeyDown={onKeyDown}>
      <div className={`vbar-scroll${more ? ' more' : ''}`} ref={scroller}>
        {btn('Undo', <Glyph d={ICONS.undo} />, { key: 'Ctrl+Z', disabled: !s.canUndo, run: () => chain().undo().run() })}
        {btn('Redo', <Glyph d={ICONS.redo} />, { key: 'Ctrl+Y', disabled: !s.canRedo, run: () => chain().redo().run() })}
        <i className="vbar-sep" />
        {btn('Paragraph style', <span className="vbar-txt serif">{styleLabel}</span>, { hint: 'Normal, headings, quote', menuName: 'style' })}
        {btn('Font, size and colour', <span className="vbar-txt">Aa</span>, { on: !!(s.fontFamily || s.fontSize || s.textColor), menuName: 'font' })}
        <i className="vbar-sep" />
        {btn('Bold', <b className="vbar-txt">B</b>, { key: 'Ctrl+B', on: s.bold, run: () => chain().toggleBold().run() })}
        {btn('Italic', <i className="vbar-txt serif">I</i>, { key: 'Ctrl+I', on: s.italic, run: () => chain().toggleItalic().run() })}
        {btn('Underline', <u className="vbar-txt">U</u>, { key: 'Ctrl+U', on: s.underline, run: () => chain().toggleUnderline().run() })}
        {btn(
          'Highlight',
          <>
            <Glyph d={ICONS.highlight} />
            <i className="pen-colour" style={{ background: `var(--hl-${highlightPen.color})` }} />
          </>,
          { key: 'Ctrl+Shift+H', hint: 'colours under Aa', on: s.highlight, run: () => chain().toggleHighlight({ color: highlightPen.color }).run() },
        )}
        {btn('More text formatting', <Glyph d={ICONS.more} size={20} />, {
          hint: 'Strikethrough, super/subscript, case, clear',
          on: s.strike || s.sup || s.sub,
          menuName: 'more',
        })}
        <i className="vbar-sep" />
        {btn('Alignment and spacing', <Glyph d={ICONS[s.align]} />, { hint: 'Ctrl+Shift+L / E / R / J', menuName: 'align' })}
        {btn('Bulleted list', <Glyph d={ICONS.bullets} />, { key: 'Ctrl+Shift+8', on: s.bullets, run: () => chain().toggleBulletList().run() })}
        {btn('Numbered list', <Glyph d={ICONS.numbers} />, { key: 'Ctrl+Shift+7', on: s.numbers, run: () => chain().toggleOrderedList().run() })}
        {btn('Checklist', <Glyph d={ICONS.checklist} />, { key: 'Ctrl+Shift+9', on: s.tasks, run: () => chain().toggleTaskList().run() })}
        <i className="vbar-sep" />
        {btn('Insert', <Glyph d={ICONS.insert} />, { hint: 'Link, image, table, footnote, page break…', menuName: 'insert' })}
        {s.table && btn('Table', <Glyph d={ICONS.table} />, { hint: "You're in a table: rows, columns, header", menuName: 'table', className: 'ctx' })}
        {btn('Comment', <Glyph d={ICONS.comment} />, {
          key: 'Ctrl+Alt+M',
          hint: 'a note to yourself on the selected text',
          run: () => {
            const id = addComment(editor)
            if (id) onComment(id)
            else onError('Select the text the comment is about first.')
          },
        })}
        {btn('Format painter', <Glyph d={ICONS.painter} />, {
          hint: paint ? 'Select the text to paint · Esc puts it down' : 'Copy this formatting onto other text',
          on: !!paint,
          run: () => setPaint(paint ? null : copyFormat(editor)),
        })}
        <i className="vbar-sep" />
        {btn('Find and replace', <Glyph d={ICONS.find} />, { key: 'Ctrl+F', hint: 'Ctrl+H to replace', run: onFind })}
        {btn('Outline', <Glyph d={ICONS.outline} />, { hint: 'Headings beside the page', on: outlineOpen, run: onToggleOutline })}
        {btn('Keyboard shortcuts', <span className="vbar-txt">?</span>, { key: 'Ctrl+/', run: onShortcuts })}
      </div>
      <div className="vbar-foot">
        {btn(
          'Cite',
          <>
            <Glyph d={ICONS.cite} size={19} />
            <small>Cite</small>
          </>,
          { key: 'Ctrl+Shift+C', hint: 'mark the sentence; a source is found in the background', run: onCite, className: 'app-act' },
        )}
        {btn(
          'Ask Muse',
          <>
            <Glyph d={ICONS.ask} size={19} />
            <small>Ask</small>
          </>,
          { key: 'Ctrl+J', hint: 'about the selection, or anything', run: onAsk, className: 'app-act' },
        )}
      </div>

      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          imageData(f)
            .then((src) => chain().setImage({ src, alt: '' }).run())
            .catch((err) => onError(err instanceof Error ? err.message : String(err)))
        }}
      />

      {tip && !menu &&
        createPortal(
          <div className="vbar-tip" role="tooltip" style={{ left: tip.rect.right + 10, top: tip.rect.top + tip.rect.height / 2 }}>
            <span>{tip.name}</span>
            {tip.key && <kbd>{tip.key}</kbd>}
            {tip.hint && <small>{tip.hint}</small>}
          </div>,
          document.body,
        )}

      {menu &&
        createPortal(
          <MenuBox anchor={menu.anchor} name={menu.name}>
            {menu.name === 'style' && (
              <>
                <h4>Paragraph style</h4>
                {STYLES.map((o) => {
                  const cur = o.value === 'quote' ? s.quote : o.value === 'p' ? !s.heading && !s.quote : !s.quote && String(s.heading) === o.value
                  return (
                    <button
                      key={o.value}
                      className={`opt${cur ? ' cur' : ''}`}
                      onMouseDown={keep}
                      onClick={() => {
                        if (o.value === 'quote') chain().toggleBlockquote().run()
                        else if (o.value === 'p') chain().setParagraph().run()
                        else chain().setHeading({ level: Number(o.value) as 1 | 2 | 3 }).run()
                        done()
                      }}
                    >
                      <span style={o.style}>{o.label}</span>
                      <kbd>{o.key}</kbd>
                    </button>
                  )
                })}
                <p className="tb-note">Word export uses Word's own Heading and Quote styles.</p>
              </>
            )}

            {menu.name === 'font' && (
              <>
                <div className="tb-cols">
                  <div>
                    <h4>Font</h4>
                    {FONT_FAMILIES.map((f) => (
                      <button
                        key={f.value}
                        className={`opt${s.fontFamily === f.value ? ' cur' : ''}`}
                        onMouseDown={keep}
                        onClick={() => (f.value ? chain().setFontFamily(f.value).run() : chain().unsetFontFamily().run())}
                      >
                        <span style={{ fontFamily: f.value || 'var(--page-font)', fontSize: 14 }}>{f.label}</span>
                      </button>
                    ))}
                  </div>
                  <div>
                    <h4>Size</h4>
                    <div className="tb-sizes">
                      {FONT_SIZES.map((z) => (
                        <button key={z} className={s.fontSize === z ? 'cur' : ''} onMouseDown={keep} onClick={() => chain().setFontSize(z).run()}>
                          {z.replace('pt', '')}
                        </button>
                      ))}
                      <button className={`wide${!s.fontSize ? ' cur' : ''}`} onMouseDown={keep} onClick={() => chain().unsetFontSize().run()}>
                        Default
                      </button>
                      <button onMouseDown={keep} onClick={() => stepFontSize(editor, -1)} title="Smaller (Ctrl+[)">
                        A−
                      </button>
                      <button className="two" onMouseDown={keep} onClick={() => stepFontSize(editor, 1)} title="Bigger (Ctrl+])">
                        A+
                      </button>
                    </div>
                  </div>
                </div>
                <hr />
                <h4>Text colour</h4>
                <div className="tb-swatches">
                  <button className={`none${!s.textColor ? ' cur' : ''}`} title="Automatic" onMouseDown={keep} onClick={() => chain().unsetTextColor().run()}>
                    ⌀
                  </button>
                  {TEXT_COLORS.map((c) => (
                    <button key={c} className={s.textColor === c ? 'cur' : ''} title={c} style={{ color: `var(--tc-${c})` }} onMouseDown={keep} onClick={() => chain().setTextColor(c).run()}>
                      A
                    </button>
                  ))}
                </div>
                <h4>Highlight</h4>
                <div className="tb-swatches">
                  <button className="none" title="No highlight" onMouseDown={keep} onClick={() => chain().unsetHighlight().run()}>
                    ⌀
                  </button>
                  {HIGHLIGHTS.map((c) => (
                    <button
                      key={c}
                      title={c}
                      className={highlightPen.color === c ? 'pen' : ''}
                      style={{ background: `var(--hl-${c})` }}
                      onMouseDown={keep}
                      onClick={() => {
                        highlightPen.color = c
                        chain().setHighlight({ color: c }).run()
                      }}
                    />
                  ))}
                </div>
                <p className="tb-note">Colours keep their name, so they stay readable in the dark theme; Word gets the printed colour.</p>
              </>
            )}

            {menu.name === 'more' && (
              <>
                <h4>Text</h4>
                <MenuRow icon={ICONS.strike} label="Strikethrough" keys="Ctrl+Shift+S" cur={s.strike} onClick={() => chain().toggleStrike().run()} />
                <MenuRow icon={ICONS.sup} label="Superscript" keys="Ctrl+." cur={s.sup} onClick={() => chain().toggleSuperscript().run()} />
                <MenuRow icon={ICONS.sub} label="Subscript" keys="Ctrl+," cur={s.sub} onClick={() => chain().toggleSubscript().run()} />
                <hr />
                <h4>Change case</h4>
                <div className="tb-seg" role="group" aria-label="Change case">
                  {(
                    [
                      ['sentence', 'Sentence'],
                      ['lower', 'lower'],
                      ['upper', 'UPPER'],
                      ['title', 'Title'],
                    ] as [CaseKind, string][]
                  ).map(([k, l]) => (
                    <button key={k} disabled={s.empty} title={s.empty ? 'Select some text first' : undefined} onMouseDown={keep} onClick={() => changeCase(editor, k)}>
                      {l}
                    </button>
                  ))}
                </div>
                <hr />
                <MenuRow icon={ICONS.clear} label="Clear formatting" keys="Ctrl+Space" onClick={() => (clearFormatting(editor), done())} />
              </>
            )}

            {menu.name === 'align' && (
              <>
                <h4>Align</h4>
                <div className="tb-icons" role="group" aria-label="Align">
                  {(
                    [
                      ['left', 'Left', 'Ctrl+Shift+L'],
                      ['center', 'Centre', 'Ctrl+Shift+E'],
                      ['right', 'Right', 'Ctrl+Shift+R'],
                      ['justify', 'Justify', 'Ctrl+Shift+J'],
                    ] as const
                  ).map(([a, l, k]) => (
                    <button key={a} className={s.align === a ? 'cur' : ''} title={`${l} (${k})`} aria-label={l} onMouseDown={keep} onClick={() => chain().setTextAlign(a).run()}>
                      <Glyph d={ICONS[a]} />
                    </button>
                  ))}
                </div>
                <hr />
                <h4>Indent</h4>
                <div className="tb-icons" role="group" aria-label="Indent">
                  <button title="Decrease indent (Shift+Tab in a list)" aria-label="Decrease indent" onMouseDown={keep} onClick={() => chain().changeIndent(-1).run()}>
                    <Glyph d={ICONS.indentLess} />
                  </button>
                  <button title="Increase indent (Tab in a list)" aria-label="Increase indent" onMouseDown={keep} onClick={() => chain().changeIndent(1).run()}>
                    <Glyph d={ICONS.indentMore} />
                  </button>
                </div>
                <hr />
                <h4>Line spacing</h4>
                <div className="tb-seg" role="group" aria-label="Line spacing">
                  {[['', 'Single'], ...LINE_HEIGHTS.map((v) => [v, v === '2' ? 'Double' : v])].map(([v, l]) => (
                    <button key={v} className={s.lineHeight === v ? 'cur' : ''} onMouseDown={keep} onClick={() => chain().setLineHeight(v || null).run()}>
                      {l}
                    </button>
                  ))}
                </div>
                <button className={`opt check${s.spaced ? ' cur' : ''}`} onMouseDown={keep} onClick={() => setDocAttr(editor, 'spaced', !s.spaced)}>
                  <span>Space between paragraphs</span>
                </button>
                <p className="tb-note">Spacing between paragraphs is for the whole draft.</p>
              </>
            )}

            {menu.name === 'insert' && (
              <>
                <h4>Insert</h4>
                <MenuRow icon={ICONS.link} label={s.link ? 'Edit link' : 'Link'} keys="Ctrl+Shift+K" onClick={() => swap('link')} />
                <MenuRow icon={ICONS.image} label="Image…" note="or paste or drop one onto the page" onClick={() => (done(), imageInput.current?.click())} />
                <MenuRow icon={ICONS.table} label="Table" more onClick={() => swap('tableSize')} />
                <MenuRow icon={ICONS.hr} label="Horizontal line" onClick={() => (chain().setHorizontalRule().run(), done())} />
                <MenuRow icon={ICONS.pageBreak} label="Page break" keys="Ctrl+Enter" onClick={() => (chain().setPageBreak().run(), done())} />
                <hr />
                <MenuRow glyph="x¹" label="Footnote" keys="Ctrl+Alt+F" onClick={() => (chain().insertFootnote().run(), done())} />
                <MenuRow icon={ICONS.toc} label="Table of contents" onClick={() => (chain().insertTableOfContents().run(), done())} />
                <MenuRow glyph="Ω" label="Symbol" more onClick={() => swap('symbol')} />
              </>
            )}

            {menu.name === 'link' && <LinkForm editor={editor} onDone={done} />}

            {menu.name === 'tableSize' && <TableSize onPick={(rows, cols) => (chain().insertTable({ rows, cols, withHeaderRow: true }).run(), done())} />}

            {menu.name === 'symbol' && (
              <>
                <h4>Symbol</h4>
                <div className="tb-symbols">
                  {SYMBOLS.map((c) => (
                    <button key={c} onMouseDown={keep} onClick={() => chain().insertContent(c).run()}>
                      {c}
                    </button>
                  ))}
                </div>
              </>
            )}

            {menu.name === 'table' && (
              <>
                <h4>Rows</h4>
                <MenuRow icon={ICONS.rowUp} label="Insert row above" onClick={() => chain().addRowBefore().run()} />
                <MenuRow icon={ICONS.rowDown} label="Insert row below" onClick={() => chain().addRowAfter().run()} />
                <h4>Columns</h4>
                <MenuRow icon={ICONS.colLeft} label="Insert column left" onClick={() => chain().addColumnBefore().run()} />
                <MenuRow icon={ICONS.colRight} label="Insert column right" onClick={() => chain().addColumnAfter().run()} />
                <hr />
                <MenuRow icon={ICONS.header} label="Header row" cur={s.headerRow} onClick={() => chain().toggleHeaderRow().run()} />
                {(s.canMerge || s.canSplit) && (
                  <MenuRow icon={ICONS.merge} label={s.canMerge ? 'Merge cells' : 'Split cell'} onClick={() => (s.canMerge ? chain().mergeCells().run() : chain().splitCell().run())} />
                )}
                <hr />
                <MenuRow icon={ICONS.trash} label="Delete row" onClick={() => chain().deleteRow().run()} />
                <MenuRow icon={ICONS.trash} label="Delete column" onClick={() => chain().deleteColumn().run()} />
                <MenuRow icon={ICONS.trash} label="Delete table" danger onClick={() => (chain().deleteTable().run(), done())} />
              </>
            )}
          </MenuBox>,
          document.body,
        )}
    </nav>
  )
}

/** A menu beside the bar: to the right of its button, kept inside the window. */
function MenuBox({ anchor, name, children }: { anchor: HTMLElement; name: Menu; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const h = box.current?.offsetHeight ?? 0
    setPos({ left: r.right + 10, top: Math.max(10, Math.min(r.top - 8, window.innerHeight - h - 10)) })
  }, [anchor, name])
  return (
    <div ref={box} className="tb-menu" role="menu" data-menu={name} style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }} onMouseDown={(e) => !(e.target as HTMLElement).closest('input') && e.preventDefault()}>
      {children}
    </div>
  )
}

function MenuRow({ icon, glyph, label, keys, note, cur, more, danger, onClick }: {
  icon?: string
  glyph?: string
  label: string
  keys?: string
  note?: string
  cur?: boolean
  more?: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button className={`opt${cur ? ' cur' : ''}${danger ? ' danger' : ''}`} role="menuitem" onClick={onClick}>
      {icon ? <Glyph d={icon} /> : <span className="opt-glyph">{glyph}</span>}
      <span>
        {label}
        {note && <small> {note}</small>}
      </span>
      {keys && <kbd>{keys}</kbd>}
      {more && <span className="opt-more">›</span>}
    </button>
  )
}

function LinkForm({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  // Editing a link covers all of it, wherever in it the cursor is; otherwise the selection.
  const [range] = useState(() => {
    const sel = editor.state.selection
    return (editor.isActive('link') && getMarkRange(sel.$from, editor.schema.marks.link)) || { from: sel.from, to: sel.to }
  })
  const inLink = editor.isActive('link')
  const current = editor.state.doc.textBetween(range.from, range.to, ' ')
  const [text, setText] = useState(current)
  const [href, setHref] = useState((editor.getAttributes('link').href as string | undefined) ?? '')
  const url = useRef<HTMLInputElement>(null)
  useEffect(() => url.current?.focus(), [])

  function apply() {
    const raw = href.trim()
    if (!raw) return url.current?.focus()
    const target = /^[a-z][\w+.-]*:/i.test(raw) ? raw : /^10\.\d{4,}\//.test(raw) ? `https://doi.org/${raw}` : `https://${raw}`
    const label = text.trim() || raw
    const chain = editor.chain().focus()
    if (range.from !== range.to && label === current) chain.setTextSelection(range).setLink({ href: target }).run()
    else chain.insertContentAt(range, { type: 'text', text: label, marks: [{ type: 'link', attrs: { href: target } }] }).run()
    onDone()
  }
  return (
    <form className="tb-form" onSubmit={(e) => (e.preventDefault(), apply())}>
      <h4>{inLink ? 'Edit link' : 'Link'}</h4>
      <label>
        Text
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label>
        Address
        <input ref={url} value={href} placeholder="https://… or a DOI" onChange={(e) => setHref(e.target.value)} />
      </label>
      <div className="tb-form-acts">
        {inLink && (
          <button type="button" onClick={() => (editor.chain().focus().setTextSelection(range).unsetLink().run(), onDone())}>
            Remove link
          </button>
        )}
        <span />
        <button type="button" onClick={() => (onDone(), editor.commands.focus())}>
          Cancel
        </button>
        <button type="submit" className="primary">
          {inLink ? 'Update' : 'Add link'}
        </button>
      </div>
    </form>
  )
}

function TableSize({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [at, setAt] = useState<[number, number]>([0, 0])
  return (
    <>
      <h4>Table</h4>
      <div className="tb-grid" onMouseLeave={() => setAt([0, 0])}>
        {Array.from({ length: 48 }, (_, i) => {
          const r = Math.floor(i / 8) + 1
          const c = (i % 8) + 1
          return (
            <button
              key={i}
              className={r <= at[0] && c <= at[1] ? 'on' : ''}
              aria-label={`${r} by ${c}`}
              onMouseEnter={() => setAt([r, c])}
              onFocus={() => setAt([r, c])}
              onClick={() => onPick(r, c)}
            />
          )
        })}
      </div>
      <p className="tb-note">{at[0] ? `${at[0]} × ${at[1]} table, first row as headers` : 'Pick a size'}</p>
    </>
  )
}
