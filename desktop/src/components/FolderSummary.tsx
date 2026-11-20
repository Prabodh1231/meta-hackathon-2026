import type { Doc } from '../types'
import type { FrontItem } from './FolderTile'
import { plural } from './libraryParts'

const surname = (a: string) => (a.includes(',') ? a.split(',')[0] : a.split(' ').pop() ?? a).trim()
const short = (t: string) => (t.length > 72 ? t.slice(0, 70) + '…' : t)
const MAX_BARS = 16

/** Papers by year as bars: one per year, or per span of years when they cover more than MAX_BARS. */
function yearBars(years: number[]) {
  const lo = Math.min(...years)
  const hi = Math.max(...years)
  const span = hi - lo + 1
  const bins = Array.from({ length: Math.min(span, MAX_BARS) }, () => 0)
  for (const y of years) bins[Math.min(bins.length - 1, Math.floor(((y - lo) / span) * bins.length))]++
  return { lo, hi, bins, top: Math.max(...bins) }
}

/** What is in the selected folder, beside the front page. Its column is always there, empty until a
 * folder is selected, so selecting one never moves the folders under the pointer. */
export function FolderSummary({ item, topics, cited, drafting, onOpen, onDraft, onMap, onOpenKey, onSurprise }: {
  item: FrontItem | undefined
  topics: FrontItem[] // every topic, to say which share papers with this one
  cited: Set<number>
  drafting: Set<number>
  onOpen: () => void
  onDraft: (docs: Doc[]) => void
  onMap: (name: string) => void
  onOpenKey: (key: string) => void
  onSurprise?: () => void // open a random unread paper from it
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
  const newest = [...docs].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || b.added_at.localeCompare(a.added_at)).slice(0, 4)
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
    <aside className="lf-summary" aria-label={`About ${item.name}`}>
      <h3>{item.name}</h3>
      <p className="muted">
        {item.countText ?? plural(item.count, 'paper')}
        {surprising && unread > 0 && ` · ${unread} unread`}
        {bars && ` · ${bars.lo === bars.hi ? bars.lo : `${bars.lo}–${bars.hi}`}`}
        {item.rule && (
          <>
            <br />
            {item.rule}
          </>
        )}
      </p>
      <div className="lf-acts">
        <button className="primary" onClick={onOpen}>Open</button>
        {canDraft && (
          <button onClick={() => onDraft(docs)} title="The sources Muse drafts from and searches for citations in">
            {allDrafting ? 'Stop drafting from' : 'Use for drafting'}
          </button>
        )}
        {item.kind === 'topic' && (
          <button onClick={() => onMap(item.name)} title="Search the citation network for this topic">Map it</button>
        )}
      </div>

      {surprising && (
        <p className="lf-surprise">
          <button className="link" onClick={onSurprise} title="Open a paper from it you haven't read yet, at random">
            Surprise me{unread > 0 ? ': an unread paper' : ''}
          </button>
        </p>
      )}

      {docs.length > 0 && (
        <>
          <h4>In the open draft</h4>
          <div className="lf-use" role="img" aria-label={`${nCited} cited, ${nTicked} more ticked for drafting, of ${docs.length}`}>
            <i className="cited" style={{ width: `${(nCited / docs.length) * 100}%` }} />
            <i className="ticked" style={{ width: `${(nTicked / docs.length) * 100}%` }} />
          </div>
          <p>
            {nCited} cited · {nTicked} more ticked for drafting
          </p>
        </>
      )}

      {bars && (
        <>
          <h4>By year</h4>
          <div className="lf-bars" role="img" aria-label={`Papers from ${bars.lo} to ${bars.hi}`}>
            {bars.bins.map((n, i) => (
              <i key={i} style={{ height: `${(n / bars.top) * 100}%` }} />
            ))}
          </div>
          <div className="lf-years">
            <span>{bars.lo}</span>
            <span>{bars.hi}</span>
          </div>
        </>
      )}

      {newest.length > 0 && (
        <>
          <h4>Newest in it</h4>
          <ul>
            {newest.map((d) => (
              <li key={d.id} title={d.title}>
                {short(d.title)}
                {d.year ? <span className="muted"> {d.year}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {authors.length > 0 && (
        <>
          <h4>Most frequent first authors</h4>
          <p>{authors.map(([a, n]) => `${a}${n > 1 ? ` (${n})` : ''}`).join(', ')}</p>
        </>
      )}

      {shares.length > 0 && (
        <>
          <h4>Shares papers with</h4>
          <p className="lf-shares">
            {shares.map(([t, n]) => (
              <button key={t.key} className="lf-chip" onClick={() => onOpenKey(t.key)} title={`Open ${t.name}: ${plural(n, 'paper')} in both`}>
                {t.name} <span>{n}</span>
              </button>
            ))}
          </p>
        </>
      )}
    </aside>
  )
}
