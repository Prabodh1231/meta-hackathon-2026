import { useEffect, useMemo, useRef, useState } from 'react'

export interface PaletteItem {
  group: string
  name: string
  hint: string
  run: () => void
}

/** Ctrl K launcher: jump to a source or topic, or trigger an action, without a permanent sidebar. */
export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? items.filter((i) => `${i.name} ${i.hint} ${i.group}`.toLowerCase().includes(q)) : items
  }, [items, query])
  const active = Math.min(sel, Math.max(shown.length - 1, 0))
  const list = useRef<HTMLUListElement>(null)

  // Arrowing past the bottom of the list keeps the highlighted item in view.
  useEffect(() => {
    list.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' })
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
    } else if (e.key === 'Enter') run(shown[active])
    else if (e.key === 'Escape') onClose()
  }

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={input}
          value={query}
          placeholder="Search sources and topics, or run an action"
          onChange={(e) => {
            setQuery(e.target.value)
            setSel(0)
          }}
          onKeyDown={onKey}
        />
        <ul ref={list}>
          {shown.map((item, i) => (
            <li key={`${item.group}-${item.name}-${i}`} className={i === active ? 'sel' : ''} onClick={() => run(item)}>
              <span className="grp">{item.group}</span>
              <span className="name">{item.name}</span>
              <em>{item.hint}</em>
            </li>
          ))}
          {shown.length === 0 && <li>No match</li>}
        </ul>
        <div className="foot">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
