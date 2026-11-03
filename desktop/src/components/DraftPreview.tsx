import { useState } from 'react'
import { api } from '../api'
import type { Citation, DraftSentence } from '../types'
import { StatusBadge } from './StatusBadge'

let nextCid = 0

/** Give each citation a client-side id, so its verification can find it (and its chip) later. */
export function withCids(sentences: DraftSentence[]): DraftSentence[] {
  return sentences.map((s) => ({ ...s, citations: s.citations.map((c) => ({ ...c, cid: `c${Date.now()}-${nextCid++}` })) }))
}

/** Check each pending citation in the background, updating the preview (and any inserted chip) as
 * each answer comes back, so the draft shows at once. */
export function verifyAll(
  sentences: DraftSentence[],
  update: (fn: (cur: DraftSentence[] | null) => DraftSentence[] | null) => void,
  onVerified: (cid: string, result: Citation) => void,
  onError: (msg: string) => void,
) {
  for (const s of sentences) {
    for (const c of s.citations) {
      if (c.status !== 'pending') continue
      api
        .verify(s.text, c.chunk_id, c.quote)
        .then((v) => {
          update(
            (cur) =>
              cur?.map((cs) => ({ ...cs, citations: cs.citations.map((cc) => (cc.cid === c.cid ? { ...v, cid: c.cid } : cc)) })) ?? cur,
          )
          onVerified(c.cid!, v)
        })
        .catch((e) => onError(`Verification failed: ${e instanceof Error ? e.message : e}`))
    }
  }
}

/** Drafted sentences to tick and insert, each with its citations' status. Give it a new `key` for
 * each new draft, so nothing stays ticked from the last one. */
export function DraftPreview({ sentences, onInsert, onOpenCitation }: {
  sentences: DraftSentence[]
  onInsert: (sentences: DraftSentence[]) => void
  onOpenCitation: (c: Citation) => void
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set()) // sentences ticked for inserting

  const toggle = (i: number) =>
    setPicked((p) => {
      const n = new Set(p)
      n.has(i) ? n.delete(i) : n.add(i)
      return n
    })

  const flagged = sentences.filter(
    (s) => s.citations.length === 0 || s.citations.every((c) => c.status !== 'verified' && c.status !== 'pending'),
  ).length

  return (
    <div className="draft-preview">
      <div className="row">
        <strong>Draft</strong>
        {!!flagged && <span className="warn">{flagged} sentence(s) need attention</span>}
      </div>
      <p className="muted draft-hint">Tick the sentences you want, then insert them. Click a citation to see its quote.</p>
      {sentences.map((s, i) => (
        <div key={i} className={`draft-sentence${picked.has(i) ? ' picked' : ''}`}>
          <label className="draft-pick">
            <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} />
            <p>{s.text}</p>
          </label>
          <div className="draft-cites">
            {s.citations.length === 0 && <StatusBadge status="unsupported" text="no citation" />}
            {s.citations.map((c) => (
              <button key={c.cid} className="cite-row" onClick={() => onOpenCitation(c)} title={c.reason}>
                <StatusBadge status={c.status} />
                <span>{c.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="row draft-actions">
        <button className="link" onClick={() => setPicked(picked.size === sentences.length ? new Set() : new Set(sentences.map((_, i) => i)))}>
          {picked.size === sentences.length ? 'Select none' : 'Select all'}
        </button>
        <button
          className="primary"
          disabled={!picked.size}
          onClick={() => {
            // In the draft's order, whatever order they were ticked in.
            onInsert(sentences.filter((_, i) => picked.has(i)))
            setPicked(new Set())
          }}
        >
          {picked.size ? `Insert ${picked.size} selected` : 'Tick sentences to insert'}
        </button>
      </div>
    </div>
  )
}
