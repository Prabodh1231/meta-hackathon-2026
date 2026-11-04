/** Trust hazards and personal notes, shown the same way everywhere a source is named.
 * "Retracted" is read from the words in the title, tags or keywords; "Needs metadata"
 * means the record has no year or no author yet, so a reference built from it is shaky. */

export interface TrustLike {
  title?: string
  authors?: string[]
  year?: number | null
  kind?: string
  tags?: string[]
  keywords?: string[]
}

export function isRetracted(d: TrustLike): boolean {
  return /\bretract(ed|ion)?\b/i.test([d.title ?? '', ...(d.tags ?? []), ...(d.keywords ?? [])].join(' '))
}

export function needsMetadata(d: TrustLike): boolean {
  return !d.year || !d.authors?.length
}

export function isPersonalNote(d: TrustLike): boolean {
  return d.kind === 'text'
}

export function TrustBadges({ doc, showNote = false }: { doc?: TrustLike | null; showNote?: boolean }) {
  if (!doc) return null
  const retracted = isRetracted(doc)
  const needs = needsMetadata(doc)
  const note = showNote && isPersonalNote(doc)
  if (!retracted && !needs && !note) return null
  return (
    <span className="trust-badges">
      {retracted && (
        <span className="trust-badge trust-retracted" title="This work was retracted: do not rely on it without checking why">
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
