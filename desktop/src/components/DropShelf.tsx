import { useState } from 'react'
import { FolderArt, type FrontItem } from './FolderTile'
import { plural } from './libraryParts'

/** The papers being dragged, as their ids: rows and covers both put them on the drag this way. */
export const draggedIds = (e: React.DragEvent) =>
  e.dataTransfer
    .getData('text/plain')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)

/** While papers are dragged, the topic folders along the bottom of the Library, largest first:
 * dropping on one files the papers there too. It goes once the drag ends. */
export function DropShelf({ topics, openKey, count, onDrop }: {
  topics: FrontItem[]
  openKey: string | null // the topic open now: they are already in it
  count: number // papers being dragged
  onDrop: (item: FrontItem, ids: number[]) => void
}) {
  const [over, setOver] = useState<string | null>(null)
  const targets = topics.filter((t) => t.key !== openKey)
  return (
    <div className="shelf" role="region" aria-label="Drop on a topic to add the papers to it">
      <span className="shelf-say">
        Drop on a topic to add {count === 1 ? 'the paper' : plural(count, 'paper')} to it.
        <small>{count === 1 ? 'It stays' : 'They stay'} where {count === 1 ? 'it is' : 'they are'} too.</small>
      </span>
      <div className="shelf-row">
        {targets.length === 0 && <span className="muted">No other topic yet.</span>}
        {targets.map((t) => (
          <div
            key={t.key}
            className={`shelf-fold fold${t.folder?.color ? ` c-${t.folder.color}` : ''}${over === t.key ? ' drop' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              if (over !== t.key) setOver(t.key)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setOver(null)
              const ids = draggedIds(e)
              if (ids.length) onDrop(t, ids)
            }}
          >
            <FolderArt item={t} />
            <span className="fold-name">{t.name}</span>
            <span className="fold-count">{plural(t.count, 'paper')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
