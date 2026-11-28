import { type ReactNode, type RefObject, useCallback, useState } from 'react'
import type { Doc } from '../types'
import { FolderRow, FolderTile, type FrontItem } from './FolderTile'
import { Dropdown } from './Dropdown'
import { authorsShort, plural } from './libraryParts'

export type FrontLayout = 'grid' | 'list'
export type FrontSort = 'size' | 'name'
export type RecentShown = { kind: 'doc'; doc: Doc } | { kind: 'folder'; item: FrontItem }

/** How wide a tile or cover is at a place on the size slider (0 to 100). */
export const tileWidth = (size: number) => Math.round(104 + size * 1.3)

/** The tile in the next or previous row that sits closest under or over `from`, as on a desktop. */
function tileAcross(tiles: HTMLElement[], from: HTMLElement, down: boolean): HTMLElement | undefined {
  const r = from.getBoundingClientRect()
  const rows = tiles.map((t) => [t, t.getBoundingClientRect()] as const).filter(([, b]) => (down ? b.top > r.top + 4 : b.top < r.top - 4))
  if (!rows.length) return undefined
  const edge = down ? Math.min(...rows.map(([, b]) => b.top)) : Math.max(...rows.map(([, b]) => b.top))
  return rows.filter(([, b]) => Math.abs(b.top - edge) < 4).sort((a, b) => Math.abs(a[1].left - r.left) - Math.abs(b[1].left - r.left))[0][0]
}

const RECENT_OPEN_KEY = 'gw.library.recentOpen'
const readRecentOpen = () => {
  try {
    return localStorage.getItem(RECENT_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

/** The Library's front page: its topics drawn as folders (the smart folders are in the column on the
 * left). Click selects a folder, double-click or Enter opens it, Space peeks inside, arrows move
 * between them. */
export function LibraryFront({
  topics, totalTopics, recent, query, selected, cited, layout, size, renaming, notice, children, scrollRef,
  onSelect, onOpen, onPeek, onMenu, onRenamed, onNewTopic, onOpenDoc, onSearchAll,
}: {
  topics: FrontItem[]
  totalTopics: number
  recent: RecentShown[]
  query: string
  selected: string | null
  cited: Map<string, number> // papers the open draft cites, by folder
  layout: FrontLayout
  size: number
  renaming: string | null
  notice?: ReactNode // above the folders: two topics that hold the same papers
  children?: ReactNode // the New topic form, when open
  scrollRef: RefObject<HTMLDivElement | null>
  onSelect: (key: string) => void
  onOpen: (key: string) => void
  onPeek: (key: string) => void
  onMenu: (key: string, x: number, y: number) => void
  onRenamed: (key: string, name: string | null) => void
  onNewTopic: () => void
  onOpenDoc: (d: Doc) => void
  onSearchAll: () => void
}) {
  const [recentOpen, setRecentOpen] = useState(readRecentOpen)
  const toggleRecent = () => {
    setRecentOpen((o) => {
      try {
        localStorage.setItem(RECENT_OPEN_KEY, o ? '0' : '1')
      } catch {
        /* kept for this visit only */
      }
      return !o
    })
  }
  const tiles = () => [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])]
  /** Select a folder and give it the keyboard, scrolling it into view. */
  const go = useCallback(
    (key: string) => {
      onSelect(key)
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
        el?.focus({ preventScroll: true })
        el?.scrollIntoView({ block: 'nearest' })
      })
    },
    [onSelect, scrollRef],
  )
  const keyOf = (e: React.SyntheticEvent) => (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return
    const all = tiles()
    const at = all.findIndex((t) => t.dataset.key === selected)
    if (e.key === 'Enter' && selected && at >= 0) return (e.preventDefault(), onOpen(selected))
    if (e.key === ' ' && selected && at >= 0) return (e.preventDefault(), onPeek(selected))
    if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && at >= 0) {
      e.preventDefault()
      const r = all[at].getBoundingClientRect()
      return onMenu(selected!, r.left + 20, r.top + 20)
    }
    if (!e.key.startsWith('Arrow') || !all.length || e.altKey) return
    e.preventDefault()
    let next: HTMLElement | undefined
    if (at < 0) next = all[0]
    else if (e.key === 'ArrowRight') next = all[at + 1]
    else if (e.key === 'ArrowLeft') next = all[at - 1]
    else if (layout === 'list') next = all[at + (e.key === 'ArrowDown' ? 1 : -1)]
    else next = tileAcross(all, all[at], e.key === 'ArrowDown')
    if (next?.dataset.key) go(next.dataset.key)
  }

  const tile = (item: FrontItem) => (
    <FolderTile key={item.key} item={item} selected={item.key === selected} cited={cited.get(item.key) ?? 0} renaming={renaming === item.key} onRenamed={onRenamed} />
  )
  const row = (item: FrontItem) => (
    <FolderRow key={item.key} item={item} selected={item.key === selected} cited={cited.get(item.key) ?? 0} renaming={renaming === item.key} onRenamed={onRenamed} />
  )
  const table = (items: FrontItem[], label: string) => (
    <table className="lf-table" aria-label={label}>
      <thead>
        <tr>
          <th className="c-name">Name</th>
          <th className="c-what">What's in it</th>
          <th className="c-n">Papers</th>
          <th className="c-n">Years</th>
        </tr>
      </thead>
      <tbody>{items.map(row)}</tbody>
    </table>
  )
  const searching = query.trim().length > 0

  return (
    <div className="lf-main">
      <div
        className="lf-scroll"
        ref={scrollRef}
        tabIndex={-1}
        style={{ '--fw': `${tileWidth(size)}px` } as React.CSSProperties}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          const key = keyOf(e)
          if (key && e.detail < 2) go(key)
        }}
        onDoubleClick={(e) => {
          const key = keyOf(e)
          if (key) onOpen(key)
        }}
        onContextMenu={(e) => {
          const key = keyOf(e)
          if (!key) return
          e.preventDefault()
          go(key)
          onMenu(key, e.clientX, e.clientY)
        }}
      >
        {searching && (
          <p className="lf-found muted">
            {topics.length} of {plural(totalTopics, 'topic')} match “{query.trim()}”.{' '}
            <button className="link" onClick={onSearchAll}>Search every paper instead</button>
          </p>
        )}
        {notice}
        {children}
        {recent.length > 0 && !searching && (
          <div className={`lf-recent${recentOpen ? '' : ' shut'}`}>
            <button className="lf-recent-toggle" aria-expanded={recentOpen} onClick={toggleRecent}>
              <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Recently opened
            </button>
            {recentOpen && (
              <div className="lf-recent-row">
                {recent.map((r) =>
                  r.kind === 'doc' ? (
                    <button
                      key={`d${r.doc.id}`}
                      className="lf-chip-doc"
                      onClick={() => onOpenDoc(r.doc)}
                      title={`Open “${r.doc.title}”${authorsShort(r.doc) ? `, ${[authorsShort(r.doc), r.doc.year].filter(Boolean).join(' ')}` : ''}`}
                    >
                      <span className="lf-doc-ic" aria-hidden="true" />
                      <span className="lf-recent-name">{r.doc.title}</span>
                    </button>
                  ) : (
                    <button
                      key={r.item.key}
                      className={r.item.kind === 'smart' ? 'smart' : r.item.folder?.color ? `c-${r.item.folder.color}` : ''}
                      onClick={() => onOpen(r.item.key)}
                      title={`Open ${r.item.name}: ${r.item.countText ?? plural(r.item.count, 'paper')}`}
                    >
                      <span className="lf-sq" aria-hidden="true" />
                      <span className="lf-recent-name">{r.item.name}</span>
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        )}
        {layout === 'grid' ? (
          <div className="lf-grid" aria-label="Topics">
            {topics.map(tile)}
            {!searching && (
              <button type="button" className="fold fold-new" onClick={(e) => (e.stopPropagation(), onNewTopic())} title="Make a topic for a subject you choose">
                <span className="fold-plus" aria-hidden="true">+</span>
                <span className="fold-name">New topic</span>
                <span className="fold-count">Muse files the papers that match</span>
              </button>
            )}
          </div>
        ) : (
          <>
            {topics.length > 0 && table(topics, 'Topics')}
            {!searching && (
              <button className="link lf-new-row" onClick={onNewTopic}>
                + New topic
              </button>
            )}
          </>
        )}
        {searching && topics.length === 0 && (
          <div className="lib-empty">
            <div className="lib-empty-title">No topic matches</div>
            <p>No topic's name, and no title of a paper in one, has all of these words.</p>
          </div>
        )}
        {!searching && totalTopics === 0 && (
          <p className="muted lf-hint">
            No topics yet. A topic gathers the papers on one subject; make one with New topic and Muse files the papers that match.
          </p>
        )}
      </div>
    </div>
  )
}

const SORTS = [
  { value: 'name', label: 'A–Z' },
  { value: 'size', label: 'Largest first' },
]

/** The front page's controls, on the second row of the Library's header: the order of the topics and
 * (for folders) their size on the left, folders or rows on the right. The slider is the one thing only
 * one view has, so it sits on the side nothing follows it, and switching views moves nothing else. */
export function FrontTools({ layout, size, sort, onLayout, onSize, onSort }: {
  layout: FrontLayout
  size: number
  sort: FrontSort
  onLayout: (l: FrontLayout) => void
  onSize: (n: number) => void
  onSort: (s: FrontSort) => void
}) {
  return (
    <>
      <Dropdown className="lf-sort" label="Order of the topics" value={sort} options={SORTS} onChange={(v) => onSort(v as FrontSort)} />
      {layout === 'grid' && <SizeSlider size={size} onSize={onSize} />}
      <span className="spacer" />
      <div className="seg seg-icons" role="group" aria-label="Show the topics as">
        <button aria-pressed={layout === 'grid'} onClick={() => onLayout('grid')} title="Folders" aria-label="Folders">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
            <path d="M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z" />
          </svg>
        </button>
        <button aria-pressed={layout === 'list'} onClick={() => onLayout('list')} title="Rows" aria-label="Rows">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M5 7h14M5 12h14M5 17h14" />
          </svg>
        </button>
      </div>
    </>
  )
}

/** One slider for the size of folders and of paper covers. */
export function SizeSlider({ size, onSize }: { size: number; onSize: (n: number) => void }) {
  return (
    <label className="lf-size" title="Size">
      <span className="lf-size-small" aria-hidden="true" />
      <input type="range" min={0} max={100} value={size} onChange={(e) => onSize(Number(e.target.value))} aria-label="Size" />
      <span className="lf-size-big" aria-hidden="true" />
    </label>
  )
}
