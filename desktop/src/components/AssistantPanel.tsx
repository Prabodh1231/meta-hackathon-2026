import { useState } from 'react'
import { api } from '../api'
import type { Citation, DraftSentence } from '../types'
import { StatusBadge } from './StatusBadge'

interface Props {
  scope: number[]
  getContext: () => string
  onInsert: (sentences: DraftSentence[]) => void
  onVerified: (cid: string, result: Citation) => void
  onOpenCitation: (c: Citation) => void
  onError: (msg: string) => void
}

let nextCid = 0

export function AssistantPanel({ scope, getContext, onInsert, onVerified, onOpenCitation, onError }: Props) {
  const [instruction, setInstruction] = useState('')
  const [sentences, setSentences] = useState<DraftSentence[] | null>(null)
  const [busy, setBusy] = useState(false)

  async function draft() {
    setBusy(true)
    setSentences(null)
    try {
      const res = await api.draft(instruction.trim(), getContext(), scope.length ? scope : null)
      const withIds = res.sentences.map((s) => ({
        ...s,
        citations: s.citations.map((c) => ({ ...c, cid: `c${Date.now()}-${nextCid++}` })),
      }))
      setSentences(withIds)
      // Show the draft immediately, then check each citation in the background.
      for (const s of withIds) {
        for (const c of s.citations) {
          if (c.status !== 'pending') continue
          api
            .verify(s.text, c.chunk_id, c.quote)
            .then((v) => {
              setSentences((cur) =>
                cur?.map((cs) => ({
                  ...cs,
                  citations: cs.citations.map((cc) => (cc.cid === c.cid ? { ...v, cid: c.cid } : cc)),
                })) ?? cur,
              )
              onVerified(c.cid!, v)
            })
            .catch((e) => onError(`Verification failed: ${e instanceof Error ? e.message : e}`))
        }
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const flagged = sentences?.filter(
    (s) => s.citations.length === 0 || s.citations.every((c) => c.status !== 'verified' && c.status !== 'pending'),
  ).length

  return (
    <div className="assistant">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (instruction.trim()) draft()
        }}
      >
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="What should I write? e.g. “Summarize the evidence that sleep spindles predict memory consolidation.”"
          rows={4}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && instruction.trim()) draft()
          }}
        />
        <div className="row">
          <span className="muted">{scope.length ? `Using ${scope.length} selected docs` : 'Using whole library'}</span>
          <button className="primary" disabled={busy || !instruction.trim()}>
            {busy ? 'Drafting…' : 'Draft with citations'}
          </button>
        </div>
      </form>

      {sentences && sentences.length === 0 && (
        <p className="empty">Nothing in the library supports this yet. Try adding sources or rephrasing.</p>
      )}

      {sentences && sentences.length > 0 && (
        <div className="draft-preview">
          <div className="row">
            <strong>Draft</strong>
            {!!flagged && <span className="warn">{flagged} sentence(s) need attention</span>}
            <button className="primary" onClick={() => onInsert(sentences)}>Insert into document</button>
          </div>
          {sentences.map((s, i) => (
            <div key={i} className="draft-sentence">
              <p>{s.text}</p>
              {s.citations.length === 0 && <StatusBadge status="unsupported" text="no citation" />}
              {s.citations.map((c) => (
                <button key={c.cid} className="cite-row" onClick={() => onOpenCitation(c)} title={c.reason}>
                  <StatusBadge status={c.status} />
                  <span>{c.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
