import { CITATION_WORD } from '../editor/citeStatus'
import type { CiteMarkAttrs } from '../editor/citeMark'
import type { Doc, DocxStyle } from '../types'
import { ReferencesPanel } from './ReferencesPanel'
import { TrustBadges } from './TrustBadges'
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

/** “2 supported · 1 partly supported”, in the same words as the citation chips. */
function statusCounts(cs: ChipAttrs[]): string {
  const counts = new Map<ChipAttrs['status'], number>()
  for (const c of cs) counts.set(c.status, (counts.get(c.status) ?? 0) + 1)
  return [...counts.entries()].map(([status, n]) => `${n} ${CITATION_WORD[status].toLowerCase()}`).join(' · ')
}

/** "Chen & Martinez 2021" → "CM"; one name gives one letter. */
const initials = (name: string) =>
  name
    .replace(/\d+.*$/, '')
    .split(/\s*(?:&|,|\band\b|et al\.?)\s*|\s+/)
    .filter((w) => /^\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '·'

const NUMBER = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
/** "backs six claims in this draft." / "is cited three times; two are supported." */
function sentence(n: number, backed: number, note: boolean | undefined): string {
  const word = (k: number) => NUMBER[k] ?? String(k)
  if (note) return `is quoted ${n === 1 ? 'once' : `${word(n)} times`} in this draft.`
  if (backed === n) return `backs ${word(n)} claim${n === 1 ? '' : 's'} in this draft.`
  if (backed === 0) return `is cited ${n === 1 ? 'once' : `${word(n)} times`}; none ${n === 1 ? 'is' : 'are'} supported yet.`
  return `is cited ${word(n)} times; ${word(backed)} ${backed === 1 ? 'is' : 'are'} supported.`
}

/** Sources: what this draft cites, one sentence per source that opens to its figures and each
 * citation's mark; and the reference list. */
export function SourcesPanel({ view, onView: setView, chips, marks, docs, style, citedDocIds, onOpenPaper, onOpenChip, onOpenMark, onError }: Props) {
  const groups = new Map<number, ChipAttrs[]>()
  for (const c of chips) groups.set(c.docId, [...(groups.get(c.docId) ?? []), c])
  const unsourced = marks
  const paperGroups = [...groups.entries()].filter(([docId]) => docs.find((d) => d.id === docId)?.kind !== 'text')
  const noteGroups = [...groups.entries()].filter(([docId]) => docs.find((d) => d.id === docId)?.kind === 'text')

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
        <ReferencesPanel style={style} citedDocIds={citedDocIds} docs={docs} onError={onError} />
      ) : groups.size + unsourced.length === 0 ? (
        <p className="say say-sm src-none">
          <b>Nothing cited yet.</b> Every source the draft cites is listed here, with each of its citations.
        </p>
      ) : (
        <>
          <div className="xrows">
            {[...paperGroups, ...noteGroups].map(([docId, cs], i) => {
              const doc = docs.find((d) => d.id === docId)
              const note = doc?.kind === 'text'
              const name = sourceLabel(cs[0].label)
              const backed = cs.filter((c) => c.status === 'verified').length
              return (
                <details key={docId} className={`xrow${note ? ' xrow-note' : ''}`} open={i === 0}>
                  <summary title={statusCounts(cs)}>
                    <span className="xrow-mark" aria-hidden="true">{initials(name)}</span>
                    <span className="xrow-line">
                      {name} {sentence(cs.length, backed, note)}
                      {doc && <small>{doc.title}</small>}
                    </span>
                    <span className="sq-btn" aria-hidden="true" />
                  </summary>
                  <div className="xrow-body">
                    <span className="xrow-figs">
                      <span><b>{cs.length}</b>citation{cs.length === 1 ? '' : 's'}</span>
                      <span><b>{backed}</b>supported</span>
                      {doc && doc.highlights > 0 && <span><b>{doc.highlights}</b>highlight{doc.highlights === 1 ? '' : 's'}</span>}
                      <button className="link-go" onClick={() => onOpenPaper(docId)} title="Open its details in the Library">
                        Open paper ›
                      </button>
                    </span>
                    {note && <span className="muted">Your own reading notes, not a published paper.</span>}
                    <TrustBadges doc={doc} showNote />
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
                  </div>
                </details>
              )
            })}
          </div>
          {unsourced.length > 0 && (
            <ul className="src-list">
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
            </ul>
          )}
        </>
      )}
    </div>
  )
}
