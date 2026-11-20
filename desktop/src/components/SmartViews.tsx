import { Icon, type IconName } from './Icon'
import type { View } from './libraryParts'
import { FolderName, type FrontItem } from './FolderTile'

// One icon per ready-made view
const VIEW_ICON: Record<View, IconName> = {
  all: 'layers',
  recent: 'clock',
  drafting: 'drafting',
  cited: 'quote',
  needs: 'alert',
  unread: 'unread',
  starred: 'star',
  none: 'inbox',
  missing: 'fileX',
  unused: 'archive',
  removed: 'trash',
}

/** The Library's left column: the ready-made views and the reader's saved views, each with how many
 * papers it holds. A click opens one; right-click (or the menu key) gives the same menu a folder has. */
export function SmartViews({ items, total, active, renaming, onOpen, onMenu, onRenamed }: {
  items: FrontItem[] // the smart folders, ready-made first, then saved views
  total: number // every paper: what Drafting from uses while nothing is ticked
  active: string | null // the view open now
  renaming: string | null
  onOpen: (key: string) => void
  onMenu: (key: string, x: number, y: number) => void
  onRenamed: (key: string, name: string | null) => void
}) {
  const ready = items.filter((i) => !i.saved)
  const saved = items.filter((i) => i.saved)

  const row = (i: FrontItem) => {
    const icon = <Icon name={i.view ? VIEW_ICON[i.view] : 'funnel'} size={19} />
    const cls = `lib-side-item${active === i.key ? ' on' : ''}${i.view === 'missing' ? ' warn' : ''}`
    if (renaming === i.key) {
      return (
        <div key={i.key} className={cls}>
          {icon}
          <FolderName item={i} renaming onRenamed={onRenamed} />
        </div>
      )
    }
    const wholeLibrary = i.view === 'drafting' && i.count === 0
    return (
      <button
        key={i.key}
        type="button"
        className={cls}
        data-key={i.key}
        aria-current={active === i.key ? 'page' : undefined}
        title={wholeLibrary ? `${i.rule ?? ''} Nothing is ticked, so Muse drafts from the whole library.`.trim() : i.rule}
        onClick={() => onOpen(i.key)}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu(i.key, e.clientX, e.clientY)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            onMenu(i.key, r.left + 24, r.bottom)
          }
        }}
      >
        {icon}
        <span className="lib-side-name">{i.name}</span>
        <span className="lib-side-n">{wholeLibrary ? total : i.count}</span>
      </button>
    )
  }

  return (
    <nav
      className="lib-side"
      aria-label="Smart views"
      onKeyDown={(e) => {
        // Up and down move between the views, as in a list.
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        const all = [...e.currentTarget.querySelectorAll<HTMLElement>('button.lib-side-item')]
        const at = all.indexOf(document.activeElement as HTMLElement)
        if (at < 0) return
        e.preventDefault()
        all[Math.max(0, Math.min(all.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
      }}
    >
      <div className="lib-side-label">Smart views</div>
      {ready.map(row)}
      {saved.length > 0 && (
        <>
          <div className="lib-side-label">Saved views</div>
          {saved.map(row)}
        </>
      )}
    </nav>
  )
}
