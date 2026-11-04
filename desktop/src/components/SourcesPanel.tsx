import { CITATION_WORD } from '../editor/citeStatus'
import type { CiteMarkAttrs } from '../editor/citeMark'
import type { Doc, DocxStyle } from '../types'
import { ReferencesPanel } from './ReferencesPanel'
import type { ChipAttrs } from './WritingEditor'

interface Props {
  view: 'cited' | 'refs'
  onView: (v: 'cited' | 'refs') => void
  chips: ChipAttrs[]
  marks: CiteMarkAttrs[]
  docs: Doc[]
  style: DocxStyle
  citedDocIds: () => number[]
  /** A source's details in the Library. */
  onOpenPaper: (docId: number) => void
  onOpenChip: (chip: ChipAttrs) => void
  /** Select a marker in the draft (and show it in Check). */
  onOpenMark: (cid: string) => void
  onError: (msg: string) => void
}

/** "Chen & Martinez 2021, p. 342" → "Chen & Martinez 2021" */
const sourceLabel = (label: string) => label.replace(/,\s*(pp?\.|page|slide|para\.?)\s*\S+$/i, '')

/** Sources: what this draft cites, source by source with each citation's mark; and the reference list. */
export function SourcesPanel({ view, onView: setView, chips, marks, docs, style, citedDocIds, onOpenPaper, onOpenChip, onOpenMark, onError }: Props) {
  const groups = new Map<number, ChipAttrs[]>()
  for (const c of chips) groups.set(c.docId, [...(groups.get(c.docId) ?? []), c])
  const unsourced = marks

  return (
    <div className="sources-panel">
      <div className="seg-tabs" role="tablist" aria-label="Sources view">
        <button role="tab" aria-selected={view === 'cited'} className={view === 'cited' ? 'on' : ''} onClick={() => setView('cited')}>
          Cited sources · {groups.size}
        </button>
        <button role="tab" aria-selected={view === 'refs'} className={view === 'refs' ? 'on' : ''} onClick={() => setView('refs')}>
          Reference list
        </button>
      </div>

      {view === 'refs' ? (
        <ReferencesPanel style={style} citedDocIds={citedDocIds} onError={onError} />
      ) : groups.size + unsourced.length === 0 ? (
        <p className="empty">Nothing cited yet. Every source the draft cites is listed here, with each of its citations.</p>
      ) : (
        <ul className="src-list">
          {[...groups.entries()].map(([docId, cs]) => {
            const doc = docs.find((d) => d.id === docId)
            return (
              <li key={docId} className="src-row">
                <button className="src-name" onClick={() => onOpenPaper(docId)} title="Open its details in the Library">
                  <b>{sourceLabel(cs[0].label)}</b>
                  {doc && <span className="muted">{doc.title}</span>}
                </button>
                <span className="src-marks" aria-label={`${cs.length} citation${cs.length === 1 ? '' : 's'}`}>
                  {cs.map((c) => (
                    <button
                      key={c.cid}
                      className={`cite cite-${c.status} legend-chip src-mark${c.finding != null ? ' cite-matrix' : ''}`}
                      onClick={() => onOpenChip(c)}
                      title={`${c.label}: ${CITATION_WORD[c.status]}. ${c.claim}`}
                      aria-label={`${c.label}, ${CITATION_WORD[c.status]}`}
                    />
                  ))}
                </span>
              </li>
            )
          })}
          {unsourced.length > 0 && (
            <li className="src-row">
              <span className="src-name">
                <b className="muted">No source yet</b>
                <span className="muted">
                  {unsourced.length} sentence{unsourced.length === 1 ? '' : 's'} with a cite marker
                </span>
              </span>
              <span className="src-marks">
                {unsourced.map((m) => (
                  <button key={m.cid} className={`cite-mark cite-mark-${m.state}`} onClick={() => onOpenMark(m.cid)} title={m.claim}>
                    cite
                  </button>
                ))}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
