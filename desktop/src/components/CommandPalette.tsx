import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useFocusTrap } from '../useFocusTrap'

export interface PaletteItem {
  group: string
  name: string
  hint: string
  run: () => void
}

/** Sections, in the order they're listed: what you can do first, then where you can go, then what's
 * in the library. A source's group is its kind (PDF, TEXT, …), so anything unlisted is a source. */
const SECTIONS: { title: string; groups: (g: string) => boolean }[] = [
  { title: 'Actions', groups: (g) => g === 'DO' },
  { title: 'Go to', groups: (g) => g === 'GO' },
  { title: 'Drafts', groups: (g) => g === 'DRAFT' },
  { title: 'Folders', groups: (g) => g === 'FOLDER' },
  { title: 'Sources', groups: (g) => !['DO', 'GO', 'DRAFT', 'FOLDER'].includes(g) },
]

/** Ctrl K launcher: run an action, or jump to a draft, folder or source, without a permanent sidebar.
 * A combobox over a listbox, so screen readers hear the highlighted row as the arrows move it. */
export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()
  const dialog = useRef<HTMLDivElement>(null)
  useFocusTrap(dialog)

  useEffect(() => input.current?.focus(), [])

  // Matches, by section; within a section, names that start with the query come first.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hits = q ? items.filter((i) => `${i.name} ${i.hint} ${i.group}`.toLowerCase().includes(q)) : items
    return SECTIONS.map((s) => {
      const rows = hits.filter((i) => s.groups(i.group))
      if (q) rows.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
      return { title: s.title, rows }
    }).filter((s) => s.rows.length)
  }, [items, query])
  const shown = useMemo(() => sections.flatMap((s) => s.rows), [sections])
  const active = Math.min(sel, Math.max(shown.length - 1, 0))
  const optionId = (i: number) => `${id}-opt-${i}`

  // Arrowing past the bottom of the list keeps the highlighted row in view.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, shown])

  function run(item: PaletteItem | undefined) {
    if (!item) return
    onClose()
    item.run()
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel(Math.min(active + 1, shown.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel(Math.max(active - 1, 0))
    } else if (e.key === 'Home' && !query) {
      e.preventDefault()
      setSel(0)
    } else if (e.key === 'End' && !query) {
      e.preventDefault()
      setSel(shown.length - 1)
    } else if (e.key === 'Enter') run(shown[active])
    else if (e.key === 'Escape') onClose()
  }

  let n = -1 // the option's index in `shown`, counted across sections
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="palette" role="dialog" aria-modal="true" aria-label="Search and actions">
        <input
          ref={input}
          value={query}
          placeholder="Search sources, drafts and actions"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={shown.length ? optionId(active) : undefined}
          onChange={(e) => {
            setQuery(e.target.value)
            setSel(0)
          }}
          onKeyDown={onKey}
        />
        <ul ref={list} id={`${id}-list`} role="listbox" aria-label="Results">
          {sections.map((s) => (
            <li key={s.title} role="presentation" className="palette-section">
              <div className="palette-section-title" aria-hidden="true">
                {s.title} <span>{s.rows.length}</span>
              </div>
              <ul role="group" aria-label={s.title}>
                {s.rows.map((item) => {
                  const i = ++n
                  return (
                    <li
                      key={`${item.group}-${item.name}-${i}`}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === active}
                      className={i === active ? 'sel' : ''}
                      onMouseMove={() => i !== active && setSel(i)}
                      onClick={() => run(item)}
                    >
                      <span className="grp">{item.group === 'DO' || item.group === 'GO' ? '›' : item.group}</span>
                      <span className="name">{item.name}</span>
                      <em>{item.hint}</em>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
          {shown.length === 0 && (
            <li role="presentation" className="palette-empty">
              Nothing matches “{query.trim()}”. Try a title, an author, a draft or an action like “cite”.
            </li>
          )}
        </ul>
        <div className="foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open or run</span>
          <span><kbd>Esc</kbd> close</span>
          <span className="foot-count">{shown.length} results</span>
        </div>
      </div>
    </div>
  )
}
