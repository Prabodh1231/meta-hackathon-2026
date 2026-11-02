import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Citation, DraftSentence } from '../types'
import { StatusBadge } from './StatusBadge'

// Starting points that work with any library; clicking one fills the box to edit or send.
const EXAMPLES = [
  'Summarize the main findings across my sources',
  'Write an introduction paragraph for this chapter',
  'Compare the methods my sources use',
  'List the open questions my sources raise',
]

interface Props {
  scope: number[]
  /** How many passages to draft from (Settings). */
  passages: number
  sourceCount: number
  onChooseSources: () => void
  getContext: () => string
  onInsert: (sentences: DraftSentence[]) => void
  onVerified: (cid: string, result: Citation) => void
  onOpenCitation: (c: Citation) => void
  onError: (msg: string) => void
}

let nextCid = 0

/** What the wait says, from how long it has run and what Muse reported (a retry, a switch of route). */
function waitText(seconds: number, note: string | null): string {
  if (note) return note
  if (seconds < 45) return 'This usually takes 10 to 30 seconds.'
  return 'Taking longer than usual: Muse may be under load. You can keep waiting or cancel.'
}

export function AssistantPanel({ scope, passages, sourceCount, onChooseSources, getContext, onInsert, onVerified, onOpenCitation, onError }: Props) {
  const [instruction, setInstruction] = useState('')
  const [sentences, setSentences] = useState<DraftSentence[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set()) // sentences ticked for inserting
  // While drafting: when it started, seconds waited, Muse's latest note; and how to stop waiting.
  const [startedAt, setStartedAt] = useState(0)
  const [waited, setWaited] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const controller = useRef<AbortController | null>(null)

  // Count the seconds, and ask the backend now and then whether Muse is retrying or switched route.
  useEffect(() => {
    if (!busy) return
    const tick = window.setInterval(() => setWaited(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    const poll = window.setInterval(() => {
      api
        .modelActivity(startedAt / 1000)
        .then((a) => a.events.length && setNote(a.events[a.events.length - 1].text))
        .catch(() => {}) // only an explanation: a failed poll changes nothing
    }, 1500)
    return () => {
      window.clearInterval(tick)
      window.clearInterval(poll)
    }
  }, [busy, startedAt])

  function cancel() {
    controller.current?.abort()
    setBusy(false)
    setCancelled(true)
  }

  const toggle = (i: number) =>
    setPicked((p) => {
      const n = new Set(p)
      n.has(i) ? n.delete(i) : n.add(i)
      return n
    })

  async function draft() {
    const ctrl = new AbortController()
    controller.current = ctrl
    setBusy(true)
    setStartedAt(Date.now())
    setWaited(0)
    setNote(null)
    setCancelled(false)
    setSentences(null)
    setPicked(new Set())
    try {
      const res = await api.draft(instruction.trim(), getContext(), scope.length ? scope : null, passages, ctrl.signal)
      if (ctrl.signal.aborted) return
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
      if (!ctrl.signal.aborted) onError(e instanceof Error ? e.message : String(e))
    } finally {
      if (controller.current === ctrl) setBusy(false) // a newer draft may have started since
    }
  }

  const flagged = sentences?.filter(
    (s) => s.citations.length === 0 || s.citations.every((c) => c.status !== 'verified' && c.status !== 'pending'),
  ).length

  if (sourceCount === 0) {
    return (
      <div className="assistant">
        <div className="lib-empty">
          <div className="lib-empty-title">Add sources first</div>
          <p>The Assistant only writes from your own sources, and quotes them for every sentence. Add a few papers or notes to start.</p>
          <button className="primary" onClick={onChooseSources}>Add sources</button>
        </div>
      </div>
    )
  }

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
        {!instruction && !sentences && (
          <div className="examples" aria-label="Examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="example" onClick={() => setInstruction(ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}
        <div className="row">
          <span className="muted">
            {scope.length ? `From ${scope.length} chosen source${scope.length === 1 ? '' : 's'}` : `From all ${sourceCount} sources`} ·{' '}
            <button type="button" className="link" onClick={onChooseSources}>
              {scope.length ? 'Change' : 'Choose sources'}
            </button>
          </span>
          <button className="primary" disabled={busy || !instruction.trim()}>
            {busy ? 'Drafting…' : 'Draft with citations'}
          </button>
        </div>
      </form>

      {busy && (
        <div className="assist-wait" role="status" aria-live="polite">
          <span className="assist-spin" aria-hidden="true" />
          <div>
            <b>Finding passages and writing… {waited} s</b>
            <p className={note ? 'assist-note' : 'muted'}>{waitText(waited, note)}</p>
          </div>
          <button type="button" onClick={cancel} title="Stop waiting. Muse may still finish in the background; nothing is inserted.">
            Cancel
          </button>
        </div>
      )}
      {cancelled && !busy && <p className="muted assist-cancelled">Cancelled. Nothing was added to your draft.</p>}

      {sentences && sentences.length === 0 && (
        <p className="empty">Nothing in the library supports this yet. Try adding sources or rephrasing.</p>
      )}

      {sentences && sentences.length > 0 && (
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
      )}
    </div>
  )
}
