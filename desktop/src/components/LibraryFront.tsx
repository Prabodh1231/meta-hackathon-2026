import { type ReactNode, type RefObject, useCallback } from 'react'
import type { Doc } from '../types'
import { FolderRow, FolderTile, type FrontItem } from './FolderTile'
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

/** The Library's front page: its topics drawn as folders, with the smart folders above them. Click
 * selects a folder, double-click or Enter opens it, Space peeks inside, arrows move between them. */
export function LibraryFront({
  smart, topics, totalTopics, recent, query, selected, cited, layout, size, sort, renaming, notice, children, scrollRef,
  onLayout, onSize, onSort, onSelect, onOpen, onPeek, onMenu, onRenamed, onNewTopic, onOpenDoc, onSearchAll,
}: {
  smart: FrontItem[]
  topics: FrontItem[]
  totalTopics: number
  recent: RecentShown[]
  query: string
  selected: string | null
  cited: Map<string, number> // papers the open draft cites, by folder
  layout: FrontLayout
  size: number
  sort: FrontSort
  renaming: string | null
  notice?: ReactNode // above the folders: two topics that hold the same papers
  children?: ReactNode // the New topic form, when open
  scrollRef: RefObject<HTMLDivElement | null>
  onLayout: (l: FrontLayout) => void
  onSize: (n: number) => void
  onSort: (s: FrontSort) => void
  onSelect: (key: string) => void
  onOpen: (key: string) => void
  onPeek: (key: string) => void
  onMenu: (key: string, x: number, y: number) => void
  onRenamed: (key: string, name: string | null) => void
  onNewTopic: () => void
  onOpenDoc: (d: Doc) => void
  onSearchAll: () => void
}) {
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
      <div className="lf-tools">
        <div className="seg" role="group" aria-label="Order of the topics">
          <button aria-pressed={sort === 'size'} onClick={() => onSort('size')}>Largest first</button>
          <button aria-pressed={sort === 'name'} onClick={() => onSort('name')}>A–Z</button>
        </div>
        <div className="seg" role="group" aria-label="Show the folders as">
          <button aria-pressed={layout === 'grid'} onClick={() => onLayout('grid')}>Folders</button>
          <button aria-pressed={layout === 'list'} onClick={() => onLayout('list')}>Rows</button>
        </div>
        {layout === 'grid' && <SizeSlider size={size} onSize={onSize} />}
        <span className="spacer" />
        {searching ? (
          <span className="muted">
            {topics.length} of {plural(totalTopics, 'topic')} match “{query.trim()}”.{' '}
            <button className="link" onClick={onSearchAll}>Search every paper instead</button>
          </span>
        ) : (
          <span className="muted lf-keys">
            <kbd>Space</kbd> peek inside · <kbd>Enter</kbd> open
          </span>
        )}
      </div>
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
        {notice}
        {children}
        {recent.length > 0 && !searching && (
          <>
            <div className="lf-label">Recently opened</div>
            <div className="lf-recent">
              {recent.map((r) =>
                r.kind === 'doc' ? (
                  <button key={`d${r.doc.id}`} onClick={() => onOpenDoc(r.doc)} title={`Open “${r.doc.title}”`}>
                    <span className="lf-doc-ic" aria-hidden="true" />
                    <span className="lf-recent-text">
                      <b>{r.doc.title}</b>
                      <small>{[authorsShort(r.doc), r.doc.year].filter(Boolean).join(' ')}</small>
                    </span>
                  </button>
                ) : (
                  <button
                    key={r.item.key}
                    className={r.item.kind === 'smart' ? 'smart' : r.item.folder?.color ? `c-${r.item.folder.color}` : ''}
                    onClick={() => onOpen(r.item.key)}
                    title={`Open ${r.item.name}`}
                  >
                    <span className="fold-mini" aria-hidden="true" />
                    <span className="lf-recent-text">
                      <b>{r.item.name}</b>
                      <small>{r.item.countText ?? plural(r.item.count, 'paper')}</small>
                    </span>
                  </button>
                ),
              )}
            </div>
          </>
        )}
        {smart.length > 0 && (
          <>
            <div className="lf-label">
              Smart folders <span>filled by a rule, so they keep themselves up to date</span>
            </div>
            {layout === 'grid' ? <div className="lf-grid">{smart.map(tile)}</div> : table(smart, 'Smart folders')}
          </>
        )}
        <div className="lf-label">
          Topics <span>{searching ? '' : 'a paper can be in more than one'}</span>
        </div>
        {layout === 'grid' ? (
          <div className="lf-grid">
            {topics.map(tile)}
            {!searching && (
              <button type="button" className="fold fold-new" onClick={(e) => (e.stopPropagation(), onNewTopic())} title="Make a topic for a subject you choose">
                <span className="fold-art fold-plus" aria-hidden="true">+</span>
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
        {searching && topics.length === 0 && smart.length === 0 && (
          <div className="lib-empty">
            <div className="lib-empty-title">No folder matches</div>
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
