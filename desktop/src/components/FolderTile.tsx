import { memo } from 'react'
import type { Doc, Folder } from '../types'
import type { SavedView } from '../libraryFilters'
import { type View, plural } from './libraryParts'

/** One folder on the Library's front page: a topic, or a smart folder that a rule fills (a
 * ready-made view or one of the reader's saved views). */
export interface FrontItem {
  key: string // 't:<topic id>', 'v:<view>' or 's:<saved view id>': stable, so a re-draw never swaps tiles
  kind: 'smart' | 'topic'
  name: string
  rule?: string // what fills a smart folder, in a few words
  docs: Doc[] // its papers, newest first (none for Removed, whose entries aren't papers any more)
  count: number
  countText?: string // instead of "12 papers" (Drafting from with nothing ticked: the whole library)
  folder?: Folder
  view?: View
  saved?: SavedView
}

/** Fuller folders show more paper sticking out of them: one sheet, two from about 5 papers, three from about 20. */
const sheets = (n: number) => (n ? Math.min(3, 1 + Math.floor(Math.log2(n) / 2.2)) : 0)
const TILT = [-2, 1.5, -0.6]

/** The drawing of a folder: its tab, the back, sheets of paper, and the front. */
export function FolderArt({ item }: { item: FrontItem }) {
  return (
    <span className="fold-art" aria-hidden="true">
      <span className="fold-tab" />
      <span className="fold-back" />
      {Array.from({ length: sheets(item.count) }, (_, i) => (
        <span key={i} className="fold-sheet" style={{ top: `${6 + i * 7}%`, transform: `rotate(${TILT[i]}deg)` }} />
      ))}
      <span className="fold-front">{item.kind === 'smart' && <span className="fold-gear">⚙</span>}</span>
    </span>
  )
}

const colorClass = (item: FrontItem) => (item.kind === 'smart' ? ' smart' : item.folder?.color ? ` c-${item.folder.color}` : '')

/** The name as it shows, or a field to rename it in place. */
function Name({ item, renaming, onRenamed }: { item: FrontItem; renaming: boolean; onRenamed: (key: string, name: string | null) => void }) {
  if (!renaming) return <span className="fold-name">{item.name}</span>
  return (
    <input
      className="fold-rename"
      autoFocus
      defaultValue={item.name}
      maxLength={item.saved ? 60 : 40}
      aria-label={`New name for ${item.name}`}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => onRenamed(item.key, null)}
      onKeyDown={(e) => {
        e.stopPropagation() // arrows and Space edit the name; they don't move between folders
        const name = e.currentTarget.value.trim()
        if (e.key === 'Escape') onRenamed(item.key, null)
        if (e.key === 'Enter') onRenamed(item.key, name && name !== item.name ? name : null)
      }}
    />
  )
}

/** A folder as a tile. The front page handles its clicks (by `data-key`), so a tile only re-draws
 * when what it shows changes: selecting one changes a class, nothing moves. */
export const FolderTile = memo(function FolderTile({ item, selected, cited, renaming, onRenamed }: {
  item: FrontItem
  selected: boolean
  cited: number
  renaming: boolean
  onRenamed: (key: string, name: string | null) => void
}) {
  return (
    // A div, not a button: renaming puts a text field inside it, and a field can't sit in a button.
    <div
      role="button"
      className={`fold${colorClass(item)}${selected ? ' sel' : ''}`}
      data-key={item.key}
      tabIndex={selected ? 0 : -1}
      aria-pressed={selected}
      title={item.rule ?? undefined}
    >
      {cited > 0 && item.view !== 'cited' && (
        <span className="fold-badge" title={`The open draft cites ${plural(cited, 'paper')} in here`}>
          {cited} cited
        </span>
      )}
      <FolderArt item={item} />
      <Name item={item} renaming={renaming} onRenamed={onRenamed} />
      <span className="fold-count">{item.countText ?? plural(item.count, 'paper')}</span>
    </div>
  )
})

const yearSpan = (docs: Doc[]) => {
  const ys = docs.map((d) => d.year).filter((y): y is number => !!y && y > 0)
  return ys.length ? `${Math.min(...ys)}–${Math.max(...ys)}` : ''
}

/** A folder as a row, for the Rows layout. */
export const FolderRow = memo(function FolderRow({ item, selected, cited, renaming, onRenamed }: {
  item: FrontItem
  selected: boolean
  cited: number
  renaming: boolean
  onRenamed: (key: string, name: string | null) => void
}) {
  return (
    <tr className={`fold-row${colorClass(item)}${selected ? ' sel' : ''}`} data-key={item.key} tabIndex={selected ? 0 : -1} aria-selected={selected}>
      <td className="c-name">
        <span className="fold-mini" aria-hidden="true" />
        <Name item={item} renaming={renaming} onRenamed={onRenamed} />
        {cited > 0 && item.view !== 'cited' && <span className="fold-pill">{cited} cited</span>}
      </td>
      <td className="c-what">{item.rule ?? (item.docs[0] ? `Last added: ${item.docs[0].title}` : '')}</td>
      <td className="c-n">{item.countText ?? plural(item.count, 'paper')}</td>
      <td className="c-n">{yearSpan(item.docs)}</td>
    </tr>
  )
})
