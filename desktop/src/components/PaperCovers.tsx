import { memo, useEffect, useRef, useState } from 'react'
import { coverDrawn, requestCover } from '../covers'
import type { Doc } from '../types'
import { authorsShort } from './libraryParts'

const isPdfFile = (d: Doc) => d.kind === 'pdf' && !/^https?:\/\//i.test(d.source)

/** A paper's cover: the first page of its PDF, drawn once it scrolls into view; for anything else,
 * or a PDF whose file can't be read, a plain page with its title and authors. */
function Cover({ doc: d }: { doc: Doc }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [url, setUrl] = useState<string | null | undefined>(() => (isPdfFile(d) ? coverDrawn(d.id) : null))
  useEffect(() => {
    if (url !== undefined || !ref.current) return
    let withdraw = () => {}
    const seen = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return withdraw() // scrolled past before its turn: let the next one go first
        withdraw()
        withdraw = requestCover(d.id, setUrl)
      },
      { rootMargin: '200px 0px' },
    )
    seen.observe(ref.current)
    return () => {
      seen.disconnect()
      withdraw()
    }
  }, [d.id, url])
  return (
    <span ref={ref} className={`cover${url ? ' drawn' : ''}`}>
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <span className="cover-plain" aria-hidden="true">
          <b>{d.title}</b>
          <i>{d.authors.slice(0, 3).join(', ')}</i>
        </span>
      )}
    </span>
  )
}

const Card = memo(function Card({ doc: d, selected, current, cited }: { doc: Doc; selected: boolean; current: boolean; cited: boolean }) {
  return (
    <div
      role="option"
      id={`lib-doc-${d.id}`}
      data-id={d.id}
      aria-selected={selected}
      className={`card${selected ? ' sel' : ''}${current ? ' cur' : ''}${d.unread ? ' unread' : ''}`}
      draggable
      title={d.title}
    >
      <Cover doc={d} />
      {cited && <span className="cited-mark card-cited">Cited</span>}
      <span className="card-title">
        {d.starred && <span className="card-star" aria-label="Starred">★ </span>}
        {d.title}
      </span>
      <span className="card-meta">{[authorsShort(d), d.year && d.year > 0 ? d.year : ''].filter(Boolean).join(' ') || d.venue}</span>
    </div>
  )
})

/** The papers of an open folder as covers. Selection works as in the rows: a click selects, Ctrl
 * or Shift selects more, double-click opens, right-click shows the same menu, and the arrow keys move. */
export function PaperCovers({ rows, sel, cur, cited, onSelect, onOpenFile, onMenu, onKeyDown, gridRef }: {
  rows: Doc[]
  sel: Set<number>
  cur: number | null
  cited: Set<number>
  onSelect: (id: number, how: { toggle?: boolean; range?: boolean }) => void
  onOpenFile: (d: Doc) => void
  onMenu: (id: number, x: number, y: number) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  gridRef: React.RefObject<HTMLDivElement | null>
}) {
  const idOf = (e: React.SyntheticEvent) => Number((e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id) || null
  return (
    <div
      ref={gridRef}
      className="cards"
      role="listbox"
      aria-label="Sources"
      aria-multiselectable="true"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        const id = idOf(e)
        if (id && e.detail < 2) onSelect(id, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })
      }}
      onDoubleClick={(e) => {
        const d = rows.find((r) => r.id === idOf(e))
        if (d) onOpenFile(d)
      }}
      onContextMenu={(e) => {
        const id = idOf(e)
        if (!id) return
        e.preventDefault()
        onMenu(id, e.clientX, e.clientY)
      }}
      onDragStart={(e) => {
        const id = idOf(e)
        if (!id) return
        // Dragging a cover that isn't selected drags just that one, as the rows do.
        const ids = sel.has(id) ? rows.filter((r) => sel.has(r.id)).map((r) => r.id) : [id]
        e.dataTransfer.setData('text/plain', ids.join(','))
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      {rows.map((d) => (
        <Card key={d.id} doc={d} selected={sel.has(d.id)} current={cur === d.id} cited={cited.has(d.id)} />
      ))}
    </div>
  )
}

/** How many covers sit in one row of the grid now, for the up and down arrows. */
export function coversPerRow(grid: HTMLElement | null): number {
  if (!grid) return 1
  return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length)
}
