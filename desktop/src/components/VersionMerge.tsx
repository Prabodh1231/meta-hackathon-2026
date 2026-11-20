import { useState } from 'react'
import { api } from '../api'
import type { DuplicateDoc, DuplicateGroup, MergeReport } from '../types'

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

/** The copy that looks published (a DOI or a journal), when exactly one of two does. */
export function publishedOf(g: DuplicateGroup): DuplicateDoc | null {
  if (g.kind !== 'likely_same' || g.docs.length !== 2) return null
  const pub = g.docs.filter((d) => d.doi || d.venue)
  return pub.length === 1 ? pub[0] : null
}

/** "a, b and c" from the parts given (empty ones left out). */
export function andList(items: (string | number | false | null | undefined)[]): string {
  const parts = items.filter(Boolean) as string[]
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? ''
}

/** What moved, in a line: "12 citations, 4 highlights and 3 topics". */
export function movedText(r: MergeReport): string {
  return andList([
    r.citations && plural(r.citations, 'citation'),
    r.highlights && plural(r.highlights, 'highlight'),
    r.topics && plural(r.topics, 'topic'),
    r.matrix_rows && plural(r.matrix_rows, 'matrix row'),
    r.findings && plural(r.findings, 'saved finding'),
  ]) || 'nothing but the record'
}

/** For two files of the same paper (a preprint and the published version, say): keep one and move
 *  everything from the other to it, then remove the other. A dry run says first what will move. */
export function VersionMerge({ group: g, keep, disabled, onBefore, onDone, onError }: {
  group: DuplicateGroup
  keep: DuplicateDoc // the copy to keep
  disabled: boolean
  onBefore: () => Promise<void> // save the open draft first, so its next save can't undo the move
  onDone: (r: MergeReport) => Promise<void>
  onError: (msg: string) => void
}) {
  const other = g.docs.find((d) => d.id !== keep.id)!
  const [plan, setPlan] = useState<MergeReport | null>(null)
  const [busy, setBusy] = useState(false)

  const ask = async () => {
    setBusy(true)
    try {
      await onBefore()
      setPlan(await api.mergeInto(other.id, keep.id, true))
    } catch (e) {
      onError(`Could not work out what would move: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }
  const go = async () => {
    setBusy(true)
    try {
      await onBefore()
      const r = await api.mergeInto(other.id, keep.id)
      setPlan(null)
      await onDone(r)
    } catch (e) {
      onError(`Nothing was moved: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }

  if (!plan) {
    return (
      <button className="primary" onClick={ask} disabled={disabled || busy}>
        {busy ? 'Looking…' : publishedOf(g)?.id === keep.id ? 'Keep the published version and move everything to it' : 'Keep this one and move everything to it'}
      </button>
    )
  }
  const items = [
    plan.citations > 0 && `${plural(plan.citations, 'citation')} in ${plural(plan.drafts, 'draft')} (a version of each draft is saved first)`,
    plan.highlights > 0 && `${plural(plan.highlights, 'highlight')}, with ${plan.highlights === 1 ? 'its note' : 'their notes'}`,
    plan.topics > 0 && `${plural(plan.topics, 'topic')} you added it to`,
    plan.matrix_rows > 0 && plural(plan.matrix_rows, 'review-matrix row'),
    plan.matrix_rows_dropped > 0 && `${plural(plan.matrix_rows_dropped, 'matrix', 'matrices')} that already ${plan.matrix_rows_dropped === 1 ? 'has' : 'have'} the kept copy: its row there is dropped`,
    plan.findings > 0 && plural(plan.findings, 'saved finding'),
    plan.starred && 'its star',
  ].filter(Boolean) as string[]
  return (
    <div className="df-confirm vm-confirm">
      <b>Move everything to “{keep.title}”?</b>
      {items.length ? (
        <ul>{items.map((t) => <li key={t}>{t}</li>)}</ul>
      ) : (
        <p>Nothing cites, highlights or files the other copy, so it's simply removed.</p>
      )}
      <p className="muted">
        Each quote is found again in the copy kept; one that can't be is kept and marked to check. The other copy{other.doi || other.venue ? '' : ' (no DOI or journal)'} is then removed
        (you'll find it under Removed). Drafts can be undone from History; highlights, topics and matrix cells can't.
      </p>
      <div className="df-actions">
        <button className="primary" onClick={go} disabled={busy}>{busy ? 'Moving…' : 'Move and remove the other copy'}</button>
        <button onClick={() => setPlan(null)} disabled={busy}>Cancel</button>
      </div>
    </div>
  )
}
