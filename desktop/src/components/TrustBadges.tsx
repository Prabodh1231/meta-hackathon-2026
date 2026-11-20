/** Trust hazards and personal notes, shown the same way everywhere a source is named.
 * "Retracted": OpenAlex says so, or the title, tags or keywords do. The backend decides for library
 * papers (`retracted`, also read by the Word export); the words alone are the sign for works outside
 * the library, such as the network's. "Needs metadata" means the record has no year or no author yet,
 * so a reference built from it is shaky. */
import { createContext, useContext } from 'react'

export interface TrustLike {
  title?: string
  authors?: string[]
  year?: number | null
  kind?: string
  tags?: string[]
  keywords?: string[]
  /** The backend's decision, for a library paper. */
  retracted?: boolean
  /** OpenAlex lists it as retracted. */
  index_retracted?: boolean
  /** A network node's library paper: its badges are the library record's. */
  doc_id?: number
}

/** The library's papers by id, so a network node, which carries only a title and authors, shows
 * the same warnings as the paper itself (OpenAlex's retraction flag among them). */
export const LibraryTrust = createContext<Map<number, TrustLike> | null>(null)

/** Who says a paper was retracted, for the warning's wording. */
export type RetractedWhy = 'index' | 'words'

export function retractedWhy(d: TrustLike): RetractedWhy | null {
  if (d.index_retracted) return 'index'
  // A library paper: the backend has decided, and the only other sign is the words.
  if (d.retracted !== undefined) return d.retracted ? 'words' : null
  return /\bretract(ed|ion)?\b/i.test([d.title ?? '', ...(d.tags ?? []), ...(d.keywords ?? [])].join(' ')) ? 'words' : null
}

export function isRetracted(d: TrustLike): boolean {
  return retractedWhy(d) !== null
}

export const RETRACTED_SAYS: Record<RetractedWhy, string> = {
  index: 'OpenAlex lists it as retracted.',
  words: 'Its title or keywords say it was retracted.',
}

export function needsMetadata(d: TrustLike): boolean {
  return !d.year || !d.authors?.length
}

export function isPersonalNote(d: TrustLike): boolean {
  return d.kind === 'text'
}

export function TrustBadges({ doc: given, showNote = false }: { doc?: TrustLike | null; showNote?: boolean }) {
  const library = useContext(LibraryTrust)
  const doc = (given?.doc_id != null && library?.get(given.doc_id)) || given
  if (!doc) return null
  const why = retractedWhy(doc)
  const retracted = why !== null
  const needs = needsMetadata(doc)
  const note = showNote && isPersonalNote(doc)
  if (!retracted && !needs && !note) return null
  return (
    <span className="trust-badges">
      {retracted && (
        <span className="trust-badge trust-retracted" title={`This work was retracted: do not rely on it without checking why. ${why ? RETRACTED_SAYS[why] : ''}`}>
          Retracted
        </span>
      )}
      {needs && (
        <span className="trust-badge trust-metadata" title="Its record has no year or no author yet: check Edit details before citing it">
          Needs metadata
        </span>
      )}
      {note && (
        <span className="trust-badge trust-note" title="Your own reading note, not a published paper">
          Your note
        </span>
      )}
    </span>
  )
}
