import { useEffect, useRef } from 'react'
import { useFocusTrap } from '../useFocusTrap'
import type { FrontItem } from './FolderTile'
import { authorsShort, plural } from './libraryParts'

const SHOWN = 60 // papers listed; the rest are counted

/** Space on a folder: its papers listed over the front page, without opening it. Arrows step to the
 * next folder, Enter opens this one, Space or Escape closes. */
export function FolderPeek({ item, onClose, onOpen, onStep }: {
  item: FrontItem
  onClose: () => void
  onOpen: () => void
  onStep: (dir: 1 | -1) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref)
  useEffect(() => ref.current?.focus(), [])
  const docs = item.docs
  return (
    <div className="ql-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="fpeek"
        role="dialog"
        aria-modal="true"
        aria-label={`Inside ${item.name}`}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            onOpen()
          } else if (e.key.startsWith('Arrow')) {
            e.preventDefault()
            onStep(e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1)
          }
        }}
      >
        <header>
          <h3>{item.name}</h3>
          <span className="muted">
            {item.countText ?? plural(item.count, 'paper')}
            {item.rule && ` · ${item.rule}`}
          </span>
        </header>
        <div className="fpeek-list">
          {docs.length === 0 && <p className="muted">{item.view === 'removed' ? 'Open it to see what was removed and restore it.' : 'Nothing in here yet.'}</p>}
          {docs.slice(0, SHOWN).map((d) => (
            <p key={d.id}>
              {d.title}
              <small>{[[authorsShort(d), d.year].filter(Boolean).join(' '), d.venue].filter(Boolean).join(' · ')}</small>
            </p>
          ))}
          {docs.length > SHOWN && <p className="muted">and {docs.length - SHOWN} more</p>}
        </div>
        <footer>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Space</kbd> close</span>
          <span><kbd>← →</kbd> next folder</span>
          <span className="spacer" />
          <button className="primary" onClick={onOpen}>Open</button>
        </footer>
      </div>
    </div>
  )
}
