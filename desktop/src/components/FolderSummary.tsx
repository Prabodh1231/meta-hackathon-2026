import type { Doc } from '../types'
import type { FrontItem } from './FolderTile'
import { authorsShort, plural } from './libraryParts'

const surname = (a: string) => (a.includes(',') ? a.split(',')[0] : a.split(' ').pop() ?? a).trim()
const MAX_BARS = 12

/** Papers by year as bars: one per year, or per span of years when they cover more than MAX_BARS. */
function yearBars(years: number[]) {
  const lo = Math.min(...years)
  const hi = Math.max(...years)
  const span = hi - lo + 1
  const bins = Array.from({ length: Math.min(span, MAX_BARS) }, () => 0)
  for (const y of years) bins[Math.min(bins.length - 1, Math.floor(((y - lo) / span) * bins.length))]++
  return { lo, hi, bins, top: Math.max(...bins) }
}

/** What is in the selected folder, beside the front page. Its column is always there, so selecting a
 * folder never moves the folders under the pointer. Before one is picked (`overview`), it sums up the
 * whole library: All sources, with its largest topics and what was added last. */
export function FolderSummary({ item, overview = false, topics, cited, drafting, onOpen, onClose, onDraft, onMap, onOpenKey, onWhatsNew, onSurprise }: {
  item: FrontItem | undefined
  overview?: boolean // nothing is picked: `item` is All sources, shown as the library at a glance
  topics: FrontItem[] // every topic, to say which share papers with this one
  cited: Set<number>
  drafting: Set<number>
  onOpen: () => void
  onClose: () => void // let the folder go
  onDraft: (docs: Doc[]) => void
  onMap: (name: string) => void
  onOpenKey: (key: string) => void
  onSurprise?: () => void // open a random unread paper from it
  onWhatsNew?: (folderId: number) => void
}) {
  if (!item) {
    return (
      <aside className="lf-summary lf-summary-empty" aria-label="Selected folder">
        <p className="muted">
          Click a folder to see what's in it.
          <br />
          Double-click to open it.
        </p>
      </aside>
    )
  }
  const docs = item.docs
  const surprising = !!onSurprise && (item.kind === 'topic' || item.view === 'all') && docs.some((d) => d.kind !== 'text')
  const unread = docs.filter((d) => d.unread && d.kind !== 'text').length
  const years = docs.map((d) => d.year).filter((y): y is number => !!y && y > 0)
  const bars = years.length ? yearBars(years) : null
  const nCited = docs.filter((d) => cited.has(d.id)).length
  const nTicked = docs.filter((d) => drafting.has(d.id) && !cited.has(d.id)).length
  // A folder lists its newest papers by year; the whole library, what came in last.
  const newest = overview
    ? [...docs].sort((a, b) => b.added_at.localeCompare(a.added_at)).slice(0, 5)
    : [...docs].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || b.added_at.localeCompare(a.added_at)).slice(0, 4)
  const largest = overview ? [...topics].sort((a, b) => b.count - a.count).slice(0, 5) : []
  const authors = [...docs.reduce((m, d) => (d.authors[0] ? m.set(surname(d.authors[0]), (m.get(surname(d.authors[0])) ?? 0) + 1) : m), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
  const ids = new Set(docs.map((d) => d.id))
  const shares =
    item.view === 'all' || item.view === 'removed'
      ? []
      : topics
          .filter((t) => t.key !== item.key)
          .map((t) => [t, t.docs.filter((d) => ids.has(d.id)).length] as const)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
  const allDrafting = docs.length > 0 && docs.every((d) => drafting.has(d.id))
  // "Use for drafting" on everything, or on what is already the drafting set, would change nothing.
  const canDraft = docs.length > 0 && item.view !== 'all' && item.view !== 'drafting' && item.view !== 'removed'

  return (
    <aside className={`lf-summary${overview ? ' lf-overview' : ''}`} aria-label={overview ? 'Your library' : `About ${item.name}`}>
      {overview && <p className="lf-sum-eyebrow">Your library</p>}
      <div className="lf-sum-head">
        <h3>{item.name}</h3>
        <button className="lf-sum-x" onClick={onClose} aria-label="Hide this panel" title="Hide this panel (the button beside More brings it back)">
          ×
        </button>
      </div>
      <p className="lf-sum-meta">
        {item.countText ?? plural(item.count, 'paper')}
        {surprising && unread > 0 && ` · ${unread} unread`}
        {bars && ` · ${bars.lo === bars.hi ? bars.lo : `${bars.lo}–${bars.hi}`}`}
      </p>
      {item.rule && <p className="lf-sum-rule">{item.rule}</p>}
      {item.folder?.description && <p className="lf-topic-rule" title="What belongs here, in your words">“{item.folder.description}”</p>}
      <div className="lf-acts">
        <button className="primary" onClick={onOpen}>Open</button>
        {canDraft && (
          <button onClick={() => onDraft(docs)} title="The sources Muse drafts from and searches for citations in">
            {allDrafting ? 'Stop drafting from' : 'Use for drafting'}
          </button>
        )}
        {item.kind === 'topic' && (
          <button onClick={() => onMap(item.name)} title="Search the citation network for this topic">Map</button>
        )}
        {item.folder && onWhatsNew && (
          <button onClick={() => onWhatsNew(item.folder!.id)} title="Recent works that cite this topic's papers and aren't in your library">
            What's new
          </button>
        )}
      </div>

      {docs.length > 0 && (
        <section className="lf-sec lf-sec-use">
          <div className="lf-use" role="img" aria-label={`In the open draft: ${nCited} cited, ${nTicked} more ticked for drafting, of ${docs.length}`}>
            <i className="cited" style={{ width: `${(nCited / docs.length) * 100}%` }} />
            <i className="ticked" style={{ width: `${(nTicked / docs.length) * 100}%` }} />
          </div>
          <p className="lf-use-text" title="How much of it the draft open in Write uses">
            {nCited} cited · {nTicked} ticked for drafting
          </p>
          {surprising && (
            <button className="link lf-surprise" onClick={onSurprise} title="Open a paper from it you haven't read yet, at random">
              Surprise me{unread > 0 ? ': an unread paper' : ''}
            </button>
          )}
        </section>
      )}

      {bars && (
        <section className="lf-sec">
          <h4>
            By year <span>{bars.lo === bars.hi ? bars.lo : `${bars.lo}–${bars.hi}`}</span>
          </h4>
          <div className="lf-bars" role="img" aria-label={`Papers from ${bars.lo} to ${bars.hi}`}>
            {bars.bins.map((n, i) => (
              <i key={i} style={{ height: `${(n / bars.top) * 100}%` }} />
            ))}
          </div>
        </section>
      )}

      {largest.length > 0 && (
        <section className="lf-sec">
          <h4>Largest topics</h4>
          <p className="lf-shares">
            {largest.map((t) => (
              <button key={t.key} className="lf-chip" onClick={() => onOpenKey(t.key)} title={`Open ${t.name}`}>
                {t.name} <span>{t.count}</span>
              </button>
            ))}
          </p>
        </section>
      )}

      {newest.length > 0 && (
        <section className="lf-sec">
          <h4>
            {overview ? 'Recently added' : 'Recent papers'} <span>{newest.length}</span>
          </h4>
          <ul className="lf-papers">
            {newest.map((d) => (
              <li key={d.id} title={d.title}>
                <b>{d.title}</b>
                <small>{[authorsShort(d), d.year].filter(Boolean).join(' · ')}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {authors.length > 0 && (
        <section className="lf-sec">
          <h4>Most frequent first authors</h4>
          <p>{authors.map(([a, n]) => `${a}${n > 1 ? ` (${n})` : ''}`).join(', ')}</p>
        </section>
      )}

      {shares.length > 0 && (
        <section className="lf-sec">
          <h4>Shares papers with</h4>
          <p className="lf-shares">
            {shares.map(([t, n]) => (
              <button key={t.key} className="lf-chip" onClick={() => onOpenKey(t.key)} title={`Open ${t.name}: ${plural(n, 'paper')} in both`}>
                {t.name} <span>{n}</span>
              </button>
            ))}
          </p>
        </section>
      )}
      {overview && <p className="lf-sum-hint muted">Click a folder to see what’s in it; double-click to open it.</p>}
    </aside>
  )
}
