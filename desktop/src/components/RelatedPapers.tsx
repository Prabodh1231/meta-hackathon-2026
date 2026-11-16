import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Doc, RelatedDoc } from '../types'

/** Why a paper is listed as related, the strongest reason first: who cites whom, then the works
 * both cite, then the keywords both carry (or, without those, the words their records share). */
export function relatedWhy(r: RelatedDoc): string[] {
  return [
    r.cites_this ? 'Cites this paper' : '',
    r.cited_by_this ? 'Cited by this paper' : '',
    r.shared_refs ? `${r.shared_refs} shared references` : '',
    r.shared_terms.length ? `Both on ${r.shared_terms.join(', ')}` : r.words.length ? `Similar wording: ${r.words.join(', ')}` : '',
  ].filter(Boolean)
}

/** In a paper's details: the papers in the library closest to it, each with its reason. A click
 * goes to that paper. Worked out from reference lists and shared words; Muse isn't asked. */
export function RelatedPapers({ doc, docById, byline, onShow }: {
  doc: Doc
  docById: Map<number, Doc>
  byline: (d: Doc) => string
  onShow: (id: number) => void
}) {
  // null: still looking, or the backend can't say (an older one): nothing is shown either way.
  const [related, setRelated] = useState<RelatedDoc[] | null>(null)
  useEffect(() => {
    let stale = false
    setRelated(null)
    api.related(doc.id).then((r) => !stale && setRelated(r)).catch(() => {})
    return () => {
      stale = true
    }
  }, [doc.id, docById.size]) // again when papers come or go: one of them may be related
  if (!related) return null
  const shown = related.filter((r) => docById.has(r.doc_id))
  return (
    <section className="card-frame lib-related-frame">
      <h4 title="From the papers' reference lists and the words in their records. Muse isn't asked.">Related in your library</h4>
      {shown.length === 0 ? (
        <p className="muted lib-related-none">No other paper here cites it, is cited by it, shares its references or reads like it.</p>
      ) : (
        <ul className="lib-related">
          {shown.map((r) => {
            const d = docById.get(r.doc_id)!
            return (
              <li key={r.doc_id}>
                <button onClick={() => onShow(r.doc_id)} title="Go to this paper">
                  <span className="lib-related-title">{d.title}</span>
                  <span className="lib-related-by">{byline(d)}</span>
                  <span className="lib-related-why">{relatedWhy(r).join(' · ')}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
