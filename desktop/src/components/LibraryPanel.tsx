import { Ribbons } from './Ribbons'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MuseTag } from './MuseTag'
import { api } from '../api'
import type { Doc, DocxStyle, Folder, FolderColor, IngestJob, PassageHit, RefStyle, RemovedDoc } from '../types'
import {
  type TimeField, type TimeWindow, buildAxis, docSpan, fmtDay, fmtPublished, gotAt, inWindow, posLabel, removedSince,
} from '../timeline'
import {
  type Filters, type SavedView, NO_FILTERS, authorChoices, filterable, filtersActive, matches, readViews, sameFilters, sameYear,
  venueChoices, yearChoices, yearLabel,
} from '../libraryFilters'
import { Abstract } from './CitingPapersDialog'
import { ImportProgress, owedText } from './ImportProgress'
import { QuickLook } from './QuickLook'
import { RelatedPapers } from './RelatedPapers'
import { Timeline } from './Timeline'
import { TrustBadges, isRetracted, needsMetadata } from './TrustBadges'
import {
  type MenuItem, type Run, type Scope, type View, FolderBar, KIND_LABEL, NewFolderForm, PopMenu, VIEW_NAME, ViewNameForm, alikeTopics, authorsShort,
  load, plural, save, useDismiss,
} from './libraryParts'
import type { FrontItem } from './FolderTile'
import { type FrontLayout, type FrontSort, type RecentShown, FrontTools, LibraryFront, SizeSlider, tileWidth } from './LibraryFront'
import { SmartViews } from './SmartViews'
import { FolderSummary } from './FolderSummary'
import { FolderPeek } from './FolderPeek'
import { FolderMenu } from './FolderMenu'
import { pickSurprise, surpriseText } from '../surprise'
import { AddByWork, typedKind } from './AddByWork'
import { ReadingListDialog } from './ReadingListDialog'
import { DropShelf, draggedIds } from './DropShelf'
import { PaperCovers, coversPerRow } from './PaperCovers'
import { type Recent, noteRecent, readRecent } from '../recentlyOpened'

interface Props {
  docs: Doc[]
  folders: Folder[]
  /** The app bar's search, which filters the library while it's open. */
  query: string
  onQuery: (query: string) => void
  /** The sources Muse drafts from (none: the whole library), and adding or dropping one. */
  selected: Set<number>
  onToggle: (id: number) => void
  onChanged: () => Promise<void>
  onError: (msg: string) => void
  /** A paper to bring into view and open (from the network view or the palette); `n` changes per request. */
  focus?: { id: number; n: number } | null
  /** A topic to open (from the palette); `n` changes per request. */
  focusTopic?: { id: number; n: number } | null
  toFront?: number // goes up each time Library is clicked in the sidebar: show the folders
  /** Ctrl K's Surprise me: open a random unread paper from the whole library. */
  surprise?: number
  onFindDuplicates: () => void
  onCitedPapers: (docId: number) => void
  /** List the works that cite a paper (OpenAlex). */
  onCitingPapers: (docId: number) => void
  onFindMissing: () => void
  cited: number[] // documents the draft cites
  /** Where a new folder's similarity starts (Settings). */
  folderSimilarity: number
  /** The Settings citation style, for a reading list. */
  citationStyle?: DocxStyle
  /** Show a PDF in the app's reader, at a page, with `find` marked there. */
  onOpenPdf: (doc: Doc, page?: number, find?: string) => void
  /** Background imports, newest first, with each file's progress. */
  jobs: IngestJob[]
  /** Add files and folders on disk, in the background. */
  onAddPaths: (paths: string[]) => Promise<void>
  onCancelJob: (id: number) => void
  onDismissJob: (id: number) => void
  /** Show a topic in the citation network (its name searched there). */
  onMapTopic?: (name: string) => void
  /** List recent works citing a topic's papers. */
  onWhatsNew?: (folderId: number) => void
  /** What the app bar's search box says it searches: the folders, or the open folder. */
  onSearchHint?: (placeholder: string) => void
  onFront?: (atFront: boolean) => void // the folders are showing: the dock says which keys work there
  sideSlot?: HTMLElement | null // the app's sidebar, while the Library is open: the smart views go there
}

const FILTERS: { id: Doc['kind']; label: string }[] = [
  { id: 'pdf', label: 'PDFs' },
  { id: 'docx', label: 'Docs' },
  { id: 'text', label: 'Notes' },
  { id: 'web', label: 'Web pages' },
  { id: 'pptx', label: 'Slides' },
  { id: 'image', label: 'Scans' },
]


type ColKey = 'authors' | 'year' | 'venue' | 'added' | 'citations' | 'folders'
type SortKey = 'title' | ColKey | 'match'
type Sort = { key: SortKey; dir: 1 | -1 }

/** "Removed on 3 Oct 2026 as a duplicate of “…”, and its file went to the Recycle Bin." */
function removalText(r: { removed_at: string; reason: string; duplicate_of_title: string; file_trashed?: boolean }): string {
  const why = r.reason === 'duplicate' ? ` as a duplicate${r.duplicate_of_title ? ` of “${r.duplicate_of_title}”` : ''}` : ''
  return `Removed on ${fmtDay(r.removed_at)}${why}${r.file_trashed ? ', and its file went to the Recycle Bin' : ''}.`
}

/** The topics (stored as folders) a document is filed under. Editable: take it out of one, or add it to another. */
function FolderChips({ doc: d, editable, run }: { doc: Doc; editable: boolean; run: Run }) {
  if (!editable && d.folders.length === 0) return null
  return (
    <div className="tags folder-chips">
      {d.folders.map((f) => (
        <span
          key={f.id}
          className={`tag folder-tag${f.state === 'user' ? ' mine' : ''}`}
          title={f.state === 'user' ? 'Added by you' : f.score != null ? `${f.score}% match` : undefined}
        >
          {f.name}
          {editable && (
            <button
              className="tag-x"
              title={`Not about ${f.name}: take it out of this topic`}
              aria-label={`Remove ${d.title} from ${f.name}`}
              onClick={(e) => {
                e.stopPropagation()
                run('Updating…', () => api.setFolderMember(d.id, f.id, false))
              }}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {editable && (
        <input
          className="folder-add"
          list="folder-names"
          placeholder="+ add to topic"
          aria-label={`Add ${d.title} to a topic`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            const value = e.currentTarget.value.trim()
            if (e.key === 'Enter' && value) {
              e.currentTarget.value = ''
              run('Updating…', () => api.addToFolder(d.id, value))
            }
          }}
        />
      )}
    </div>
  )
}


/** JEL classification codes the authors printed; hover for the field each belongs to. */
function JelChips({ doc }: { doc: Doc }) {
  if (doc.jel_codes.length === 0) return null
  return (
    <div className="tags">
      <span className="muted">JEL</span>
      {doc.jel_codes.map((j) => (
        <span key={j.code} className="tag jel" title={j.area}>
          {j.code}
        </span>
      ))}
    </div>
  )
}

/** How well a paper fits the topic being browsed: 'added by you' or its match score. */
function fitLabel(d: Doc, folder: Folder | undefined): string {
  const f = folder && d.folders.find((x) => x.id === folder.id)
  if (!f) return ''
  return f.state === 'user' ? 'added by you' : f.score != null ? `${f.score}%` : ''
}

/** "no summary yet": what Muse couldn't write when the source was added. */
function OwedMark({ doc: d }: { doc: Doc }) {
  return (
    <span className="lb-row-owed" title={`Muse couldn't write its ${owedText(d.missing)} when it was added`}>
      no {owedText(d.missing)} yet
    </span>
  )
}

/** The columns after Title. Which are shown is the reader's choice (right-click the header). */
const COLUMNS: { key: ColKey; label: string; first: 1 | -1 }[] = [
  { key: 'authors', label: 'Authors', first: 1 },
  { key: 'year', label: 'Year', first: -1 },
  { key: 'venue', label: 'Journal', first: 1 },
  { key: 'added', label: 'Added', first: -1 },
  { key: 'citations', label: 'Cited by', first: -1 },
  { key: 'folders', label: 'Topics', first: 1 },
]
const DEFAULT_COLS: ColKey[] = ['authors', 'year', 'venue', 'added']
const SORT_KEY = 'gw.library.sort'
const COLS_KEY = 'gw.library.columns'
const KEPT_KEY = 'gw.library.keepBoth'
const REMOVING_KEY = 'gw.library.removing' // removals whose Undo was still open: finished at the next start
const VIEWS_KEY = 'gw.library.views' // the reader's saved views


/** A search hit's words, marked: the backend wraps each match in the characters STX … ETX. */
const MATCHED = new RegExp(`${String.fromCharCode(2)}(.*?)${String.fromCharCode(3)}`)
function Snippet({ text }: { text: string }) {
  return <>{text.split(MATCHED).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>
}

/** The removals still waiting on their Undo message, as kept across a restart. */
function removing(): number[] {
  return load<number[]>(REMOVING_KEY, [], (v) => Array.isArray(v) && v.every((id) => typeof id === 'number'))
}
function forgetRemoving(ids: number[]) {
  save(REMOVING_KEY, removing().filter((id) => !ids.includes(id)))
}

/** The longest run of matched words in a search snippet ("mobile money"), for the reader to mark. */
function matchedWords(snippet: string): string {
  const [stx, etx] = [String.fromCharCode(2), String.fromCharCode(3)]
  const runs = snippet.match(new RegExp(`(?:${stx}[^${etx}]*${etx} ?)+`, 'g')) ?? []
  return runs.map((r) => r.split(stx).join('').split(etx).join('').trim()).sort((a, b) => b.length - a.length)[0] ?? ''
}

/** A search's words, and whether a paper's record has every one of them (in any order). */
const wordsOf = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean)
function hasWords(d: Doc, words: string[]): boolean {
  if (!words.length) return true
  const hay =
    `${d.title} ${d.authors.join(' ')} ${d.venue} ${d.tags.join(' ')} ${d.keywords.join(' ')} ${d.jel_codes.map((j) => j.code).join(' ')} ${d.folders.map((f) => f.name).join(' ')} ${d.summary}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}
const toggled = <T,>(xs: T[], x: T): T[] => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x])
/** "PDFs", "PDFs +2": what a chip shows of the choices ticked in it. */
const firstAnd = (labels: string[]) =>
  labels.length ? `${labels[0].length > 26 ? labels[0].slice(0, 25) + '…' : labels[0]}${labels.length > 1 ? ` +${labels.length - 1}` : ''}` : ''

/** Something wrong with its record that the reader can fix: retracted, no year or author, or Muse's part still owed. */
function needsAttention(d: Doc): boolean {
  return isRetracted(d) || needsMetadata(d) || d.missing.length > 0
}


/** One filter above the list. Empty, it names what it filters by; set, it says to what, with an × to clear it. */
function Chip({ name, value, onOpen, onClear }: { name: string; value: string; onOpen: (under: HTMLElement) => void; onClear: () => void }) {
  return (
    <span className={`lib-chip${value ? ' on' : ''}`}>
      <button aria-haspopup="menu" onClick={(e) => onOpen(e.currentTarget.parentElement!)} title={value ? `${name}: ${value}` : `Narrow the list by ${name.toLowerCase()}`}>
        {name}
        {value && <>: <b>{value}</b></>}
        <span className="lib-chip-caret" aria-hidden="true">▾</span>
      </button>
      {value && (
        <button className="lib-chip-x" onClick={onClear} aria-label={`Clear the ${name.toLowerCase()} filter`} title="Clear this filter">×</button>
      )}
    </span>
  )
}


/** The library as a list: one line per source, selected as in a mail app or a file explorer. */
function DocTable({
  rows, sel, cur, drafting, cited, folder, sort, onSort, cols, onSelect, onSelectAll, onOpenFile, onStar, onRowMenu, onHeaderMenu, onKeyDown, tableRef,
  ghosts, ghostsSince, openGhost, onOpenGhost, onOpenTopic, children,
}: {
  rows: Doc[]
  sel: Set<number>
  cur: number | null
  drafting: Set<number>
  cited: Set<number>
  folder: Folder | undefined
  sort: Sort
  onSort: (s: Sort) => void
  cols: ColKey[]
  /** A click on a row: alone it selects just that row; `toggle` (Ctrl, or its checkbox) adds or drops it; `range` (Shift) selects through to it. */
  onSelect: (id: number, how: { toggle?: boolean; range?: boolean }) => void
  onSelectAll: () => void
  /** Double-click or Enter: the paper itself (a PDF in the reader, other files in their app, a web page in the browser). */
  onOpenFile: (d: Doc) => void
  onStar: (d: Doc) => void
  onRowMenu: (id: number, x: number, y: number) => void
  onHeaderMenu: (x: number, y: number) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  tableRef: React.RefObject<HTMLTableElement | null>
  /** The timeline's "as of" view: sources in the library then that were removed since, greyed. */
  ghosts: RemovedDoc[]
  ghostsSince: string
  openGhost: number | null
  onOpenGhost: (id: number) => void
  /** Inside a topic: a click on one of a paper's other topics opens it. */
  onOpenTopic: (id: number) => void
  children?: React.ReactNode // below the rows, in the same scroll: passages found inside the papers
}) {
  const allOn = rows.length > 0 && rows.every((d) => sel.has(d.id))
  const someOn = !allOn && rows.some((d) => sel.has(d.id))
  // Inside a topic, "Also in" names each paper's other topics, so the Topics column would repeat it.
  const shown = COLUMNS.filter((c) => cols.includes(c.key) && !(folder && c.key === 'folders'))
  const columns: { key: SortKey; label: string; first: 1 | -1 }[] = [
    { key: 'title', label: 'Title', first: 1 },
    ...shown,
    ...(folder ? [{ key: 'match' as const, label: 'Match', first: -1 as const }] : []),
  ]
  const header = (c: (typeof columns)[number]) => {
    const on = sort.key === c.key
    return (
      <th key={c.key} className={`c-${c.key}`} aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button onClick={() => onSort({ key: c.key, dir: on ? (-sort.dir as 1 | -1) : c.first })}>
          {c.label}
          <span className="sort-arrow" aria-hidden="true">{on ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
        </button>
      </th>
    )
  }
  const cell = (d: Doc, key: SortKey) =>
    key === 'authors' ? authorsShort(d)
      : key === 'year' ? (d.year && d.year > 0 ? d.year : '')
      : key === 'venue' ? d.venue
      : key === 'added' ? d.added_at.slice(0, 10)
      : key === 'citations' ? (d.cited_by_count != null ? d.cited_by_count.toLocaleString() : '')
      : key === 'folders' ? d.folders.map((f) => f.name).join(', ')
      : fitLabel(d, folder)
  return (
    <div className="lib-table-wrap">
      <p id="lib-table-keys" className="sr-only">
        Up and down arrows move between papers, with Shift to select several; Enter opens the paper; Space shows a quick look at it; Delete removes what is selected;
        Control A selects every paper shown; Escape clears the selection.
      </p>
      {(rows.length > 0 || ghosts.length > 0) && (
        <table ref={tableRef} className="lib-table" tabIndex={0} onKeyDown={onKeyDown} aria-label="Sources" aria-multiselectable="true" aria-describedby="lib-table-keys">
          <thead
            title="Right-click to choose columns"
            onContextMenu={(e) => {
              e.preventDefault()
              onHeaderMenu(e.clientX, e.clientY)
            }}
          >
            <tr>
              <th className="c-pick">
                <input
                  type="checkbox"
                  checked={allOn}
                  ref={(el) => {
                    if (el) el.indeterminate = someOn
                  }}
                  onChange={onSelectAll}
                  aria-label="Select every paper shown"
                  title="Select all (Ctrl+A)"
                />
              </th>
              <th className="c-star" aria-label="Starred" />
              {columns.map(header)}
              {folder && <th className="c-also">Also in</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const others = folder ? d.folders.filter((f) => f.id !== folder.id) : []
              return (
              <tr
                key={d.id}
                id={`lib-doc-${d.id}`}
                className={`${sel.has(d.id) ? 'sel' : ''}${cur === d.id ? ' cur' : ''}${d.unread ? ' unread' : ''}`}
                aria-selected={sel.has(d.id)}
                onClick={(e) => {
                  if (e.detail >= 2) return
                  onSelect(d.id, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })
                }}
                onDoubleClick={(e) => {
                  if (!(e.target as HTMLElement).closest('.c-pick, .c-star')) onOpenFile(d)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  onRowMenu(d.id, e.clientX, e.clientY)
                }}
                draggable
                onDragStart={(e) => {
                  // Dragging a row that isn't selected drags just that one, as in a file explorer.
                  const ids = sel.has(d.id) ? rows.filter((r) => sel.has(r.id)).map((r) => r.id) : [d.id]
                  e.dataTransfer.setData('text/plain', ids.join(','))
                  e.dataTransfer.effectAllowed = 'copy'
                }}
              >
                <td
                  className="c-pick"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelect(d.id, { toggle: true, range: e.shiftKey })
                  }}
                >
                  <input type="checkbox" checked={sel.has(d.id)} onChange={() => undefined} aria-label={`Select ${d.title.length > 50 ? d.title.slice(0, 50) + '…' : d.title}`} />
                </td>
                <td className="c-star" onClick={(e) => e.stopPropagation()}>
                  <button
                    className={`lib-star${d.starred ? ' on' : ''}`}
                    aria-pressed={d.starred}
                    aria-label={d.starred ? 'Remove the star' : 'Star this paper'}
                    title={d.starred ? 'Starred' : 'Star'}
                    onClick={() => onStar(d)}
                  >
                    {d.starred ? '★' : '☆'}
                  </button>
                </td>
                <td className="c-title" title={d.title}>
                  <div className="lib-tc">
                    {drafting.has(d.id) && <span className="lib-dot" title="Muse drafts from this" aria-label="Used for drafting" />}
                    <span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind]}</span>
                    <span className="lib-cell-title">{d.title}</span>
                    {cited.has(d.id) && <span className="cited-mark" title="Your draft cites this">Cited</span>}
                    <TrustBadges doc={d} />
                    {d.missing.length > 0 && <OwedMark doc={d} />}
                  </div>
                </td>
                {columns.slice(1).map((c) => (
                  <td key={c.key} className={`c-${c.key}`} title={c.key === 'citations' && d.cited_by_count != null ? 'Citations worldwide, as OpenAlex counts them' : undefined}>
                    {cell(d, c.key)}
                  </td>
                ))}
                {folder && (
                  <td className="c-also" onClick={(e) => (e.target as HTMLElement).closest('button') && e.stopPropagation()} onDoubleClick={(e) => (e.target as HTMLElement).closest('button') && e.stopPropagation()}>
                    <span className="also">
                    {others.slice(0, 2).map((f) => (
                      <button key={f.id} className="also-chip" onClick={() => onOpenTopic(f.id)} title={`Open ${f.name}`}>
                        {f.name}
                      </button>
                    ))}
                    {others.length > 2 && (
                      <span className="also-more" title={others.slice(2).map((f) => f.name).join(', ')}>
                        +{others.length - 2}
                      </span>
                    )}
                    </span>
                  </td>
                )}
              </tr>
              )
            })}
          </tbody>
          {ghosts.length > 0 && (
            <tbody className="lib-ghosts">
              {/* A cell per column, not one spanning them: columns hidden at narrow widths stay hidden. */}
              <tr className="lib-ghost-head">
                <td className="c-pick" />
                <td className="c-star" />
                {columns.map((c) => (
                  <td key={c.key} className={`c-${c.key}`}>
                    {c.key === 'title' && `Removed since ${ghostsSince} (${ghosts.length})`}
                  </td>
                ))}
              </tr>
              {ghosts.map((r) => (
                <tr key={`ghost-${r.id}`} className={`ghost-row${openGhost === r.id ? ' sel' : ''}`} title={removalText(r)} onClick={() => onOpenGhost(r.id)}>
                  <td className="c-pick" />
                  <td className="c-star" />
                  {columns.map((c) => (
                    <td key={c.key} className={`c-${c.key}`}>
                      {c.key === 'title' ? <span className="lib-cell-title">{r.title}</span>
                        : c.key === 'authors' ? authorsShort(r)
                        : c.key === 'year' ? (r.year ?? '')
                        : c.key === 'venue' ? r.venue
                        : c.key === 'added' ? r.added_at.slice(0, 10)
                        : ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      )}
      {children}
    </div>
  )
}

/** Passages found inside the papers for the search, below the rows or the covers. */
function PassageHits({ hits, hitQuery, docById, onOpenHit }: {
  hits: PassageHit[] | null // null: not searching, or still looking
  hitQuery: string
  docById: Map<number, Doc>
  onOpenHit: (d: Doc, hit: PassageHit) => void
}) {
  if (!hits?.length) return null
  return (
    <section className="lib-hits" aria-label="Passages inside your papers">
      <h3 className="lib-sect">Inside your papers</h3>
      {hits.map((h) => {
        const d = docById.get(h.doc_id)
        if (!d) return null
        return (
          <button key={h.doc_id} className="lib-hit" onClick={() => onOpenHit(d, h)} title={`Open the paper at this page, with “${hitQuery}” marked`}>
            <span className="lib-hit-text"><Snippet text={h.snippet} /></span>
            <span className="lib-hit-from">
              {[authorsShort(d), d.year].filter(Boolean).join(' ') || 'No author'} · {d.title.length > 80 ? d.title.slice(0, 80) + '…' : d.title} ·{' '}
              <b>page {h.label || h.page}</b>
              {h.passages > 1 && ` · ${h.passages} passages in this paper`}
            </span>
          </button>
        )
      })}
    </section>
  )
}

/** Shown beside the list when several papers are selected. */
function ManyDetails({ docs, onClose }: { docs: Doc[]; onClose: () => void }) {
  return (
    <section className="lib-detail" aria-label="Selected papers">
      <div className="lib-detail-top">
        <span className="spacer" />
        <button className="icon" onClick={onClose} aria-label="Clear the selection" title="Clear the selection (Esc)">×</button>
      </div>
      <h3 className="lib-detail-title">{docs.length} papers selected</h3>
      <p className="muted lib-detail-hint">The buttons above the list, the right-click menu and the Delete key work on all of them. Drag them onto a topic to file them there.</p>
      <ul className="lib-many">
        {docs.slice(0, 15).map((d) => (
          <li key={d.id}>{d.title}</li>
        ))}
        {docs.length > 15 && <li className="muted">and {docs.length - 15} more</li>}
      </ul>
    </section>
  )
}

/** The removal log: every source removed from the library, most recent first. */
function RemovedTable({ entries, open, onOpen }: { entries: RemovedDoc[]; open: number | null; onOpen: (id: number | null) => void }) {
  return (
    <div className="lib-table-wrap">
      <table className="lib-table" aria-label="Removed sources">
        <thead>
          <tr>
            <th className="c-title rm-first"><span className="th-label">Title</span></th>
            <th className="c-why"><span className="th-label">Why</span></th>
            <th className="c-added"><span className="th-label">Added</span></th>
            <th className="c-added"><span className="th-label">Removed</span></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((r) => (
            <tr key={r.id} className={open === r.id ? 'sel' : ''} aria-selected={open === r.id} onClick={() => onOpen(open === r.id ? null : r.id)}>
              <td className="c-title rm-first">
                <span className="lib-cell-title">{r.title}</span>
                {r.back_in_library != null ? (
                  <span className="cited-mark" title="You added this file again">Added again</span>
                ) : (
                  !r.restorable && <span className="lb-row-owed" title={`Not at ${r.source} any more`}>file gone</span>
                )}
              </td>
              <td className="c-why">{r.reason === 'duplicate' ? 'Duplicate' : 'Removed'}{r.file_trashed ? ' · Recycle Bin' : ''}</td>
              <td className="c-added">{r.added_at.slice(0, 10)}</td>
              <td className="c-added">{r.removed_at.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** What a removed source was, its history, and bringing it back. */
function RemovedDetails({ entry: r, hasDoc, onShowDoc, onClose, run }: {
  entry: RemovedDoc
  hasDoc: (id: number) => boolean
  onShowDoc: (id: number) => void
  onClose: () => void
  run: Run
}) {
  const [confirming, setConfirming] = useState(false)
  const isFile = r.file_exists !== null
  const facts = [r.year, r.venue].filter(Boolean).join(' · ')
  // Opened once the library has reloaded with it, or it would be closed as missing.
  const restore = async () => {
    let id: number | undefined
    await run('Restoring…', async () => {
      id = (await api.restoreRemoved(r.id)).id
    })
    if (id !== undefined) onShowDoc(id)
  }
  return (
    <section className="lib-detail" aria-label="Removed source">
      <div className="lib-detail-top">
        <span className={`kind kind-${r.kind}`}>{KIND_LABEL[r.kind]}</span>
        <span className="removed-badge">Removed</span>
        <span className="spacer" />
        <button className="icon" onClick={onClose} aria-label="Close details" title="Close (Esc)">×</button>
      </div>
      <h3 className="lib-detail-title">{r.title}</h3>
      {r.authors.length > 0 && <p className="lib-detail-authors">{r.authors.join(r.authors.some((a) => a.includes(',')) ? '; ' : ', ')}</p>}
      {facts && <p className="lib-detail-facts">{facts}</p>}
      <p className="lib-detail-note">
        {removalText(r)}
        {r.reason === 'duplicate' && r.duplicate_of != null && hasDoc(r.duplicate_of) && (
          <>
            {' '}
            <button className="link" onClick={() => onShowDoc(r.duplicate_of!)}>Show the copy kept</button>
          </>
        )}
      </p>

      <div className="lib-detail-actions">
        {r.back_in_library != null ? (
          <button className="primary" onClick={() => onShowDoc(r.back_in_library!)}>Show it in your library</button>
        ) : (
          <button className="primary" onClick={restore} disabled={!r.restorable}>Restore</button>
        )}
      </div>
      <p className="muted lib-detail-hint">
        {r.back_in_library != null
          ? 'You added this file again, so it is back in your library.'
          : r.restorable
            ? `Reads the ${isFile ? 'file' : 'page'} again and brings it back with its old added date${Object.keys(r.edited_fields).length ? ', your corrections' : ''}${r.folders.length ? ' and topics' : ''}. Drafts that cite it work again.`
            : `The file is no longer at its old location${r.file_trashed ? '. It went to the Recycle Bin: put it back from there, then restore it here' : ''}.`}
      </p>

      <h4 className="lib-doc-label">History</h4>
      <dl className="lib-detail-meta">
        {r.file_date && gotAt(r) !== r.added_at && (
          <>
            <dt>On this computer</dt>
            <dd>{fmtDay(r.file_date)}</dd>
          </>
        )}
        <dt>Added</dt>
        <dd>{fmtDay(r.added_at)}</dd>
        <dt>Removed</dt>
        <dd>{fmtDay(r.removed_at)}</dd>
        {r.published && (
          <>
            <dt>Published</dt>
            <dd>{fmtPublished(r.published)}</dd>
          </>
        )}
        {r.doi && (
          <>
            <dt>DOI</dt>
            <dd><a className="link" href={`https://doi.org/${r.doi}`} target="_blank" rel="noreferrer">{r.doi}</a></dd>
          </>
        )}
        {r.folders.length > 0 && (
          <>
            <dt>Topics</dt>
            <dd>{r.folders.join(', ')}</dd>
          </>
        )}
        <dt>{isFile ? 'Location' : 'Page'}</dt>
        <dd>
          {isFile ? <code title={r.source}>{r.source}</code> : <a className="link" href={r.source} target="_blank" rel="noreferrer">{r.source}</a>}
          {isFile && !r.file_exists && <span className="muted"> (not there now)</span>}
        </dd>
      </dl>

      <div className="lib-detail-remove">
        {confirming ? (
          <>
            <span>Forget “{r.title}”? Its record is cleared, and the timeline stops showing it.</span>
            <button className="danger" onClick={() => run('Forgetting…', () => api.forgetRemoved(r.id))}>Forget</button>
            <button onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : (
          <button className="link danger-link" onClick={() => setConfirming(true)}>Forget this record</button>
        )}
      </div>
    </section>
  )
}

/** Correct what was read from the file: references and citations are built from these. */
function EditDetails({ doc: d, run, onDone }: { doc: Doc; run: Run; onDone: () => void }) {
  const [f, setF] = useState({
    title: d.title, authors: d.authors.join('\n'), year: d.year ? String(d.year) : '', venue: d.venue, doi: d.doi, url: d.url,
  })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  const year = f.year.trim() ? Number(f.year) : null
  const valid = f.title.trim() !== '' && (year === null || (Number.isInteger(year) && year > 0 && year < 3000))
  return (
    <form
      className="lib-edit"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        onDone()
        // Only what changed: the backend keeps every field it's sent as the user's own, and stops
        // refreshing it from the file.
        const next: Partial<Doc> = {
          title: f.title.trim(),
          authors: f.authors.split('\n').map((a) => a.trim()).filter(Boolean),
          year, venue: f.venue.trim(), doi: f.doi.trim(), url: f.url.trim(),
        }
        const changed = Object.fromEntries(
          Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(d[k as keyof Doc])),
        ) as Partial<Doc>
        if (Object.keys(changed).length) run('Saving…', () => api.updateDocument(d.id, changed))
      }}
      onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onDone())}
    >
      <label>Title<textarea rows={2} value={f.title} onChange={set('title')} autoFocus /></label>
      <label>Authors, one per line<textarea rows={Math.max(2, d.authors.length)} value={f.authors} onChange={set('authors')} /></label>
      <div className="lib-edit-row">
        <label>Year<input value={f.year} onChange={set('year')} inputMode="numeric" /></label>
        <label>Journal or venue<input value={f.venue} onChange={set('venue')} /></label>
      </div>
      <label>DOI<input value={f.doi} onChange={set('doi')} placeholder="10.…" /></label>
      <label>Link<input value={f.url} onChange={set('url')} placeholder="https://…" /></label>
      <p className="muted">What you change here is kept if the file is added again.</p>
      <div className="lib-edit-actions">
        <button className="primary" disabled={!valid}>Save</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  )
}

/** Everything about one source, and what can be done with it. */
/** A paper whose file isn't where it was added from: say so, and offer to find it (the paper keeps
 * its id, so its citations, highlights and topics stay) or to remove it. A file whose contents
 * differ from the one added is a different version, so using it is asked about first. */
function LocateFile({ doc: d, run, onRemove, onLocated }: { doc: Doc; run: Run; onRemove: () => void; onLocated: () => void }) {
  const [differs, setDiffers] = useState<string | null>(null) // the picked file, waiting for a yes
  const locate = async (path: string, force: boolean) => {
    let status = ''
    await run('Locating the file…', async () => {
      status = (await api.locateFile(d.id, path, force)).status
    })
    setDiffers(status === 'differs' ? path : null)
    if (status === 'located') onLocated()
  }
  const pick = async () => {
    const [path] = (await window.rc?.pickFiles()) ?? []
    if (path) await locate(path, false)
  }
  if (differs) {
    return (
      <div className="lib-detail-missing" role="alertdialog" aria-labelledby={`differs-${d.id}`}>
        <b id={`differs-${d.id}`}>Use a different version?</b>
        <span>
          This isn't the same file as the one you added: its contents differ, perhaps a revised version. Quotes and highlights were
          placed on the old one and may not line up.
        </span>
        <div className="lib-detail-missing-acts">
          <button className="primary" onClick={() => { setDiffers(null); pick() }}>Pick another file</button>
          <button onClick={() => locate(differs, true)}>Use it anyway</button>
        </div>
      </div>
    )
  }
  return (
    <div className="lib-detail-missing">
      <span>
        <b>The file isn't where it was.</b> It was at <code>{d.source}</code>. Its text, citations and highlights are still in your
        library.
      </span>
      <div className="lib-detail-missing-acts">
        {window.rc?.pickFiles && <button onClick={pick}>Locate file…</button>}
        <button className="link danger-link" onClick={onRemove}>Remove from library</button>
      </div>
    </div>
  )
}

function DocDetails({ doc: d, on, scopeCount, cited, edit, onEditTaken, onToggle, onUseWholeLibrary, onClose, onCited, onCiting, onRetry, onOpen, onStar, onCopyCitation, onRemove, onLocated, docById, onShowDoc, run }: {
  doc: Doc
  /** Every paper in the library, to name the related ones; a click on one goes to it. */
  docById: Map<number, Doc>
  onShowDoc: (id: number) => void
  on: boolean // Muse drafts from it
  scopeCount: number // sources used for drafting in all, this one included when `on`
  onUseWholeLibrary: () => void
  cited: boolean
  /** Asked for from the right-click menu: open straight into Edit details. */
  edit: boolean
  onEditTaken: () => void
  onOpen: () => void // the paper itself
  onStar: () => void
  onCopyCitation: (under: HTMLElement) => void
  onRemove: () => void
  onLocated: () => void // its missing file was found
  onToggle: () => void
  onClose: () => void
  onCited: () => void
  onCiting: () => void
  onRetry: () => void // ask Muse again for what it couldn't write when this was added
  run: Run
}) {
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!edit) return
    setEditing(true)
    onEditTaken()
  }, [edit]) // eslint-disable-line react-hooks/exhaustive-deps
  const isFile = !/^https?:\/\//i.test(d.source)
  // A file that isn't there can't be opened: Locate file… comes first (see LocateFile).
  const openLabel = !isFile ? 'Open page' : d.file_missing ? '' : d.kind === 'pdf' ? 'Open PDF' : window.rc?.openFile ? 'Open file' : ''
  const terms = [...new Set([...d.keywords, ...d.tags].map((t) => t.toLowerCase()))]
  const volume = d.volume ? `vol. ${d.volume}${d.issue ? `(${d.issue})` : ''}` : d.issue ? `no. ${d.issue}` : ''
  const facts = [d.year, d.venue, volume, d.page_range ? `pp. ${d.page_range}` : ''].filter(Boolean).join(' · ')
  return (
    <section className="lib-detail" aria-label="Source details">
      <div className="lib-detail-top">
        <span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind]}</span>
        <TrustBadges doc={d} showNote />
        {d.unread && <span className="lib-unread-mark" title="Not opened since it was added">Unread</span>}
        <span className="spacer" />
        <button className={`lib-star${d.starred ? ' on' : ''}`} aria-pressed={d.starred} aria-label={d.starred ? 'Remove the star' : 'Star this paper'} title={d.starred ? 'Starred' : 'Star'} onClick={onStar}>
          {d.starred ? '★' : '☆'}
        </button>
        <button className="icon" onClick={onClose} aria-label="Close details" title="Close (Esc)">×</button>
      </div>

      {editing ? (
        <EditDetails doc={d} run={run} onDone={() => setEditing(false)} />
      ) : (
        <>
          <h3 className="lib-detail-title">{d.title}</h3>
          {d.authors.length > 0 && (
            <p className="lib-detail-authors">{d.authors.join(d.authors.some((a) => a.includes(',')) ? '; ' : ', ')}</p>
          )}
          {facts && <p className="lib-detail-facts">{facts}</p>}
          {cited && <p className="lib-detail-cited">Your draft cites this</p>}
          {d.enriched === 'mismatch' && (
            <p className="lib-detail-note">
              The DOI on this paper belongs to another work in OpenAlex, “{d.index_title}”, so nothing was taken from it.
              It may be a paper this one cites: check the DOI under Edit details.
            </p>
          )}
          {d.previously_removed && (
            <p className="lib-detail-note">
              You removed this file once: {removalText(d.previously_removed).replace(/^Removed/, 'removed')} You added it again on {fmtDay(d.added_at)}.
            </p>
          )}
          {d.file_missing && <LocateFile doc={d} run={run} onRemove={onRemove} onLocated={onLocated} />}
          {d.missing.length > 0 && (
            <div className="lb-owed lib-detail-owed">
              <span>Muse couldn't write its {owedText(d.missing)} when it was added. It's searchable and citable meanwhile.</span>
              <button className="link" onClick={onRetry}>
                Try again
              </button>
            </div>
          )}

          <div className="lib-detail-actions">
            {openLabel && (
              <button className="primary" onClick={onOpen} title={d.kind === 'pdf' && isFile ? 'Read the whole PDF here: search, zoom, highlight' : 'Open it (Enter, or double-click its row)'}>
                {openLabel}
              </button>
            )}
            <button className={`lib-use${on ? ' on' : ''}`} aria-pressed={on} onClick={onToggle} title="The sources Muse drafts from and searches for citations in. With none chosen, it uses the whole library.">
              {on ? '● Drafting from this' : 'Use for drafting'}
            </button>
            <button aria-haspopup="menu" onClick={(e) => onCopyCitation(e.currentTarget)} title="Copy its reference as APA, MLA, IEEE or BibTeX">Copy citation ▾</button>
            <span className="lib-use-state" role="status">
              <b>Drafting from:</b> {scopeCount === 0 ? 'whole library' : `${scopeCount} chosen`}
              {on ? ' · this source is included' : scopeCount > 0 ? ' · this source is not included' : ' · this source is included'}
              {scopeCount > 0 && (
                <button className="link" onClick={onUseWholeLibrary}>
                  Use whole library
                </button>
              )}
            </span>
            <button onClick={onCited} title="List the works this paper cites and download free copies of them">Cited papers…</button>
            <button onClick={onCiting} title="Newer works that cite this paper, from OpenAlex">
              Citing papers{d.cited_by_count ? ` (${d.cited_by_count.toLocaleString()})` : ''}…
            </button>
            <button onClick={() => setEditing(true)} title="Correct the title, authors, year, journal, DOI or link">Edit details</button>
          </div>
        </>
      )}

      {d.abstract && (
        <>
          <h4 className="lib-doc-label">Abstract</h4>
          <Abstract text={d.abstract} />
        </>
      )}

      {d.summary && (
        <>
          <h4 className="lib-doc-label">
            Summary <MuseTag from="this paper's text" />
          </h4>
          <p className="lib-doc-summary">{d.summary}</p>
        </>
      )}

      <h4 className="lib-doc-label">Topics</h4>
      <FolderChips doc={d} editable run={run} />

      {(terms.length > 0 || d.jel_codes.length > 0) && <h4 className="lib-doc-label">Keywords</h4>}
      {terms.length > 0 && (
        <div className="tags">
          {terms.map((t) => <span key={t} className="tag">{t}</span>)}
        </div>
      )}
      <JelChips doc={d} />

      <RelatedPapers doc={d} docById={docById} byline={(r) => [authorsShort(r), r.year && r.year > 0 ? r.year : ''].filter(Boolean).join(' ')} onShow={onShowDoc} />

      <h4 className="lib-doc-label">File</h4>
      <dl className="lib-detail-meta">
        <dt>Type</dt>
        <dd>{KIND_LABEL[d.kind]}{d.page_count > 1 ? ` · ${d.page_count} ${d.kind === 'pptx' ? 'slides' : 'pages'}` : ''}</dd>
        {d.doi && (
          <>
            <dt>DOI</dt>
            <dd><a className="link" href={`https://doi.org/${d.doi}`} target="_blank" rel="noreferrer">{d.doi}</a></dd>
          </>
        )}
        {d.publisher && (
          <>
            <dt>Publisher</dt>
            <dd>{d.publisher}</dd>
          </>
        )}
        {d.cited_by_count != null && (
          <>
            <dt>Cited</dt>
            <dd>{d.cited_by_count.toLocaleString()} times worldwide (OpenAlex)</dd>
          </>
        )}
        {d.url && d.url !== d.source && (
          <>
            <dt>Link</dt>
            <dd><a className="link" href={d.url} target="_blank" rel="noreferrer">{d.url.replace(/^https?:\/\/(www\.)?/, '')}</a></dd>
          </>
        )}
        {d.published && (
          <>
            <dt>Published</dt>
            <dd>{fmtPublished(d.published)}</dd>
          </>
        )}
        {d.file_date && gotAt(d) !== d.added_at && (
          <>
            <dt>On this computer</dt>
            <dd title="The file's own date: the earlier of when it was created and last changed">{fmtDay(d.file_date)}</dd>
          </>
        )}
        <dt>Added</dt>
        <dd>{fmtDay(d.added_at)}</dd>
        <dt>{isFile ? 'Location' : 'Page'}</dt>
        <dd>
          {isFile ? <code title={d.source}>{d.source}</code> : <a className="link" href={d.source} target="_blank" rel="noreferrer">{d.source}</a>}
          {isFile && window.rc?.showFile && (
            <button className="link" onClick={() => window.rc!.showFile!(d.source).catch(() => {})}>Show in folder</button>
          )}
        </dd>
      </dl>

      <div className="lib-detail-remove">
        <button className="link danger-link" onClick={onRemove} title="The file stays where it is. You can undo this, or restore it later from Removed.">Remove from library</button>
      </div>
    </section>
  )
}


/** One button for every way in: files, a folder on disk, or what's pasted into its box: a web
 * link, a path, or a paper's DOI or title, which is looked up and added in the box (AddByWork). */
function AddSources({ disabled, onFiles, onFolder, onLink, onAdded, onShow }: {
  disabled: boolean
  onFiles: () => void
  onFolder: () => void
  onLink: (value: string) => void
  onAdded: (docId: number) => Promise<void>
  onShow: (docId: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [value, setValue] = useState('')
  const [finding, setFinding] = useState<string | null>(null) // a DOI or title being looked up
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    setPasting(false)
    setValue('')
    setFinding(null)
  }, [])
  useDismiss(open, close, ref)
  const pick = (fn: () => void) => () => {
    close()
    fn()
  }
  return (
    <div className="add-sources" ref={ref}>
      <button className="primary" onClick={() => (open ? close() : setOpen(true))} disabled={disabled} aria-haspopup="menu" aria-expanded={open}>
        + Add sources
      </button>
      {open && (
        <div
          className="lib-menu add-menu"
          role="menu"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            close()
          }}
        >
          {window.rc && (
            <>
              <button role="menuitem" onClick={pick(onFiles)}>
                <b>Files…</b>
                <span>PDF, Word, PowerPoint, Markdown, text, HTML, images</span>
              </button>
              <button role="menuitem" onClick={pick(onFolder)}>
                <b>Folder…</b>
                <span>Every readable document in a folder and its subfolders</span>
              </button>
            </>
          )}
          {pasting ? (
            <form
              className="add-link"
              onSubmit={(e) => {
                e.preventDefault()
                const v = value.trim().replace(/^"(.*)"$/, '$1')
                if (!v) return
                const kind = typedKind(v)
                // A DOI or title stays in the box: what it found, and what happened, is said here.
                if (kind === 'doi' || kind === 'title') setFinding(v)
                else pick(() => onLink(v))()
              }}
            >
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="A link, DOI, paper title, or file path"
                aria-label="Web link, DOI, paper title, or file path"
              />
              <button className="primary" disabled={!value.trim()}>Add</button>
            </form>
          ) : (
            <button role="menuitem" onClick={() => setPasting(true)}>
              <b>Paste a link, DOI, title or path…</b>
              <span>A web page; a paper by its DOI or title, with a free copy found for you; or a file or folder on this computer</span>
            </button>
          )}
          {finding && <AddByWork key={finding} text={finding} onAdded={onAdded} onShow={(id) => pick(() => onShow(id))()} />}
          <p className="muted add-hint">You can also drop files anywhere on the window.</p>
        </div>
      )}
    </div>
  )
}

const RECENT_DAYS = 14
const UNDO_MS = 8000
const MAX_CHOICES = 300 // authors or journals listed in a filter's menu, the ones with the most papers
type MenuKind = 'row' | 'topic' | 'cite' | 'columns' | 'f-kind' | 'f-year' | 'f-topic' | 'f-author' | 'f-venue' | 'merge'
type PaperLayout = 'rows' | 'covers'
const FRONT_LAYOUT_KEY = 'gw.library.folderLayout'
const FRONT_SORT_KEY = 'gw.library.folderSort'
const PAPER_LAYOUT_KEY = 'gw.library.paperLayout'
const SIZE_KEY = 'gw.library.size'
const SUMMARY_KEY = 'gw.library.summaryOpen' // the panel beside the folders, shown or hidden
const RECENT_SHOWN = 5
/** The smart folders made from ready-made views, in the order they show; each shows only when it has
 * something in it, except All sources and Drafting from. */
const SMART_VIEWS: View[] = ['all', 'recent', 'drafting', 'cited', 'needs', 'unread', 'starred', 'none', 'missing', 'unused', 'removed']
const VIEW_RULE: Record<View, string> = {
  all: 'Every paper in the library',
  recent: `Added in the last ${RECENT_DAYS} days`,
  drafting: 'Papers ticked for Muse to write from; with none ticked it uses them all',
  cited: 'Papers the open draft cites',
  needs: 'Retracted, missing a year or authors, or still owed a summary',
  unread: 'Not opened yet',
  starred: 'Papers you starred',
  none: 'In no topic yet',
  missing: "The file isn't where it was added from",
  unused: 'Never opened, cited in a draft, highlighted or ticked for drafting',
  removed: 'Taken out of the library; open one to restore it',
}
/** A folder's key on the front page, for a view or a topic. */
const keyOf = (scope: Scope) => (typeof scope === 'number' ? `t:${scope}` : `v:${scope}`)
const STYLE_NAME: Record<RefStyle, string> = { apa: 'APA', mla: 'MLA', ieee: 'IEEE', bibtex: 'BibTeX' }
const named = (ds: Doc[]) => (ds.length === 1 ? `“${ds[0].title.length > 48 ? ds[0].title.slice(0, 48) + '…' : ds[0].title}”` : `${ds.length} papers`)

/** The library. It opens on its topics drawn as folders, with smart folders (the ready-made views
 * and saved views) above them; opening one shows its papers as one line each in a sortable list
 * (or as covers), with the selected source's details on the right. A click selects, Ctrl or Shift
 * selects more, and the bar above the list (or a right-click) acts on the selection. The app bar's
 * search box finds folders on the front page, and inside one filters it and looks inside the papers. Memoized: the app redraws at
 * every pause in typing, and the library has no reason to follow. */
export const LibraryPanel = memo(function LibraryPanel({
  docs: allDocs, folders, query, onQuery, selected: drafting, onToggle, onChanged, onError, focus, onFindDuplicates, onCitedPapers, onCitingPapers, onFindMissing, cited,
  folderSimilarity, citationStyle = 'apa', onOpenPdf, jobs, focusTopic, surprise, onAddPaths, onCancelJob, onDismissJob, onMapTopic, onWhatsNew, onSearchHint, onFront, sideSlot, toFront,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS) // the chips above the list
  const [views, setViewsState] = useState<SavedView[]>(() =>
    readViews(load<unknown>(VIEWS_KEY, [], () => true)).filter((v) => typeof v.scope === 'number' || (v.scope in VIEW_NAME && v.scope !== 'removed')),
  )
  const [naming, setNaming] = useState<{ id: string | null } | null>(null) // the name form: a new view (no id yet), or one being renamed
  const [peek, setPeek] = useState(false) // Quick look is open on the selected paper
  const [scope, setScope] = useState<Scope>('all') // the view or topic being browsed
  const [picked, setPicked] = useState<Set<number>>(new Set()) // the selected rows
  const [cur, setCur] = useState<number | null>(null) // the row the keyboard is on
  const anchor = useRef<number | null>(null) // where a Shift selection starts
  const [creating, setCreating] = useState(false)
  const [sort, setSortState] = useState<Sort>(() =>
    load<Sort>(SORT_KEY, { key: 'added', dir: -1 }, (v) => {
      const s = v as Sort | null
      return !!s && (s.dir === 1 || s.dir === -1) && (s.key === 'title' || COLUMNS.some((c) => c.key === s.key))
    }),
  )
  const [cols, setCols] = useState<ColKey[]>(() => load<ColKey[]>(COLS_KEY, DEFAULT_COLS, (v) => Array.isArray(v) && v.every((k) => COLUMNS.some((c) => c.key === k))))
  const [keptBoth, setKeptBoth] = useState<string[]>(() => load<string[]>(KEPT_KEY, [], (v) => Array.isArray(v)))
  const [moreOpen, setMoreOpen] = useState(false)
  const [menu, setMenu] = useState<{ kind: MenuKind; x: number; y: number; folderId?: number } | null>(null)
  // The front page: the topics as folders. `opened` is the folder whose papers show, by key
  // ('t:12', 'v:needs', 's:…'); null shows the folders. `selKey` is the folder selected there.
  const [opened, setOpened] = useState<string | null>(null)
  const [selKey, setSelKey] = useState<string | null>(null)
  const [frontLayout, setFrontLayoutState] = useState<FrontLayout>(() => load<FrontLayout>(FRONT_LAYOUT_KEY, 'grid', (v) => v === 'grid' || v === 'list'))
  const [frontSort, setFrontSortState] = useState<FrontSort>(() => load<FrontSort>(FRONT_SORT_KEY, 'size', (v) => v === 'size' || v === 'name'))
  const [paperLayout, setPaperLayoutState] = useState<PaperLayout>(() => load<PaperLayout>(PAPER_LAYOUT_KEY, 'rows', (v) => v === 'rows' || v === 'covers'))
  const [size, setSizeState] = useState<number>(() => load<number>(SIZE_KEY, 60, (v) => typeof v === 'number' && v >= 0 && v <= 100))
  const [summaryOpen, setSummaryOpenState] = useState<boolean>(() => load<boolean>(SUMMARY_KEY, true, (v) => typeof v === 'boolean'))
  const [peekKey, setPeekKey] = useState<string | null>(null) // Space on a folder: its papers listed over the folders
  const [folderMenu, setFolderMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [readingList, setReadingList] = useState<{ docs: Doc[]; title: string } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null) // the folder whose name is being edited in place
  const [dragging, setDragging] = useState<number | null>(null) // papers being dragged: the shelf of topics shows
  const [recent, setRecent] = useState<Recent[]>(readRecent)
  const frontRef = useRef<HTMLDivElement>(null)
  const coversRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const menuClosed = useRef<{ kind: MenuKind; at: number } | null>(null) // so a click on an open chip closes its menu
  const [toast, setToast] = useState<{ text: string; undo?: () => void; n: number } | null>(null)
  const [hiding, setHiding] = useState<Set<number>>(new Set()) // removed a moment ago; Undo brings them back
  const pending = useRef<{ ids: number[]; timer: number } | null>(null)
  const [editFor, setEditFor] = useState<number | null>(null) // open this paper's details in Edit details
  const [passages, setPassages] = useState<{ q: string; hits: PassageHit[] } | null>(null)
  const [removed, setRemoved] = useState<RemovedDoc[]>([]) // the removal log
  const [openRemoved, setOpenRemoved] = useState<number | null>(null) // removed source whose details are showing
  const [timeline, setTimeline] = useState<TimeWindow | null>(null) // the date slider, when open
  const [lookupNote, setLookupNote] = useState('')
  const moreRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const closeMore = useCallback(() => setMoreOpen(false), [])
  useDismiss(moreOpen, closeMore, moreRef)
  const closeMenu = useCallback(() => setMenu(null), [])

  // A source being removed leaves the list at once; it is taken out of the library when Undo's time is up.
  const docs = useMemo(() => (hiding.size ? allDocs.filter((d) => !hiding.has(d.id)) : allDocs), [allDocs, hiding])

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label)
    try {
      await fn()
      await onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  /** Small changes (a star, read or unread, copying): no progress line, errors still shown. */
  const quietly = (fn: () => Promise<unknown>) => void fn().catch((e) => onError(e instanceof Error ? e.message : String(e)))
  const say = (text: string, undo?: () => void) => setToast((t) => ({ text, undo, n: (t?.n ?? 0) + 1 }))
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), UNDO_MS)
    return () => window.clearTimeout(t)
  }, [toast])

  // Files and folders are read in the background, with each file's progress shown below the header.
  const addFiles = async () => {
    const files = (await window.rc?.pickFiles()) ?? []
    if (files.length) await onAddPaths(files)
  }

  const addDiskFolder = async () => {
    const folder = await window.rc?.pickFolder()
    if (folder) await onAddPaths([folder])
  }

  // One field for both web pages and local paths, so there's nothing to choose between.
  const addLink = (value: string) => {
    if (/^https?:\/\//i.test(value)) run('Fetching page…', () => api.ingestUrl(value))
    else onAddPaths([value])
  }

  /** Ask Muse again for what failed when sources were added (all of them, or `ids`). */
  const retry = (ids?: number[]) =>
    run('Asking Muse again…', async () => {
      const r = await api.fillMissing(ids)
      if (r.still_missing) {
        onError(`Muse still couldn't finish ${r.still_missing} source${r.still_missing === 1 ? '' : 's'}. They stay searchable; try again in a few minutes.`)
      }
    })
  const owed = docs.filter((d) => d.missing.length > 0).length
  const importing = jobs.some((j) => j.finished_at == null) // an import retries what it owes when it ends
  const adding = jobs.filter((j) => j.finished_at == null).reduce((n, j) => n + j.total, 0) // files in running imports

  const pickOnly = (id: number | null) => {
    setOpenRemoved(null)
    setPicked(id === null ? new Set() : new Set([id]))
    setCur(id)
    anchor.current = id
  }

  // Bring a requested paper into view: show everything and select it.
  useEffect(() => {
    if (!focus) return
    setScope('all')
    setOpened('v:all')
    onQuery('')
    setFilters(NO_FILTERS)
    setTimeline(null)
    pickOnly(focus.id)
    const t = window.setTimeout(() => document.getElementById(`lib-doc-${focus.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350)
    return () => window.clearTimeout(t)
  }, [focus?.n]) // eslint-disable-line react-hooks/exhaustive-deps

  // Open a requested topic (picked in the palette).
  useEffect(() => {
    if (focusTopic) openKey(`t:${focusTopic.id}`)
  }, [focusTopic?.n]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // The open topic was deleted or merged: back to the folders.
    if (typeof scope === 'number' && !folders.some((f) => f.id === scope)) {
      setScope('all')
      setOpened(null)
    }
  }, [folders, scope])

  useEffect(() => {
    setFilters((f) => (f.topics.every((id) => folders.some((x) => x.id === id)) ? f : { ...f, topics: f.topics.filter((id) => folders.some((x) => x.id === id)) }))
  }, [folders])

  // Reading happens in the reader's own window: what was highlighted or opened there shows here
  // when this window is in front again. The desktop app says when that is; in a browser the
  // page's own focus event does.
  useEffect(() => {
    let last = 0
    const onFocus = () => {
      if (Date.now() - last < 1000) return // both signals may come for one return
      last = Date.now()
      onChanged().catch(() => {})
    }
    const off = window.rc?.onWindowFocus?.(onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      off?.()
      window.removeEventListener('focus', onFocus)
    }
  }, [onChanged])

  // The removal log changes whenever the library does (removed here, in Duplicate files, restored).
  useEffect(() => {
    api.removed().then(setRemoved).catch(() => {}) // an older backend has none: nothing to show
  }, [allDocs])

  useEffect(() => {
    if (openRemoved !== null && !removed.some((r) => r.id === openRemoved)) setOpenRemoved(null)
    if (scope === 'removed' && removed.length === 0) {
      setScope('all')
      setOpened((o) => (o === 'v:removed' ? 'v:all' : o))
    }
  }, [removed, openRemoved, scope])

  /** Bring a source in the library into view (from a removed one's details). */
  const showDoc = (id: number) => {
    setScope('all')
    setOpened('v:all')
    setTimeline(null)
    pickOnly(id)
    window.setTimeout(() => document.getElementById(`lib-doc-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300)
  }
  /** Go to a paper named in another's details: where it is in the list now, or in the whole library. */
  const goTo = (id: number) => {
    if (!rows.some((d) => d.id === id)) {
      setScope('all')
      setOpened('v:all')
      onQuery('')
      setFilters(NO_FILTERS)
      setTimeline(null)
    }
    pickOnly(id)
    window.setTimeout(() => document.getElementById(`lib-doc-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300)
  }
  /** Mark papers read or unread, starred or not. */
  const mark = (ds: Doc[], marks: { unread?: boolean; starred?: boolean }) =>
    quietly(async () => {
      await api.markDocuments(ds.map((d) => d.id), marks)
      await onChanged()
    })
  /** The paper itself: a PDF in the reader (at `page`), other files in their own app, a web page in the browser. Opening it marks it read. */
  const openFile = (d: Doc, page = 1, find?: string) => {
    if (d.unread) mark([d], { unread: false })
    setRecent((r) => noteRecent(r, { kind: 'doc', id: d.id }))
    if (/^https?:\/\//i.test(d.source)) window.open(d.url || d.source, '_blank', 'noreferrer')
    else if (d.kind === 'pdf') onOpenPdf(d, page, find)
    else if (window.rc?.openFile) window.rc.openFile(d.source).catch((e) => onError(`Could not open “${d.title}”: ${e instanceof Error ? e.message : e}`))
  }
  /** Open a paper from `ds` the reader hasn't read yet, at random, and say which and why. */
  const surpriseFrom = (ds: Doc[], where: string) => {
    const pick = pickSurprise(ds)
    if (!pick) return say(`There's no paper in ${where} to open.`)
    openFile(pick.doc)
    say(surpriseText(pick, where))
  }
  const openGhost = (id: number | null) => {
    setPicked(new Set())
    setCur(null)
    setOpenRemoved(id)
  }

  /** The date slider over every date there is, going by `field`. */
  const openTimeline = (field: TimeField) => {
    const a = buildAxis(field, docs, removed)
    setLookupNote('')
    setTimeline(a ? { field, mode: 'range', lo: a.start, hi: a.end } : { field, mode: 'range', lo: 0, hi: 0 })
  }
  /** Look papers up in OpenAlex and Crossref: those not yet looked up, or (`refresh`) every one. */
  const lookUp = (refresh = false) =>
    run(refresh ? 'Looking every paper up again…' : 'Looking papers up in OpenAlex and Crossref…', async () => {
      setLookupNote('')
      const r = await api.enrich(undefined, refresh)
      setLookupNote(
        `Found ${r.found} of ${plural(r.checked, 'paper')}: ${plural(r.dates, 'exact date')}, ${plural(r.dois, 'missing DOI')}.` +
          (r.mismatched ? ` ${r.mismatched} carr${r.mismatched === 1 ? 'ies' : 'y'} another work's DOI: see ${r.mismatched === 1 ? 'its' : 'their'} details.` : '') +
          (r.failed ? ` Couldn't reach OpenAlex for ${r.failed}; try again later.` : ''),
      )
    })
  const notLookedUp = docs.filter((d) => !d.enriched).length

  const setSort = (s: Sort) => {
    setSortState(s)
    if (s.key !== 'match') save(SORT_KEY, s) // the next visit opens sorted the same way
  }
  useEffect(() => {
    if (sort.key === 'match' && typeof scope !== 'number') setSortState(load<Sort>(SORT_KEY, { key: 'added', dir: -1 }, (v) => !!v))
  }, [scope, sort.key])

  // Search: every word, in any order, anywhere in the paper's record.
  const words = useMemo(() => wordsOf(query), [query])
  const thisYear = new Date().getFullYear()
  const searching = words.length > 0
  const openFolder = typeof scope === 'number' ? folders.find((f) => f.id === scope) : undefined
  const citedSet = useMemo(() => new Set(cited), [cited])
  const recentSince = useMemo(() => new Date(Date.now() - RECENT_DAYS * 864e5).toISOString().slice(0, 19).replace('T', ' '), [allDocs])
  const inView = useCallback(
    (d: Doc, v: Scope): boolean =>
      v === 'all' ? true
        : v === 'recent' ? d.added_at >= recentSince
        : v === 'drafting' ? drafting.has(d.id)
        : v === 'cited' ? citedSet.has(d.id)
        : v === 'needs' ? needsAttention(d)
        : v === 'unread' ? d.unread
        : v === 'starred' ? d.starred
        : v === 'none' ? d.folders.length === 0
        : v === 'missing' ? d.file_missing
        // Papers from before reading marks existed count as opened, so they never show here.
        : v === 'unused' ? d.unread && !d.cited_in_drafts && d.highlights === 0 && !drafting.has(d.id)
        : v === 'removed' ? false
        : d.folders.some((f) => f.id === v),
    [recentSince, drafting, citedSet],
  )
  // The timeline's window, kept inside the dates there are now (sources come and go under it).
  const axis = useMemo(() => (timeline ? buildAxis(timeline.field, docs, removed) : null), [timeline?.field, docs, removed])
  const tl = useMemo<TimeWindow | null>(() => {
    if (!timeline || !axis) return null
    const clamp = (v: number) => Math.max(axis.start, Math.min(axis.end, v))
    return { ...timeline, lo: clamp(timeline.lo), hi: clamp(timeline.hi) }
  }, [timeline, axis])
  const narrowed = !!tl && !!axis && (tl.mode === 'asof' || tl.lo > axis.start || tl.hi < axis.end || tl.field === 'published')
  // What the view, the filters and the timeline leave, before the search narrows it.
  const scoped = useMemo(
    () =>
      docs.filter(
        (d) => matches(filterable(d), filters, thisYear) && inView(d, scope) && (!tl || !axis || ((s) => !!s && inWindow(axis, tl, s))(docSpan(tl.field, d))),
      ),
    [docs, filters, thisYear, scope, inView, tl, axis],
  )
  const rows = useMemo(() => {
    const shown = searching ? scoped.filter((d) => hasWords(d, words)) : [...scoped]
    const fit = (d: Doc) => d.folders.find((f) => f.id === scope)?.score ?? (d.folders.some((f) => f.id === scope) ? 101 : -1)
    const last = '￿' // nothing to sort by: after everything else
    const value = (d: Doc): string | number =>
      sort.key === 'title' ? d.title.toLowerCase()
        : sort.key === 'authors' ? authorsShort(d).toLowerCase() || last
        : sort.key === 'year' ? (d.year ?? 0)
        : sort.key === 'venue' ? d.venue.toLowerCase() || last
        : sort.key === 'citations' ? (d.cited_by_count ?? -1)
        : sort.key === 'folders' ? d.folders.map((f) => f.name).join(', ').toLowerCase() || last
        : sort.key === 'match' ? fit(d)
        : `${d.added_at}${String(d.id).padStart(9, '0')}`
    const byTitle = (a: Doc, b: Doc) => a.title.localeCompare(b.title)
    return shown.sort((a, b) => (value(a) > value(b) ? 1 : value(a) < value(b) ? -1 : byTitle(a, b) * sort.dir) * sort.dir)
  }, [scoped, searching, words, scope, sort])

  // Look inside the papers for the search, a moment after the typing stops.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 3 || opened === null) return setPassages(null) // on the front page the search finds folders
    let stale = false
    const t = window.setTimeout(() => {
      api.findPassages(q).then((hits) => !stale && setPassages({ q, hits })).catch(() => !stale && setPassages(null)) // an older backend can't: titles only
    }, 250)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
  }, [query, allDocs, opened])
  const docById = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs])
  const hits = useMemo(() => {
    if (!passages || passages.q !== query.trim() || scope === 'removed') return null
    const ids = new Set(scoped.map((d) => d.id))
    return passages.hits.filter((h) => ids.has(h.doc_id))
  }, [passages, query, scoped, scope])

  // "As of" a date: what was in the library then and has been removed since, greyed below.
  const ghosts = useMemo(
    () =>
      tl && axis && tl.mode === 'asof' && scope === 'all'
        ? removed.filter(
            (r) =>
              removedSince(axis, tl, r) &&
              matches({ kind: r.kind, authors: r.authors, year: r.year, venue: r.venue }, filters, thisYear) &&
              (!searching || ((h) => words.every((w) => h.includes(w)))(`${r.title} ${r.authors.join(' ')} ${r.venue}`.toLowerCase())),
          )
        : [],
    [tl, axis, scope, removed, filters, thisYear, searching, words],
  )

  // ---------- the selection, and what can be done with it ----------

  // Only rows in view count as selected: a search or another view never acts on what it doesn't show.
  const chosen = useMemo(() => rows.filter((d) => picked.has(d.id)), [rows, picked])
  const sel = useMemo(() => new Set(chosen.map((d) => d.id)), [chosen])
  const current = chosen.length === 1 ? chosen[0] : undefined
  const currentRemoved = openRemoved !== null ? removed.find((r) => r.id === openRemoved) : undefined
  const showingRemoved = scope === 'removed'
  const docIds = useMemo(() => new Set(docs.map((d) => d.id)), [docs])

  const select = (id: number, how: { toggle?: boolean; range?: boolean }) => {
    const ids = rows.map((d) => d.id)
    const from = anchor.current
    setOpenRemoved(null)
    if (how.range && from !== null && ids.includes(from)) {
      const [a, b] = [ids.indexOf(from), ids.indexOf(id)].sort((x, y) => x - y)
      setPicked(new Set([...(how.toggle ? sel : []), ...ids.slice(a, b + 1)]))
    } else if (how.toggle) {
      const next = new Set(sel)
      if (!next.delete(id)) next.add(id)
      setPicked(next)
      anchor.current = id
    } else {
      setPicked(new Set([id]))
      anchor.current = id
    }
    setCur(id)
  }
  const clearSelection = () => pickOnly(null)
  /** Move to the paper above or below (Shift selects through to it). */
  const step = (dir: number, range = false) => {
    const i = rows.findIndex((d) => d.id === cur)
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + dir))]
    if (!next) return
    select(next.id, { range })
    document.getElementById(`lib-doc-${next.id}`)?.scrollIntoView({ block: 'nearest' })
  }
  // Quick look shows the one selected paper: with none or several selected it closes.
  useEffect(() => {
    if (peek && !current) setPeek(false)
  }, [peek, current])
  const closePeek = () => {
    setPeek(false)
    requestAnimationFrame(() => listEl()?.focus({ preventScroll: true }))
  }
  /** What holds the keyboard inside an open folder: the rows, or the covers. */
  const listEl = () => (paperLayout === 'covers' ? coversRef.current : tableRef.current) ?? sectionRef.current
  const canOpen = (d: Doc) => /^https?:\/\//i.test(d.source) || d.kind === 'pdf' || !!window.rc?.openFile

  // ---------- saved views: a search and filters kept in the sidebar ----------

  const setViews = (next: SavedView[]) => {
    setViewsState(next)
    save(VIEWS_KEY, next)
  }
  /** The saved view on screen now: the same view or topic, search and filters. */
  const activeView = useMemo(
    () => views.find((v) => v.scope === scope && v.query.trim() === query.trim() && sameFilters(v.filters, filters)),
    [views, scope, query, filters],
  )
  /** Show a saved view's search and filters in the view or topic it was saved in. False if that topic is gone. */
  const openView = (v: SavedView): boolean => {
    if (typeof v.scope === 'number' && !folders.some((f) => f.id === v.scope)) {
      say(`“${v.name}” was saved inside a topic that is gone. Delete the view, or save it again.`)
      return false
    }
    setScope(v.scope as Scope)
    onQuery(v.query)
    setFilters(v.filters)
    setTimeline(null)
    setNaming(null)
    setPicked(new Set())
    setCur(null)
    setOpenRemoved(null)
    return true
  }
  // Library clicked in the sidebar: out of any folder or view, to the folders (the one left stays selected).
  useEffect(() => {
    if (toFront) {
      closePeek()
      setPeekKey(null)
      setFolderMenu(null)
      goBack()
    }
  }, [toFront]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (surprise) surpriseFrom(allDocs, 'your library')
  }, [surprise]) // eslint-disable-line react-hooks/exhaustive-deps
  const saveView = (name: string) => {
    const same = views.find((v) => v.name.toLowerCase() === name.toLowerCase())
    const view: SavedView = { id: same?.id ?? Date.now().toString(36), name, scope, query: query.trim(), filters }
    setViews(same ? views.map((v) => (v === same ? view : v)) : [...views, view])
    setNaming(null)
    setOpened(`s:${view.id}`) // the trail now names the view
    setSelKey(`s:${view.id}`)
    say(same ? `Updated the view “${name}”.` : `Saved “${name}” as a smart folder on the Library's front page. It stays current as papers arrive.`)
  }
  const renameView = (id: string, name: string) => {
    setViews(views.map((v) => (v.id === id ? { ...v, name } : v)))
    setNaming(null)
  }
  const deleteView = (v: SavedView) => {
    const before = views
    const wasOpen = activeView?.id === v.id
    setViews(views.filter((x) => x.id !== v.id))
    setNaming(null)
    // Deleting the view on screen leaves it, as clicking another view does: its search and filters
    // go with it, so the list isn't left narrowed by a view that no longer exists.
    const inside = opened === `s:${v.id}`
    if (wasOpen) {
      setFilters(NO_FILTERS)
      onQuery('')
    }
    if (inside) setOpened(keyOf(scope)) // still in the view or topic it was saved in
    if (selKey === `s:${v.id}`) setSelKey(null)
    say(`Deleted the view “${v.name}”. Your papers aren't touched.`, () => {
      setViews(before)
      if (wasOpen && openView(v)) setOpened(`s:${v.id}`)
    })
  }
  const selectAll = () => setPicked(rows.length > 0 && rows.every((d) => sel.has(d.id)) ? new Set() : new Set(rows.map((d) => d.id)))

  const allDrafting = chosen.length > 0 && chosen.every((d) => drafting.has(d.id))
  /** Use the selected papers for drafting, or stop when they all are already. */
  const toggleDrafting = (ds: Doc[]) => {
    const off = ds.every((d) => drafting.has(d.id))
    const change = ds.filter((d) => drafting.has(d.id) === off)
    for (const d of change) onToggle(d.id)
    const left = drafting.size + (off ? -change.length : change.length)
    say(off ? (left ? `Muse no longer drafts from ${named(ds)}.` : 'Muse drafts from your whole library again.') : `Muse now drafts only from the ${plural(left, 'paper')} under “Drafting from”.`)
  }
  const useWholeLibrary = () => {
    for (const id of drafting) onToggle(id)
    if (scope === 'drafting') {
      setScope('all')
      setOpened((o) => (o === 'v:drafting' ? 'v:all' : o))
    }
  }

  /** Take the removals whose Undo ran out (or was overtaken) out of the library. */
  const commitRemoval = async () => {
    const p = pending.current
    if (!p) return
    pending.current = null
    window.clearTimeout(p.timer)
    setBusy('Removing…')
    try {
      for (const id of p.ids) await api.deleteDocument(id)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      forgetRemoving(p.ids)
      await onChanged().catch(() => {})
      setBusy(null)
      setHiding((h) => new Set([...h].filter((id) => !p.ids.includes(id))))
    }
  }
  const commitRef = useRef(commitRemoval)
  commitRef.current = commitRemoval
  // The app was closed while a removal's Undo was still open: finish that removal now. Once, when
  // the library first loads (the backend is up by then).
  const loaded = allDocs.length > 0
  const resumed = useRef(false)
  useEffect(() => {
    if (!loaded || resumed.current) return
    resumed.current = true
    if (pending.current) return
    const ids = removing().filter((id) => allDocs.some((d) => d.id === id))
    if (!ids.length) return save(REMOVING_KEY, [])
    setHiding((h) => new Set([...h, ...ids]))
    pending.current = { ids, timer: 0 }
    void commitRef.current()
  }, [loaded]) // eslint-disable-line react-hooks/exhaustive-deps
  /** Remove sources: they leave the list now, and the library when the Undo message closes. */
  const remove = (ds: Doc[]) => {
    if (!ds.length) return
    void commitRemoval() // an earlier removal still waiting goes through now
    const ids = ds.map((d) => d.id)
    setHiding((h) => new Set([...h, ...ids]))
    setPicked(new Set())
    setCur(null)
    pending.current = { ids, timer: window.setTimeout(() => void commitRef.current(), UNDO_MS) }
    save(REMOVING_KEY, [...removing(), ...ids]) // if the app closes before then, the next start finishes it
    say(`Removed ${named(ds)}. ${ds.length === 1 ? 'Its file stays where it is' : 'Their files stay where they are'}, and Removed keeps a record.`, () => {
      const p = pending.current
      if (!p || p.ids !== ids) return // already out of the library: restore it from Removed
      window.clearTimeout(p.timer)
      pending.current = null
      forgetRemoving(ids)
      setHiding((h) => new Set([...h].filter((id) => !ids.includes(id))))
    })
  }

  const fileInto = (ds: Doc[], folder: Folder) => {
    const add = ds.filter((d) => !d.folders.some((f) => f.id === folder.id))
    if (!add.length) return say(`${ds.length === 1 ? 'It is' : 'They are'} already in ${folder.name}.`)
    // Filing adds a topic and takes none away: say so, since dragging elsewhere usually moves things.
    const from = openFolder && openFolder.id !== folder.id ? openFolder.name : ''
    const stay = from ? ` ${add.length === 1 ? 'It stays' : 'They stay'} in ${from} too.` : ''
    run('Filing…', async () => {
      for (const d of add) await api.setFolderMember(d.id, folder.id, true)
    }).then(() => say(`Added ${add.length === 1 ? named(add) : plural(add.length, 'paper')} to ${folder.name}.${stay}`))
  }
  const copyCitations = (ds: Doc[], style: RefStyle) =>
    quietly(async () => {
      const { entries } = await api.references(ds.map((d) => d.id), style)
      await navigator.clipboard.writeText(entries.join(style === 'bibtex' ? '\n\n' : '\n'))
      say(`Copied ${plural(entries.length, 'citation')} as ${STYLE_NAME[style]}.`)
    })
  const exportBibtex = (ds: Doc[]) =>
    quietly(async () => {
      const { entries } = await api.references(ds.map((d) => d.id), 'bibtex')
      const data = new TextEncoder().encode(entries.join('\n\n'))
      if (window.rc?.saveFile) {
        if (!(await window.rc.saveFile('library.bib', data.buffer as ArrayBuffer))) return
      } else {
        const url = URL.createObjectURL(new Blob([data], { type: 'text/plain;charset=utf-8' }))
        const a = document.createElement('a')
        a.href = url
        a.download = 'library.bib'
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 5000)
      }
      say(`Exported ${plural(entries.length, 'entry').replace('entrys', 'entries')} as BibTeX.`)
    })

  // ↑ ↓ move between papers (Shift selects through), Enter opens, Space peeks, Delete removes, Ctrl+A selects all, Esc clears.
  const onTableKey = (e: React.KeyboardEvent) => {
    const onRow = e.target === e.currentTarget // not on a header button, checkbox or star inside the table
    if (e.key === 'Escape') return clearSelection()
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      return setPicked(new Set(rows.map((d) => d.id)))
    }
    if (e.key === 'Enter' && onRow && current) return openFile(current)
    if (e.key === ' ' && onRow) {
      e.preventDefault() // Space would scroll the list
      if (current) setPeek(true)
      return
    }
    if (e.key === 'Delete' && chosen.length) return remove(chosen)
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    step(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
  }

  const under = (el: HTMLElement) => ((r) => ({ x: r.left, y: r.bottom + 4 }))(el.getBoundingClientRect())
  const menuItems = (): MenuItem[] => {
    if (!menu) return []
    if (menu.kind === 'columns') {
      return [
        { head: 'Columns' },
        ...COLUMNS.map((c) => ({
          label: c.label, checked: cols.includes(c.key), keepOpen: true,
          run: () => {
            const next = COLUMNS.map((x) => x.key).filter((k) => (k === c.key ? !cols.includes(k) : cols.includes(k)))
            setCols(next)
            save(COLS_KEY, next)
          },
        })),
      ]
    }
    const pick = <T,>(choices: { value: T; label: string; count: number }[], on: T[], set: (next: T[]) => Partial<Filters>): MenuItem[] =>
      choices.map((c) => ({
        label: c.label, count: c.count, checked: on.includes(c.value), keepOpen: true,
        run: () => setFilters((f) => ({ ...f, ...set(toggled(on, c.value)) })),
      }))
    if (menu.kind === 'f-kind') {
      return pick(kinds.map((k) => ({ value: k.id, label: k.label, count: docs.filter((d) => d.kind === k.id).length })), filters.kinds, (kinds) => ({ kinds }))
    }
    if (menu.kind === 'f-year') {
      return years.map((y) => ({
        label: y.label, count: y.count, checked: sameYear(filters.year, y.value),
        run: () => setFilters((f) => ({ ...f, year: sameYear(f.year, y.value) ? null : y.value })),
      }))
    }
    if (menu.kind === 'f-topic') {
      return pick(bySize.map((t) => ({ value: t.id, label: t.name, count: t.doc_count })), filters.topics, (topics) => ({ topics }))
    }
    if (menu.kind === 'f-author') {
      return [{ head: 'Most papers first' }, ...pick(authors.slice(0, MAX_CHOICES), filters.authors, (authors) => ({ authors }))]
    }
    if (menu.kind === 'f-venue') {
      return [{ head: 'Most papers first' }, ...pick(venues.slice(0, MAX_CHOICES), filters.venues, (venues) => ({ venues }))]
    }
    if (menu.kind === 'merge') {
      const from = folders.find((f) => f.id === menu.folderId)
      if (!from) return []
      const others = bySize.filter((f) => f.id !== from.id)
      return [
        { head: `Merge “${from.name}” into` },
        ...others.map((into) => ({
          label: into.name,
          count: into.doc_count,
          run: () =>
            run('Merging topics…', () => api.mergeFolders(from.id, into.id)).then(() => {
              setSelKey(`t:${into.id}`)
              say(`Merged ${from.name} into ${into.name}. Its papers are in ${into.name} now.`)
            }),
        })),
        ...(others.length ? [] : [{ label: 'No other topic yet', disabled: true, run: () => {} }]),
      ]
    }
    if (menu.kind === 'topic') {
      return [
        { head: `Add ${named(chosen)} to` },
        ...folders.map((f) => ({ label: f.name, checked: chosen.every((d) => d.folders.some((x) => x.id === f.id)), run: () => fileInto(chosen, f) })),
        ...(folders.length ? (['sep'] as const) : []),
        { label: 'New topic…', run: () => setCreating(true) },
      ]
    }
    if (menu.kind === 'cite') {
      return [
        ...(['apa', 'mla', 'ieee', 'bibtex'] as const).map((s) => ({ label: `Copy as ${STYLE_NAME[s]}`, run: () => copyCitations(chosen, s) })),
        'sep',
        { label: 'Export as a .bib file…', run: () => exportBibtex(chosen) },
      ]
    }
    const one = current
    const at = { x: menu.x, y: menu.y }
    return [
      ...(one ? [{ label: 'Open', kbd: 'Enter', run: () => openFile(one) }, { label: 'Quick look', kbd: 'Space', run: () => setPeek(true) }] : []),
      { label: 'Add to topic…', run: () => setMenu({ kind: 'topic', ...at }) },
      { label: allDrafting ? 'Stop drafting from' : 'Use for drafting', run: () => toggleDrafting(chosen) },
      { label: 'Copy citation…', run: () => setMenu({ kind: 'cite', ...at }) },
      'sep',
      chosen.some((d) => d.unread) ? { label: 'Mark as read', run: () => mark(chosen, { unread: false }) } : { label: 'Mark as unread', run: () => mark(chosen, { unread: true }) },
      chosen.every((d) => d.starred) ? { label: 'Remove star', run: () => mark(chosen, { starred: false }) } : { label: 'Star', run: () => mark(chosen, { starred: true }) },
      ...(one
        ? ([
            'sep',
            { label: 'Edit details…', run: () => setEditFor(one.id) },
            ...(!/^https?:\/\//i.test(one.source) && window.rc?.showFile ? [{ label: 'Show in folder on disk', run: () => void window.rc!.showFile!(one.source).catch(() => {}) }] : []),
            { label: 'Cited papers…', run: () => onCitedPapers(one.id) },
            { label: 'Citing papers…', run: () => onCitingPapers(one.id) },
          ] as MenuItem[])
        : []),
      'sep',
      { label: 'Remove from library', kbd: 'Del', danger: true, run: () => remove(chosen) },
    ]
  }

  // ---------- the sidebar ----------

  const kinds = FILTERS.filter((f) => docs.some((d) => d.kind === f.id))
  const filtering = filtersActive(filters) || searching || narrowed
  const authors = useMemo(() => authorChoices(docs), [docs])
  const venues = useMemo(() => venueChoices(docs), [docs])
  const years = useMemo(() => yearChoices(docs, thisYear), [docs, thisYear])
  const anyHighlights = docs.some((d) => d.highlights > 0)
  const labels = <T,>(choices: { value: T; label: string }[], on: T[]) => on.map((v) => choices.find((c) => c.value === v)?.label ?? String(v))
  /** The choices ticked in each chip, by name. */
  const ticked = {
    kind: labels(FILTERS.map((f) => ({ value: f.id, label: f.label })), filters.kinds),
    year: filters.year ? [yearLabel(filters.year)] : [],
    topic: labels(folders.map((f) => ({ value: f.id, label: f.name })), filters.topics),
    author: labels(authors, filters.authors),
    venue: labels(venues, filters.venues),
  }
  /** What each chip shows it is set to ('' when it isn't). */
  const chip = { kind: firstAnd(ticked.kind), year: firstAnd(ticked.year), topic: firstAnd(ticked.topic), author: firstAnd(ticked.author), venue: firstAnd(ticked.venue) }
  /** A click on a chip opens its menu, or closes it when it's the one open. */
  const chipMenu = (kind: MenuKind) => (el: HTMLElement) => {
    const c = menuClosed.current
    if (c && c.kind === kind && performance.now() - c.at < 300) return
    setMenu({ kind, ...under(el) })
  }
  /** "Unread · mobile money · PDFs · Last 5 years": a name to start from. */
  const suggestedName = () =>
    [
      typeof scope === 'number' ? openFolder?.name : scope !== 'all' ? VIEW_NAME[scope] : '',
      searching ? query.trim() : '',
      ...[ticked.kind, ticked.year, ticked.topic, ticked.author, ticked.venue].map((t) => t.join(', ')),
      filters.highlighted ? 'Highlighted' : '',
    ].filter(Boolean).join(' · ').slice(0, 60)
  const alike = useMemo(() => alikeTopics(docs, folders, keptBoth), [docs, folders, keptBoth])
  const bySize = useMemo(() => [...folders].sort((a, b) => b.doc_count - a.doc_count || a.name.localeCompare(b.name)), [folders])

  // ---------- the front page: topics as folders, smart folders above them ----------

  const byAdded = useMemo(() => [...docs].sort((a, b) => b.added_at.localeCompare(a.added_at) || b.id - a.id), [docs])
  const members = useMemo(() => {
    const m = new Map<number, Doc[]>()
    for (const d of byAdded) for (const f of d.folders) (m.get(f.id) ?? m.set(f.id, []).get(f.id)!).push(d)
    return m
  }, [byAdded])
  const topicItems = useMemo<FrontItem[]>(
    () =>
      bySize.map((f) => {
        const ds = members.get(f.id) ?? []
        return { key: `t:${f.id}`, kind: 'topic' as const, name: f.name, docs: ds, count: ds.length, folder: f }
      }),
    [bySize, members],
  )
  const smartItems = useMemo<FrontItem[]>(() => {
    const out: FrontItem[] = []
    for (const v of SMART_VIEWS) {
      const ds = v === 'removed' ? [] : byAdded.filter((d) => inView(d, v))
      const n = v === 'removed' ? removed.length : ds.length
      if (n === 0 && v !== 'all' && v !== 'drafting') continue
      out.push({
        key: `v:${v}`, kind: 'smart', name: VIEW_NAME[v], rule: VIEW_RULE[v], docs: ds, count: n, view: v,
        countText: v === 'drafting' && n === 0 ? 'Whole library' : v === 'removed' ? plural(n, 'removed source') : undefined,
      })
    }
    for (const sv of views) {
      const vw = wordsOf(sv.query)
      const ds = byAdded.filter((d) => inView(d, sv.scope as Scope) && matches(filterable(d), sv.filters, thisYear) && hasWords(d, vw))
      const within = typeof sv.scope === 'number' ? folders.find((f) => f.id === sv.scope)?.name : sv.scope !== 'all' ? VIEW_NAME[sv.scope as View] : ''
      const rule = ['A saved view', sv.query && `“${sv.query}”`, filtersActive(sv.filters) && 'with filters', within && `in ${within}`].filter(Boolean).join(', ')
      out.push({ key: `s:${sv.id}`, kind: 'smart', name: sv.name, rule, docs: ds, count: ds.length, saved: sv })
    }
    return out
  }, [byAdded, inView, removed.length, views, thisYear, folders])
  const itemByKey = useMemo(() => new Map([...smartItems, ...topicItems].map((i) => [i.key, i])), [smartItems, topicItems])
  const citedBy = useMemo(() => new Map([...itemByKey].map(([k, i]) => [k, i.docs.reduce((n, d) => n + (citedSet.has(d.id) ? 1 : 0), 0)])), [itemByKey, citedSet])
  // On the front page the search finds folders: by name, or by the titles of the papers in a topic.
  const frontHit = (text: string) => words.every((w) => text.toLowerCase().includes(w))
  const shownTopics = useMemo(() => {
    const list = searching ? topicItems.filter((t) => frontHit(t.name) || t.docs.some((d) => frontHit(d.title))) : topicItems
    return frontSort === 'name' ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : list
  }, [topicItems, searching, words, frontSort]) // eslint-disable-line react-hooks/exhaustive-deps
  const shownSmart = useMemo(() => (searching ? smartItems.filter((i) => frontHit(i.name)) : smartItems), [smartItems, searching, words]) // eslint-disable-line react-hooks/exhaustive-deps
  const recentShown = useMemo<RecentShown[]>(
    () =>
      recent
        .map((r): RecentShown | null => {
          if (r.kind === 'doc') {
            const d = docById.get(r.id)
            return d ? { kind: 'doc', doc: d } : null
          }
          const item = itemByKey.get(r.key)
          return item ? { kind: 'folder', item } : null
        })
        .filter((r): r is RecentShown => r !== null) // gone since: deleted, merged, removed
        .slice(0, RECENT_SHOWN),
    [recent, docById, itemByKey],
  )
  const openedItem = opened ? itemByKey.get(opened) : undefined
  const openedName = openedItem?.name ?? (opened?.startsWith('s:') ? activeView?.name ?? 'Saved view' : typeof scope === 'number' ? openFolder?.name ?? '' : VIEW_NAME[scope])
  const atFront = opened === null && docs.length > 0

  /** Open a folder: a topic, a ready-made view or a saved view. */
  const openKey = (key: string) => {
    if (key.startsWith('s:')) {
      const v = views.find((x) => `s:${x.id}` === key)
      if (!v || !openView(v)) return
    } else {
      const to: Scope = key.startsWith('t:') ? Number(key.slice(2)) : (key.slice(2) as View)
      if (typeof to === 'number' && !folders.some((f) => f.id === to)) return
      onQuery('') // the search was for folders; inside, it searches this one
      setFilters(NO_FILTERS)
      setTimeline(null)
      setScope(to)
      setNaming(null)
      pickOnly(null)
    }
    setOpened(key)
    setSelKey(key)
    setPeekKey(null)
    setFolderMenu(null)
    setRenaming(null)
    setRecent((r) => noteRecent(r, { kind: 'folder', key }))
    requestAnimationFrame(() => listEl()?.focus({ preventScroll: true }))
  }
  /** Back to the folders, with the one just left selected. */
  const goBack = () => {
    if (opened === null) return
    const from = opened
    onQuery('')
    setFilters(NO_FILTERS)
    setTimeline(null)
    setNaming(null)
    setPeek(false)
    pickOnly(null)
    setOpened(null)
    setSelKey(from)
    requestAnimationFrame(() => {
      const el = frontRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(from)}"]`)
      ;(el ?? frontRef.current)?.focus({ preventScroll: true })
      el?.scrollIntoView({ block: 'center' })
    })
  }
  useEffect(() => {
    onSearchHint?.(atFront ? 'Search topics, and the titles of the papers in them…' : opened ? `Search in ${openedName}…` : 'Search titles, authors, and inside papers…')
  }, [atFront, opened, openedName, onSearchHint])
  useEffect(() => {
    onFront?.(atFront)
  }, [atFront, onFront])
  useEffect(() => () => onFront?.(false), [onFront])
  // A folder selected on the front page that is gone now (deleted, merged, emptied) is let go.
  useEffect(() => {
    if (selKey && !itemByKey.has(selKey) && docs.length) setSelKey(null)
  }, [selKey, itemByKey, docs.length])

  const setFrontLayout = (l: FrontLayout) => (setFrontLayoutState(l), save(FRONT_LAYOUT_KEY, l))
  const setFrontSort = (s: FrontSort) => (setFrontSortState(s), save(FRONT_SORT_KEY, s))
  const setPaperLayout = (l: PaperLayout) => (setPaperLayoutState(l), save(PAPER_LAYOUT_KEY, l))
  const setSize = (n: number) => (setSizeState(n), save(SIZE_KEY, n))
  const setSummaryOpen = (o: boolean) => (setSummaryOpenState(o), save(SUMMARY_KEY, o))

  /** Give the keyboard back to a folder on the front page (after a menu, a rename, the peek). */
  const focusTile = (key: string | null) =>
    requestAnimationFrame(() => {
      // A dialog the menu just opened (Peek inside) keeps the keyboard.
      if ((document.activeElement as HTMLElement | null)?.closest('[role="dialog"]')) return
      const at = key ? `[data-key="${CSS.escape(key)}"]` : ''
      const el = (at && (frontRef.current?.querySelector<HTMLElement>(at) ?? document.querySelector<HTMLElement>(`.lib-side ${at}`))) || frontRef.current || listEl()
      el?.focus({ preventScroll: true })
    })
  /** A name edited in place on the front page: a topic's, or a saved view's. Null: left as it was. */
  const renamed = (key: string, name: string | null) => {
    setRenaming(null)
    focusTile(key)
    if (!name) return
    if (key.startsWith('t:')) run('Renaming…', () => api.updateFolder(Number(key.slice(2)), { name }))
    else if (key.startsWith('s:')) renameView(key.slice(2), name)
  }
  const renamedRef = useRef(renamed)
  renamedRef.current = renamed
  const onRenamed = useCallback((key: string, name: string | null) => renamedRef.current(key, name), []) // steady, so tiles don't all re-draw
  const setColor = (f: Folder, color: FolderColor | '') =>
    quietly(async () => {
      await api.updateFolder(f.id, { color })
      await onChanged()
    })
  /** Space's peek and the arrows inside it: the folder before or after, in the order they show. */
  const peekStep = (dir: 1 | -1) => {
    const order = [...shownSmart, ...shownTopics]
    const at = order.findIndex((i) => i.key === peekKey)
    const next = order[Math.max(0, Math.min(order.length - 1, at + dir))]
    if (!next) return
    setPeekKey(next.key)
    setSelKey(next.key)
    frontRef.current?.querySelector(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  const closeFolderPeek = () => {
    setPeekKey(null)
    focusTile(peekKey)
  }
  // Up and down in the covers go a row at a time; the rest of the keys work as in the rows.
  const onCoversKey = (e: React.KeyboardEvent) => {
    const by = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -coversPerRow(coversRef.current), ArrowDown: coversPerRow(coversRef.current) }[e.key as string]
    if (by !== undefined && e.target === e.currentTarget) {
      e.preventDefault()
      return step(by, e.shiftKey)
    }
    onTableKey(e)
  }
  // While papers are dragged the shelf of topics shows; it goes when the drag ends, wherever it ends.
  useEffect(() => {
    if (dragging === null) return
    const done = () => setDragging(null)
    window.addEventListener('dragend', done)
    window.addEventListener('drop', done)
    return () => {
      window.removeEventListener('dragend', done)
      window.removeEventListener('drop', done)
    }
  }, [dragging])
  const dropOnTopic = (item: FrontItem, ids: number[]) => {
    setDragging(null)
    const ds = docs.filter((d) => ids.includes(d.id))
    if (item.folder && ds.length) fileInto(ds, item.folder)
  }

  const emptyText: Partial<Record<View, string>> = {
    recent: `Nothing was added in the last ${RECENT_DAYS} days.`,
    drafting: 'Muse drafts from your whole library. To narrow it, select papers and choose Use for drafting.',
    cited: "Your draft doesn't cite anything yet.",
    needs: 'Nothing needs attention.',
    unread: 'Nothing is unread.',
    starred: 'Nothing is starred. Click the star beside a title to keep a paper here.',
    none: 'Every paper is in a topic.',
  }
  const paneOpen = !!current || chosen.length > 1 || !!currentRemoved
  const passageHits = <PassageHits hits={hits} hitQuery={query.trim()} docById={docById} onOpenHit={(d, h) => openFile(d, h.page, matchedWords(h.snippet))} />
  const peekItem = peekKey ? itemByKey.get(peekKey) : undefined
  const menuItem = folderMenu ? itemByKey.get(folderMenu.key) : undefined

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className={`panel library${paneOpen && !atFront ? ' has-pane' : ''}${atFront ? ' at-front' : ''}${atFront && summaryOpen ? ' has-summary' : ''}`}
      aria-label="Library"
      onKeyDown={(e) => {
        // Backspace or Alt+Left inside a folder: back to the folders, as in a file explorer.
        if (opened === null || peek || menu || e.defaultPrevented) return
        if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
        if ((e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) || (e.altKey && e.key === 'ArrowLeft')) {
          e.preventDefault()
          goBack()
        }
      }}
      onDragStart={(e) => {
        // A paper row or cover being dragged (not text, not a file from outside): show the shelf of topics.
        const ids = draggedIds(e)
        if (!ids.length || !(e.target as HTMLElement).closest?.('[id^="lib-doc-"]')) return
        window.setTimeout(() => setDragging(ids.length), 0) // changing the page inside dragstart can cancel the drag
      }}
      onDragEnd={() => setDragging(null)}
    >
      {sideSlot &&
        docs.length > 0 &&
        createPortal(
          <SmartViews
            items={smartItems}
            total={docs.length}
            active={opened ?? (atFront ? 'v:all' : null)}
            renaming={renaming}
            onOpen={openKey}
            onMenu={(key, x, y) => setFolderMenu({ key, x, y })}
            onRenamed={onRenamed}
          />,
          sideSlot,
        )}
      <header className="lib-head">
        {opened === null ? (
          <div className="lib-title">
            <h2>Library</h2>
            <span className="muted">
              {docs.length} source{docs.length === 1 ? '' : 's'}
              {folders.length > 0 && ` · ${plural(folders.length, 'topic')}`}
            </span>
          </div>
        ) : (
          <div className="lib-trail">
            <button className="lib-up" onClick={goBack} title="Back to the folders (Backspace)" aria-label="Back to the folders">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <nav className="lib-crumbs" aria-label="Where you are">
              <button className="lib-crumb" onClick={goBack}>Library</button>
              <span className="lib-crumb-sep" aria-hidden="true">›</span>
              <h2 className="lib-crumb-here" title={openedName}>{openedName}</h2>
            </nav>
            <span className="muted lib-trail-count">
              {openedItem ? (openedItem.countText ?? plural(openedItem.count, openedItem.view === 'removed' ? 'removed source' : 'paper')) : ''}
              {(citedBy.get(opened) ?? 0) > 0 && openedItem?.view !== 'cited' && ` · ${citedBy.get(opened)} cited in this draft`}
            </span>
          </div>
        )}
        {busy && (
          <div className="lib-busy" role="status">
            <span className="bar" />
            {busy}
          </div>
        )}
        <span className="spacer" />
        {atFront && (
          <FrontTools layout={frontLayout} size={size} sort={frontSort} onLayout={setFrontLayout} onSize={setSize} onSort={setFrontSort} />
        )}
        {opened !== null && !showingRemoved && docs.length > 0 && (
          <>
            {paperLayout === 'covers' && <SizeSlider size={size} onSize={setSize} />}
            <div className="seg" role="group" aria-label="Show the papers as">
              <button aria-pressed={paperLayout === 'rows'} onClick={() => setPaperLayout('rows')}>Rows</button>
              <button aria-pressed={paperLayout === 'covers'} onClick={() => setPaperLayout('covers')} title="Each paper's first page">Covers</button>
            </div>
          </>
        )}
        <AddSources
          disabled={!!busy}
          onFiles={addFiles}
          onFolder={addDiskFolder}
          onLink={addLink}
          onAdded={async (id) => {
            await onChanged()
            showDoc(id)
          }}
          onShow={showDoc}
        />
        {atFront && (
          <button
            className={`ghost lib-icon-btn lib-sum-toggle${summaryOpen ? ' on' : ''}`}
            onClick={() => setSummaryOpen(!summaryOpen)}
            aria-pressed={summaryOpen}
            aria-label={summaryOpen ? 'Hide the folder panel' : 'Show the folder panel'}
            title={summaryOpen ? 'Hide the panel that sums up the selected folder' : 'Show the panel that sums up the selected folder'}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 5h16v14H4zM14 5v14" />
            </svg>
          </button>
        )}
        {docs.length > 0 && (
          <div className="lib-more" ref={moreRef}>
            <button className="ghost lib-icon-btn" aria-haspopup="menu" aria-expanded={moreOpen} aria-label="More library actions" title="More" onClick={() => setMoreOpen((o) => !o)}>
              ⋯
            </button>
            {moreOpen && (
              <div className="lib-menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false)
                    onFindDuplicates()
                  }}
                  disabled={docs.length < 2}
                >
                  <b>Find duplicate files</b>
                  <span>Copies of the same paper, with what you could free up</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false)
                    onFindMissing()
                  }}
                >
                  <b>Most-cited papers you don't have</b>
                  <span>What your papers on a subject cite most, with free copies to download</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false)
                    run('Re-filing papers…', api.classifyFolders)
                  }}
                  disabled={!!busy || folders.length === 0}
                >
                  <b>Re-file papers into topics</b>
                  <span>{folders.length ? 'Score every paper against your topics again. Your own changes are kept.' : 'Make a topic first'}</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false)
                    lookUp(notLookedUp === 0)
                  }}
                  disabled={!!busy}
                >
                  <b>{notLookedUp ? `Look up ${notLookedUp} paper${notLookedUp === 1 ? '' : 's'} in scholarly indexes` : 'Refresh details from scholarly indexes'}</b>
                  <span>Journal, volume, issue and pages, abstracts, reference lists and citation counts from OpenAlex and Crossref</span>
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {(jobs.length > 0 || (owed > 0 && !importing)) && (
        <div className="lb-jobs">
          {jobs.map((j) => (
            <ImportProgress key={j.id} job={j} onCancel={() => onCancelJob(j.id)} onDismiss={() => onDismissJob(j.id)} />
          ))}
          {owed > 0 && !importing && (
            <div className="lb-owed">
              <span>
                {owed} source{owed === 1 ? ' has' : 's have'} no {owedText(docs.flatMap((d) => d.missing))} yet: Muse was unavailable when{' '}
                {owed === 1 ? 'it was' : 'they were'} added.
              </span>
              <button className="link" onClick={() => retry()} disabled={!!busy}>
                Try again
              </button>
            </div>
          )}
        </div>
      )}

      <datalist id="folder-names">
        {folders.map((f) => (
          <option key={f.id} value={f.name} />
        ))}
      </datalist>

      <div className="lib-body">
        {atFront && (
          <div className="lib-front">
            <LibraryFront
              topics={shownTopics}
              totalTopics={topicItems.length}
              recent={recentShown}
              query={query}
              selected={selKey}
              cited={citedBy}
              layout={frontLayout}
              size={size}
              renaming={renaming}
              scrollRef={frontRef}
              onSelect={setSelKey}
              onOpen={openKey}
              onPeek={setPeekKey}
              onMenu={(key, x, y) => setFolderMenu({ key, x, y })}
              onRenamed={onRenamed}
              onNewTopic={() => setCreating(true)}
              onOpenDoc={(d) => (canOpen(d) ? openFile(d) : showDoc(d.id))}
              onSearchAll={() => {
                // Every paper with these words, and the passages inside them: All sources keeps the search.
                setScope('all')
                setFilters(NO_FILTERS)
                setTimeline(null)
                pickOnly(null)
                setOpened('v:all')
              }}
              notice={
                alike && (
                  <div className="lib-alike lf-notice" role="note">
                    <span>
                      <b>{alike.from.name}</b> and <b>{alike.into.name}</b>{' '}
                      {alike.shared === alike.total ? `hold the same ${alike.total} papers.` : `share ${alike.shared} of their ${alike.total} papers.`}
                    </span>
                    <span className="lib-alike-actions">
                      <button
                        className="link"
                        disabled={!!busy}
                        onClick={() => run('Merging topics…', () => api.mergeFolders(alike.from.id, alike.into.id)).then(() => say(`Merged ${alike.from.name} into ${alike.into.name}.`))}
                      >
                        Merge into {alike.into.name}
                      </button>
                      <button
                        className="link"
                        onClick={() => {
                          const next = [...keptBoth, alike.key]
                          setKeptBoth(next)
                          save(KEPT_KEY, next)
                        }}
                      >
                        Keep both
                      </button>
                    </span>
                  </div>
                )
              }
            >
              {creating && (
                <NewFolderForm
                  initial={folderSimilarity}
                  onCancel={() => setCreating(false)}
                  onCreate={(name, similarity, description) => {
                    setCreating(false)
                    run('Creating topic…', () => api.createFolder(name, similarity, description))
                  }}
                />
              )}
            </LibraryFront>
          </div>
        )}

        {!atFront && (
          <div className="lib-main">
            <div className="lib-list">
              {creating && (
                <NewFolderForm
                  initial={folderSimilarity}
                  onCancel={() => setCreating(false)}
                  onCreate={(name, similarity, description) => {
                    setCreating(false)
                    run('Creating topic…', () => api.createFolder(name, similarity, description))
                  }}
                />
              )}
              {openFolder && <FolderBar folder={openFolder} run={run} onWhatsNew={onWhatsNew} />}

              {showingRemoved && (
                <div className="lib-tools">
                  <span className="muted">
                    {removed.length} removed source{removed.length === 1 ? '' : 's'}. What each was is kept here; open one to restore it.
                  </span>
                </div>
              )}
              {showingRemoved && <RemovedTable entries={removed} open={openRemoved} onOpen={openGhost} />}

              {docs.length > 0 && !showingRemoved && (
                <div className="lib-chips" role="group" aria-label="Filters">
                  <button
                    className={`ghost lib-tl-btn${timeline ? ' on' : ''}`}
                    aria-pressed={!!timeline}
                    onClick={() => (timeline ? setTimeline(null) : openTimeline('added'))}
                    title="Narrow the library to when you got each source or when it was published"
                  >
                    ◷ Timeline
                  </button>
                  {(kinds.length > 1 || chip.kind) && (
                    <Chip name="Type" value={chip.kind} onOpen={chipMenu('f-kind')} onClear={() => setFilters((f) => ({ ...f, kinds: [] }))} />
                  )}
                  {(years.length > 1 || chip.year) && (
                    <Chip name="Year" value={chip.year} onOpen={chipMenu('f-year')} onClear={() => setFilters((f) => ({ ...f, year: null }))} />
                  )}
                  {folders.length > 0 && (
                    <Chip name="Topic" value={chip.topic} onOpen={chipMenu('f-topic')} onClear={() => setFilters((f) => ({ ...f, topics: [] }))} />
                  )}
                  {(authors.length > 1 || chip.author) && (
                    <Chip name="Author" value={chip.author} onOpen={chipMenu('f-author')} onClear={() => setFilters((f) => ({ ...f, authors: [] }))} />
                  )}
                  {(venues.length > 1 || chip.venue) && (
                    <Chip name="Journal" value={chip.venue} onOpen={chipMenu('f-venue')} onClear={() => setFilters((f) => ({ ...f, venues: [] }))} />
                  )}
                  {(anyHighlights || filters.highlighted) && (
                    <span className={`lib-chip${filters.highlighted ? ' on' : ''}`}>
                      <button aria-pressed={filters.highlighted} onClick={() => setFilters((f) => ({ ...f, highlighted: !f.highlighted }))} title="Only papers you have highlighted passages in">
                        Has highlights
                      </button>
                    </span>
                  )}
                  {filtersActive(filters) && (
                    <button className="link" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>
                  )}
                  <span className="spacer" />
                  {naming && naming.id === null ? (
                    <ViewNameForm initial={suggestedName()} action="Save" onDone={saveView} onCancel={() => setNaming(null)} />
                  ) : activeView ? (
                    <span className="lib-view-on">
                      <span className="muted">Saved view:</span> <b>{activeView.name}</b>
                      <button className="link" onClick={() => setNaming({ id: activeView.id })}>Rename</button>
                      <button className="link" onClick={() => deleteView(activeView)}>Delete</button>
                    </span>
                  ) : (
                    (filtersActive(filters) || searching) && (
                      <button className="lib-view-save" onClick={() => setNaming({ id: null })} title="Keep this search and these filters in the sidebar. The view stays current as papers arrive.">
                        Save as view
                      </button>
                    )
                  )}
                </div>
              )}

              {docs.length > 0 && !showingRemoved && chosen.length > 0 && (
                <div className="lib-tools lib-actions" role="toolbar" aria-label="Actions for the selected papers">
                  <button className="icon" onClick={clearSelection} aria-label="Clear the selection" title="Clear the selection (Esc)">×</button>
                  <b role="status">{chosen.length} selected</b>
                  {current && (
                    <button onClick={() => openFile(current)} title="Open the paper (Enter, or double-click it)">Open</button>
                  )}
                  {current && (
                    <button onClick={() => setPeek(true)} title="Its first page, abstract and your highlights, without opening it (Space)">Quick look</button>
                  )}
                  <button aria-haspopup="menu" onClick={(e) => setMenu({ kind: 'topic', ...under(e.currentTarget) })}>Add to topic ▾</button>
                  <button onClick={() => toggleDrafting(chosen)} title="The sources Muse drafts from and searches for citations in (Compose, Cite my sources)">
                    {allDrafting ? 'Stop drafting from' : 'Use for drafting'}
                  </button>
                  <button aria-haspopup="menu" onClick={(e) => setMenu({ kind: 'cite', ...under(e.currentTarget) })}>Copy citation ▾</button>
                  <button
                    onClick={() => setReadingList({ docs: chosen, title: openFolder ? `${openFolder.name} reading list` : 'Reading list' })}
                    title="A Word file of these papers' references, Muse's summaries and your highlights and notes"
                  >
                    Export reading list…
                  </button>
                  <button className="danger-text" onClick={() => remove(chosen)} title="Remove from the library (Delete). The files stay on disk.">Remove</button>
                </div>
              )}
              {docs.length > 0 && !showingRemoved && chosen.length === 0 && (
                <div className="lib-tools">
                  <span className="muted">
                    {filtering || scope !== 'all' ? `${rows.length} of ${docs.length}` : `${rows.length} sources`}
                    {searching && <> with “{query.trim()}”</>}
                  </span>
                  {lookupNote && !timeline && (
                    <span className="muted lib-note" role="status">
                      {lookupNote}{' '}
                      <button className="link" onClick={() => setLookupNote('')}>OK</button>
                    </span>
                  )}
                  <span className="spacer" />
                  <span className={`lib-scope${drafting.size ? ' some' : ''}`} role="status" aria-live="polite" title="The sources Muse drafts from and searches for citations in (Compose, Cite my sources)">
                    <b>Drafting from:</b> {drafting.size === 0 ? 'whole library' : `${drafting.size} of ${docs.length}`}
                    {drafting.size > 0 && (
                      <button className="link" onClick={useWholeLibrary}>
                        Use whole library
                      </button>
                    )}
                  </span>
                </div>
              )}

              {timeline && !showingRemoved && docs.length > 0 && (
                tl && axis ? (
                  <Timeline
                    docs={docs}
                    axis={axis}
                    window={tl}
                    onChange={setTimeline}
                    onField={openTimeline}
                    onClose={() => setTimeline(null)}
                    shown={rows.length}
                    ghosts={ghosts.length}
                    undated={docs.filter((d) => !docSpan(tl.field, d)).length}
                    toLookUp={notLookedUp}
                    lookupNote={lookupNote}
                    busy={!!busy}
                    onLookUp={() => lookUp()}
                  />
                ) : (
                  <section className="tl tl-empty">
                    <span>No source has a publication year yet.</span>
                    {notLookedUp > 0 && (
                      <button className="link" onClick={() => lookUp()} disabled={!!busy}>Look up dates in OpenAlex</button>
                    )}
                    <button className="link" onClick={() => openTimeline('added')}>Go by date added</button>
                    {lookupNote && <span className="muted">{lookupNote}</span>}
                    <span className="spacer" />
                    <button className="icon" onClick={() => setTimeline(null)} aria-label="Close timeline">×</button>
                  </section>
                )
              )}

              {!showingRemoved && paperLayout === 'covers' && (rows.length > 0 || (hits?.length ?? 0) > 0) && (
                <div className="lib-table-wrap lib-covers-wrap" style={{ '--fw': `${tileWidth(size)}px` } as React.CSSProperties}>
                  <PaperCovers
                    rows={rows}
                    sel={sel}
                    cur={cur}
                    cited={citedSet}
                    onSelect={select}
                    onOpenFile={openFile}
                    onMenu={(id, x, y) => {
                      if (!sel.has(id)) select(id, {})
                      setMenu({ kind: 'row', x, y })
                    }}
                    onKeyDown={onCoversKey}
                    gridRef={coversRef}
                  />
                  {passageHits}
                </div>
              )}
              {!showingRemoved && paperLayout === 'rows' && (rows.length > 0 || ghosts.length > 0 || (hits?.length ?? 0) > 0) && (
                <DocTable
                  rows={rows}
                  sel={sel}
                  cur={cur}
                  drafting={drafting}
                  cited={citedSet}
                  folder={openFolder}
                  sort={sort}
                  onSort={setSort}
                  cols={cols}
                  onSelect={select}
                  onSelectAll={selectAll}
                  onOpenFile={openFile}
                  onStar={(d) => mark([d], { starred: !d.starred })}
                  onRowMenu={(id, x, y) => {
                    if (!sel.has(id)) select(id, {})
                    setMenu({ kind: 'row', x, y })
                  }}
                  onHeaderMenu={(x, y) => setMenu({ kind: 'columns', x, y })}
                  onKeyDown={onTableKey}
                  tableRef={tableRef}
                  ghosts={ghosts}
                  ghostsSince={tl && axis ? `the end of ${posLabel(axis, tl.hi)}` : ''}
                  openGhost={openRemoved}
                  onOpenGhost={openGhost}
                  onOpenTopic={(id) => openKey(`t:${id}`)}
                >
                  {passageHits}
                </DocTable>
              )}

              {docs.length === 0 && !showingRemoved && importing && (
                <div className="lib-empty">
                  <div className="lib-empty-title">{adding ? `Adding ${adding} file${adding === 1 ? '' : 's'}` : 'Looking for files…'}</div>
                  <p>
                    Each one appears here as soon as it's read. Muse takes about 15 seconds per file to read it, write a summary and
                    tag it; the card above shows where each file is.
                  </p>
                </div>
              )}
              {docs.length === 0 && !showingRemoved && !importing && (
                <div className="lib-empty empty-art">
                  <Ribbons shape="wide" />
                  <p className="say say-sm">
                    <b>Your library is empty.</b> Add the papers, notes, slides, scans and web pages you're writing from. They stay on this computer.
                  </p>
                  <ol>
                    <li>Click <b>Add sources</b>, or drop files anywhere on the window</li>
                    <li>Muse reads each one and writes a summary and tags</li>
                    <li>Make a topic (New topic); matching papers are filed in, as many topics as fit</li>
                  </ol>
                </div>
              )}
              {docs.length > 0 && rows.length === 0 && ghosts.length === 0 && !hits?.length && !showingRemoved && (
                <div className="lib-empty">
                  <div className="lib-empty-title">{filtering ? 'No matches' : typeof scope === 'number' ? 'This topic is empty' : 'Nothing here'}</div>
                  {filtering ? (
                    <>
                      {searching && <p>Nothing {scope === 'all' ? 'in your library' : 'here'} has all of these words, in its details or its text.</p>}
                      <button
                        className="link"
                        onClick={() => {
                          onQuery('')
                          setFilters(NO_FILTERS)
                          setTimeline(null)
                        }}
                      >
                        {narrowed ? 'Clear the search, filters and timeline' : 'Clear the search and filters'}
                      </button>
                    </>
                  ) : typeof scope === 'number' ? (
                    <p>Lower the similarity above to take in looser matches, or drag papers onto the topic.</p>
                  ) : (
                    <p>{emptyText[scope]}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {!atFront && current && (
          <div className="lib-pane">
            <DocDetails
              key={current.id}
              doc={current}
              on={drafting.has(current.id)}
              scopeCount={drafting.size}
              cited={citedSet.has(current.id)}
              edit={editFor === current.id}
              onEditTaken={() => setEditFor(null)}
              onToggle={() => toggleDrafting([current])}
              onUseWholeLibrary={useWholeLibrary}
              onClose={clearSelection}
              onCited={() => onCitedPapers(current.id)}
              onCiting={() => onCitingPapers(current.id)}
              onRetry={() => retry([current.id])}
              onOpen={() => openFile(current)}
              onStar={() => mark([current], { starred: !current.starred })}
              onCopyCitation={(el) => setMenu({ kind: 'cite', ...under(el) })}
              onRemove={() => remove([current])}
              onLocated={() => say('Found it. Its citations and highlights are kept.')}
              docById={docById}
              onShowDoc={goTo}
              run={run}
            />
          </div>
        )}
        {!atFront && chosen.length > 1 && (
          <div className="lib-pane">
            <ManyDetails docs={chosen} onClose={clearSelection} />
          </div>
        )}
        {!atFront && currentRemoved && chosen.length === 0 && (
          <div className="lib-pane">
            <RemovedDetails
              key={`removed-${currentRemoved.id}`}
              entry={currentRemoved}
              hasDoc={(id) => docIds.has(id)}
              onShowDoc={showDoc}
              onClose={() => setOpenRemoved(null)}
              run={run}
            />
          </div>
        )}
      </div>
      {atFront && summaryOpen && (
        <FolderSummary
          item={selKey ? itemByKey.get(selKey) : undefined}
          topics={topicItems}
          cited={citedSet}
          drafting={drafting}
          onOpen={() => selKey && openKey(selKey)}
          onClose={() => {
            setSummaryOpen(false)
            focusTile(selKey)
          }}
          onDraft={toggleDrafting}
          onMap={(name) => onMapTopic?.(name)}
          onWhatsNew={onWhatsNew}
          onOpenKey={openKey}
          onSurprise={() => {
            const it = selKey ? itemByKey.get(selKey) : undefined
            if (it) surpriseFrom(it.docs, it.kind === 'topic' ? it.name : 'your library')
          }}
        />
      )}

      {peek && current && (
        <QuickLook
          doc={current}
          at={rows.findIndex((d) => d.id === current.id) + 1}
          of={rows.length}
          kindLabel={KIND_LABEL[current.kind]}
          onStep={(dir) => step(dir)}
          onOpen={
            canOpen(current)
              ? () => {
                  closePeek()
                  openFile(current)
                }
              : null
          }
          onClose={closePeek}
        />
      )}
      {menu && (
        <PopMenu
          key={`${menu.kind}-${menu.x}-${menu.y}`}
          x={menu.x}
          y={menu.y}
          items={menuItems()}
          onClose={() => {
            menuClosed.current = { kind: menu.kind, at: performance.now() }
            closeMenu()
            if (!atFront) listEl()?.focus({ preventScroll: true })
            else focusTile(selKey)
          }}
        />
      )}
      {peekItem && (
        <FolderPeek
          item={peekItem}
          onClose={closeFolderPeek}
          onOpen={() => openKey(peekItem.key)}
          onStep={peekStep}
        />
      )}
      {folderMenu && menuItem && (
        <FolderMenu
          item={menuItem}
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => {
            setFolderMenu(null)
            focusTile(folderMenu.key)
          }}
          onOpen={() => openKey(menuItem.key)}
          onPeek={() => setPeekKey(menuItem.key)}
          onColor={(c) => menuItem.folder && setColor(menuItem.folder, c)}
          onRename={() => requestAnimationFrame(() => setRenaming(menuItem.key))} // after the menu hands the keyboard back, or the field loses it at once
          onMerge={(x, y) => {
            const id = menuItem.folder?.id
            // After the folder menu has handed the keyboard back, so the list of topics keeps it.
            if (id !== undefined) requestAnimationFrame(() => setMenu({ kind: 'merge', x, y, folderId: id }))
          }}
          onDelete={() => menuItem.saved && deleteView(menuItem.saved)}
          onSurprise={() => surpriseFrom(menuItem.docs, menuItem.kind === 'topic' ? menuItem.name : 'your library')}
          draftLabel={
            menuItem.docs.length > 0 && menuItem.view !== 'all' && menuItem.view !== 'drafting' && menuItem.view !== 'removed'
              ? menuItem.docs.every((d) => drafting.has(d.id))
                ? 'Stop drafting from'
                : 'Use for drafting'
              : undefined
          }
          onDraft={() => toggleDrafting(menuItem.docs)}
          onReadingList={() => setReadingList({ docs: menuItem.docs, title: `${menuItem.name} reading list` })}
        />
      )}
      {readingList && (
        <ReadingListDialog
          docIds={readingList.docs.map((d) => d.id)}
          papers={readingList.docs.filter((d) => d.kind !== 'text').length}
          notes={readingList.docs.filter((d) => d.kind === 'text').length}
          defaultTitle={readingList.title}
          style={citationStyle}
          onClose={() => setReadingList(null)}
          onSaved={(name) => say(`Saved the reading list as ${name}.`)}
          onError={onError}
        />
      )}
      {dragging !== null && <DropShelf topics={topicItems} openKey={opened} count={dragging} onDrop={dropOnTopic} />}
      {toast && (
        <div className="lib-toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              onClick={() => {
                toast.undo!()
                setToast(null)
              }}
            >
              Undo
            </button>
          )}
          <button className="lib-toast-x" onClick={() => setToast(null)} aria-label="Dismiss">×</button>
        </div>
      )}
    </section>
  )
})
