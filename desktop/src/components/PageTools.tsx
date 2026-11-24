import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getMarkRange, type Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { commentsOf, footnotesOf, headingsOf, updateComment, type FigureSize } from '../editor/docFormat'
import { clearFind, findState, findStep, replaceAll, replaceCurrent, setFind } from '../editor/findReplace'
import { ago } from './Meters'

// The tools that sit on and around the page: find and replace, the outline, footnotes under the
// page, comments in the margin, and the small bars on a link or a picture.

// ---------- find and replace ----------

export function FindBar({ editor, replace, focusKey, onClose }: { editor: Editor; replace: boolean; focusKey: number; onClose: () => void }) {
  const [query, setQuery] = useState(() => {
    const { from, to, empty } = editor.state.selection
    const t = empty ? '' : editor.state.doc.textBetween(from, to, ' ')
    return t.length <= 80 && !t.includes('\n') ? t : ''
  })
  const [withReplace, setWithReplace] = useState(replace)
  const [rep, setRep] = useState('')
  const [done, setDone] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const repInput = useRef<HTMLInputElement>(null)
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const f = findState(e)
      return { n: f.matches.length, cur: f.current, cs: f.caseSensitive, ww: f.wholeWord }
    },
  })

  // Ctrl+F again (or Ctrl+H) while open: back to the box, the replace row shown for Ctrl+H.
  useEffect(() => {
    if (replace) setWithReplace(true)
    const el = replace ? repInput.current ?? input.current : input.current
    el?.focus()
    el?.select()
  }, [focusKey, replace])

  useEffect(() => {
    setFind(editor, { query })
    if (query) findStep(editor, 0)
  }, [editor, query])

  // Closing takes the marks off the page.
  useEffect(() => () => clearFind(editor), [editor])

  function close() {
    onClose()
    editor.commands.focus()
  }
  const keys = (e: React.KeyboardEvent, enter: () => void) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      enter()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  return (
    <div className={`find-bar${withReplace ? ' with-replace' : ''}`} role="search" aria-label="Find in the draft">
      <div className="find-row">
        <button className="find-ib find-tog" onClick={() => setWithReplace((r) => !r)} title={withReplace ? 'Hide replace' : 'Replace (Ctrl+H)'} aria-expanded={withReplace}>
          ›
        </button>
        <input
          ref={input}
          value={query}
          placeholder="Find in the draft"
          aria-label="Find"
          onChange={(e) => (setQuery(e.target.value), setDone(''))}
          onKeyDown={(e) => keys(e, () => findStep(editor, e.shiftKey ? -1 : 1))}
        />
        <span className={`find-count${query && !st.n ? ' none' : ''}`} aria-live="polite">
          {!query ? '' : st.n ? `${st.cur + 1} of ${st.n}` : 'No results'}
        </span>
        <button className={`find-ib${st.cs ? ' on' : ''}`} aria-pressed={st.cs} title="Match case" onClick={() => setFind(editor, { caseSensitive: !st.cs })}>
          Aa
        </button>
        <button className={`find-ib${st.ww ? ' on' : ''}`} aria-pressed={st.ww} title="Whole words" onClick={() => setFind(editor, { wholeWord: !st.ww })}>
          <u>ab</u>
        </button>
        <button className="find-ib" title="Previous (Shift+Enter)" aria-label="Previous match" disabled={!st.n} onClick={() => findStep(editor, -1)}>
          ↑
        </button>
        <button className="find-ib" title="Next (Enter)" aria-label="Next match" disabled={!st.n} onClick={() => findStep(editor, 1)}>
          ↓
        </button>
        <button className="find-ib" title="Close (Esc)" aria-label="Close find" onClick={close}>
          ✕
        </button>
      </div>
      {withReplace && (
        <div className="find-row find-rep">
          <input ref={repInput} value={rep} placeholder="Replace with" aria-label="Replace with" onChange={(e) => setRep(e.target.value)} onKeyDown={(e) => keys(e, () => replaceCurrent(editor, rep))} />
          <button disabled={!st.n} onClick={() => replaceCurrent(editor, rep)}>
            Replace
          </button>
          <button
            disabled={!st.n}
            onClick={() => {
              const n = replaceAll(editor, rep)
              setDone(`Replaced ${n}. Ctrl+Z undoes it.`)
            }}
          >
            Replace all
          </button>
        </div>
      )}
      {done && <p className="find-done">{done}</p>}
    </div>
  )
}

// ---------- outline ----------

/** The draft's headings beside the page: click one to go there; the section on screen is marked. */
export function Outline({ editor, floating, onClose }: { editor: Editor; floating: boolean; onClose: () => void }) {
  const key = useEditorState({ editor, selector: ({ editor: e }) => JSON.stringify(headingsOf(e.state.doc).map((h) => [h.level, h.text])) })
  const heads = JSON.parse(key) as [number, string][]
  const top = heads.length ? Math.min(...heads.map(([l]) => l)) : 1
  const [cur, setCur] = useState(0)
  const box = useRef<HTMLElement>(null)

  useEffect(() => {
    const scroller = box.current?.closest('.page-scroll')
    if (!scroller) return
    const mark = () => {
      const line = scroller.getBoundingClientRect().top + 110
      let at = 0
      headingsOf(editor.state.doc).forEach((h, i) => {
        const dom = editor.view.nodeDOM(h.pos)
        if (dom instanceof HTMLElement && dom.getBoundingClientRect().top <= line) at = i
      })
      setCur(at)
    }
    mark()
    scroller.addEventListener('scroll', mark, { passive: true })
    return () => scroller.removeEventListener('scroll', mark)
  }, [editor, key])

  // As a pop-up it closes on a click anywhere else (the toolbar's Outline button toggles it itself).
  useEffect(() => {
    if (!floating) return
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!box.current?.contains(t) && !t.closest('.vbar [aria-label="Outline"]')) onClose()
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [floating, onClose])

  function go(i: number) {
    const h = headingsOf(editor.state.doc)[i]
    if (!h) return
    if (floating) onClose()
    editor.chain().focus().setTextSelection(h.pos + 1).run()
    const dom = editor.view.nodeDOM(h.pos)
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <aside className={`outline${floating ? ' floating' : ''}`} ref={box} aria-label="Outline">
      <div className="outline-card">
        <div className="outline-head">
          <h2>Outline</h2>
          <button className="outline-x" onClick={onClose} title="Hide the outline" aria-label="Hide the outline">
            ✕
          </button>
        </div>
        {heads.length ? (
          <nav>
            {heads.map(([level, text], i) => (
              <button key={i} className={`ol-l${Math.min(level - top + 1, 3)}${i === cur ? ' cur' : ''}`} aria-current={i === cur ? 'location' : undefined} onClick={() => go(i)}>
                {text}
              </button>
            ))}
          </nav>
        ) : (
          <p className="outline-empty">Headings you add are listed here. Paragraph style (¶) → Heading 1, 2 or 3.</p>
        )}
      </div>
    </aside>
  )
}

// ---------- footnotes ----------

/** The draft's footnotes under the page, each note editable in place; its number takes you back to the text. */
export function FootnotesArea({ editor, focus }: { editor: Editor; focus: { index: number; at: number } | null }) {
  const key = useEditorState({ editor, selector: ({ editor: e }) => JSON.stringify(footnotesOf(e.state.doc).map((f) => f.note)) })
  const notes = JSON.parse(key) as string[]
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => {
    if (!focus) return
    const ta = list.current?.querySelectorAll('textarea')[focus.index]
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    ta.closest('li')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focus])

  // Each note grows with its text.
  useLayoutEffect(() => {
    list.current?.querySelectorAll('textarea').forEach((ta) => {
      ta.style.height = 'auto'
      ta.style.height = `${ta.scrollHeight}px`
    })
  }, [key])

  if (!notes.length) return null
  const setNote = (i: number, note: string) => {
    const f = footnotesOf(editor.state.doc)[i]
    if (f) editor.view.dispatch(editor.state.tr.setNodeAttribute(f.pos, 'note', note))
  }
  const back = (i: number) => {
    const f = footnotesOf(editor.state.doc)[i]
    if (!f) return
    editor.chain().focus().setTextSelection(f.pos + 1).run()
    const dom = editor.view.nodeDOM(f.pos)
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  return (
    <section className="footnotes" aria-label="Footnotes">
      <ol ref={list}>
        {notes.map((note, i) => (
          <li key={i}>
            <button className="fn-back" onClick={() => back(i)} title="Back to the text (Enter)">
              {i + 1}
            </button>
            <textarea
              rows={1}
              value={note}
              placeholder="Write the note…"
              aria-label={`Footnote ${i + 1}`}
              onChange={(e) => setNote(i, e.target.value)}
              onKeyDown={(e) => {
                // Enter finishes the note and returns to the text; Shift+Enter starts a new line.
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
                  e.preventDefault()
                  back(i)
                }
              }}
            />
          </li>
        ))}
      </ol>
    </section>
  )
}

// ---------- comments ----------

/** The writer's comments in a column beside the page, level with the text they're about. */
export function CommentsMargin({ editor, focusId }: { editor: Editor; focusId: { id: string; at: number } | null }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      key: JSON.stringify(commentsOf(e.state.doc).map((c) => [c.id, c.note, c.at])),
      doc: e.state.doc, // positions move with every edit
      active: e.state.selection.$from.marks().find((m) => m.type.name === 'comment')?.attrs.id as string | undefined,
    }),
  })
  const list = JSON.parse(st.key) as [string, string, number | null][]
  const box = useRef<HTMLElement>(null)
  const [tops, setTops] = useState<Record<string, number>>({})
  const [open, setOpen] = useState<string | null>(null) // the card being written in
  const current = open ?? st.active ?? null

  // Mark the commented text that belongs to the current card.
  useEffect(() => {
    const dom = editor.view.dom
    dom.querySelectorAll('.comment-mark.cur').forEach((el) => el.classList.remove('cur'))
    if (current) dom.querySelectorAll(`.comment-mark[data-comment="${CSS.escape(current)}"]`).forEach((el) => el.classList.add('cur'))
  }, [editor, current, st.doc])

  // Each card level with its passage, pushed down when it would overlap the one above.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const place = () => {
      const base = el.getBoundingClientRect().top
      const next: Record<string, number> = {}
      let bottom = 0
      for (const c of commentsOf(editor.state.doc)) {
        let top = 0
        try {
          top = editor.view.coordsAtPos(c.from).top - base - 8
        } catch {
          continue
        }
        const card = el.querySelector<HTMLElement>(`[data-card="${CSS.escape(c.id)}"]`)
        top = Math.max(top, bottom)
        next[c.id] = top
        bottom = top + (card?.offsetHeight ?? 60) + 8
      }
      setTops((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next))
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(editor.view.dom)
    return () => ro.disconnect()
  }, [editor, st.doc, st.key, current])

  useEffect(() => {
    if (!focusId) return
    setOpen(focusId.id)
    requestAnimationFrame(() => box.current?.querySelector<HTMLTextAreaElement>(`[data-card="${CSS.escape(focusId.id)}"] textarea`)?.focus())
  }, [focusId])

  if (!list.length) return null
  const select = (id: string) => {
    const c = commentsOf(editor.state.doc).find((x) => x.id === id)
    if (c) editor.chain().setTextSelection({ from: c.from, to: c.to }).scrollIntoView().run()
  }
  return (
    <aside className="comments-margin" ref={box} aria-label="Comments">
      {list.map(([id, note, at]) => (
        <div
          key={id}
          data-card={id}
          className={`comment-card${current === id ? ' cur' : ''}${open === id ? ' expanded' : ''}`}
          style={{ top: tops[id] ?? 0 }}
          onMouseDown={(e) => {
            if (current === id || (e.target as HTMLElement).closest('textarea,button')) return
            e.preventDefault()
            setOpen(id)
            select(id)
          }}
          title={current === id ? undefined : note || 'Comment'}
        >
          {/* Shown instead of the card when the margin is narrow */}
          <svg className="comment-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
          </svg>
          <div className="comment-who">
            <span>Note to self{at ? ` · ${ago(at)}` : ''}</span>
          </div>
          <textarea
            value={note}
            placeholder="Write a note…"
            aria-label="Comment"
            rows={2}
            onFocus={() => setOpen(id)}
            onChange={(e) => updateComment(editor, id, e.target.value)}
            onBlur={(e) => {
              setOpen((o) => (o === id ? null : o))
              // A comment left empty is taken away again.
              if (!e.target.value.trim()) updateComment(editor, id, null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                editor.commands.focus()
              }
            }}
          />
          <div className="comment-acts">
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => updateComment(editor, id, null)} title="Remove the comment (the text stays)">
              Resolve
            </button>
          </div>
        </div>
      ))}
    </aside>
  )
}

// ---------- bars on a link and a picture ----------

export function PageBubbles({ editor }: { editor: Editor }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const sel = e.state.selection
      if (sel instanceof NodeSelection && sel.node.type.name === 'image') {
        const a = sel.node.attrs
        return { kind: 'image' as const, pos: sel.from, size: a.size as FigureSize, align: a.align as string, alt: (a.alt as string) ?? '', href: '', focused: e.isFocused }
      }
      if (sel.empty && e.isActive('link')) return { kind: 'link' as const, pos: sel.from, size: 'm' as FigureSize, align: '', alt: '', href: (e.getAttributes('link').href as string) ?? '', focused: e.isFocused }
      return null
    },
  })
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const [altOpen, setAltOpen] = useState(false)
  const [alt, setAlt] = useState('')

  useLayoutEffect(() => {
    if (!st) return setAt(null)
    const place = () => {
      if (st.kind === 'image') {
        const dom = editor.view.nodeDOM(st.pos)
        const img = dom instanceof HTMLElement ? (dom.querySelector('img') ?? dom) : null
        if (!img) return setAt(null)
        const r = img.getBoundingClientRect()
        setAt({ left: Math.max(8, r.left), top: Math.min(r.bottom + 8, window.innerHeight - 48) })
      } else {
        const range = getMarkRange(editor.state.doc.resolve(st.pos), editor.schema.marks.link)
        const c = editor.view.coordsAtPos(range?.from ?? st.pos)
        setAt({ left: c.left, top: c.bottom + 6 })
      }
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [editor, st])

  useEffect(() => {
    setAltOpen(false)
    setAlt(st?.alt ?? '')
  }, [st?.pos, st?.kind]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!st || !at || (st.kind === 'link' && !st.focused)) return null
  const keep = (e: React.MouseEvent) => !(e.target as HTMLElement).closest('input') && e.preventDefault()
  const setImg = (attrs: Record<string, unknown>) => editor.chain().focus().updateAttributes('image', attrs).setNodeSelection(st.pos).run()

  if (st.kind === 'link')
    return (
      <div className="page-bubble" style={at} onMouseDown={keep} role="toolbar" aria-label="Link">
        <span className="bubble-url" title={st.href}>
          {st.href}
        </span>
        <i />
        <button onClick={() => window.open(st.href, '_blank', 'noopener')}>Open</button>
        <button onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}>Remove link</button>
      </div>
    )

  return (
    <div className="page-bubble" style={at} onMouseDown={keep} role="toolbar" aria-label="Picture">
      {altOpen ? (
        <form
          className="bubble-alt"
          onSubmit={(e) => {
            e.preventDefault()
            setImg({ alt: alt.trim() })
            setAltOpen(false)
          }}
        >
          <input autoFocus value={alt} placeholder="What the picture shows" aria-label="Alt text" onChange={(e) => setAlt(e.target.value)} />
          <button type="submit">Save</button>
        </form>
      ) : (
        <>
          {(
            [
              ['s', 'Small'],
              ['m', 'Medium'],
              ['l', 'Full width'],
            ] as [FigureSize, string][]
          ).map(([k, l]) => (
            <button key={k} className={st.size === k ? 'cur' : ''} onClick={() => setImg({ size: k })}>
              {l}
            </button>
          ))}
          <i />
          {['left', 'center', 'right'].map((a) => (
            <button key={a} className={st.align === a ? 'cur' : ''} onClick={() => setImg({ align: a })} title={a === 'center' ? 'Centre' : a[0].toUpperCase() + a.slice(1)}>
              {a === 'left' ? '⇤' : a === 'right' ? '⇥' : '↔'}
            </button>
          ))}
          <i />
          <button onClick={() => setAltOpen(true)} title={st.alt || 'No description yet: screen readers and Word use it'}>
            {st.alt ? 'Alt text ✓' : 'Alt text…'}
          </button>
          <button onClick={() => editor.chain().focus().deleteSelection().run()}>Remove</button>
        </>
      )}
    </div>
  )
}
