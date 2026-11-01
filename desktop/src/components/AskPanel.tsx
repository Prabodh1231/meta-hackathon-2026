import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { AskTurn, Citation, DraftSentence } from '../types'
import { StatusBadge } from './StatusBadge'

// Starting points for an empty conversation; clicking one fills the box to edit or send.
const EXAMPLES = [
  'Which findings in my sources disagree?',
  'What methods do my sources use?',
  'Is the paragraph I’m writing backed by my sources?',
  'What do my sources leave unanswered?',
]

const STATUS_WORDS: Record<Citation['status'], string> = {
  pending: 'checking',
  verified: 'verified',
  weak: 'partial support',
  unsupported: 'unsupported',
  quote_not_found: 'quote not found',
}

interface Props {
  draftId: number
  scope: number[]
  /** How many passages to read for an answer (Settings, shared with the Assistant). */
  passages: number
  sourceCount: number
  /** Text to ask about, from Ctrl+J or the toolbar's Ask button; `n` changes on every request. */
  attach: { text: string; n: number } | null
  onChooseSources: () => void
  /** The paragraph the cursor is in, for questions about "this paragraph". */
  getParagraph: () => string
  onInsert: (sentences: DraftSentence[]) => void
  onVerified: (cid: string, result: Citation) => void
  onOpenCitation: (c: Citation) => void
  onError: (msg: string) => void
}

let nextCid = 0

/** Give each citation an id the editor can find it by, if it's inserted before its check ends. */
function withCids(turn: AskTurn): AskTurn {
  return {
    ...turn,
    sentences: turn.sentences.map((s) => ({ ...s, citations: s.citations.map((c) => ({ ...c, cid: `a${Date.now()}-${nextCid++}` })) })),
  }
}

export function AskPanel({ draftId, scope, passages, sourceCount, attach, onChooseSources, getParagraph, onInsert, onVerified, onOpenCitation, onError }: Props) {
  const [turns, setTurns] = useState<AskTurn[]>([])
  const [asking, setAsking] = useState<{ question: string; selection: string } | null>(null)
  const [question, setQuestion] = useState('')
  const [attached, setAttached] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const report = useRef({ onVerified, onError })
  report.current = { onVerified, onError }

  /** Check an answer's citations in the background, then keep the results with the draft. */
  function check(turn: AskTurn) {
    const pending = turn.sentences.flatMap((s) => s.citations.filter((c) => c.status === 'pending').map((c) => ({ s, c })))
    if (!pending.length) return
    const results = new Map<string, Citation>()
    Promise.all(
      pending.map(({ s, c }) =>
        api
          .verify(s.text, c.chunk_id, c.quote)
          .then((v) => {
            const checked = { ...v, cid: c.cid }
            results.set(c.cid!, checked)
            setTurns((ts) =>
              ts.map((t) =>
                t.id !== turn.id ? t : { ...t, sentences: t.sentences.map((st) => ({ ...st, citations: st.citations.map((cc) => (cc.cid === c.cid ? checked : cc)) })) },
              ),
            )
            report.current.onVerified(c.cid!, v)
          })
          .catch((e) => report.current.onError(`Verification failed: ${e instanceof Error ? e.message : e}`)),
      ),
    ).then(() => {
      if (!results.size) return
      // Kept without the cids: those are this session's, given afresh when the answers load.
      const sentences = turn.sentences.map((s) => ({
        ...s,
        citations: s.citations.map((c) => ({ ...(results.get(c.cid!) ?? c), cid: undefined })),
      }))
      api.saveAskAnswer(turn.id, sentences).catch(() => {}) // only a cache: checked again next time if lost
    })
  }

  useEffect(() => {
    let live = true
    setTurns([])
    setAsking(null)
    api
      .askTurns(draftId)
      .then((list) => {
        if (!live) return
        const loaded = list.map(withCids)
        setTurns(loaded)
        loaded.forEach(check) // any left unchecked when the app last closed
      })
      .catch((e) => report.current.onError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [draftId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!attach) return
    if (attach.text) setAttached(attach.text)
    box.current?.focus()
  }, [attach])

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [turns.length, asking])

  async function ask(text: string) {
    const q = text.trim()
    if (!q || asking) return
    const selection = attached
    setAsking({ question: q, selection })
    setQuestion('')
    setAttached('')
    const forDraft = draftId
    try {
      const turn = withCids(await api.ask(forDraft, q, getParagraph(), selection, scope.length ? scope : null, passages))
      setTurns((ts) => [...ts, turn])
      check(turn)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      setQuestion(q) // to try again
      setAttached(selection)
    } finally {
      setAsking(null)
    }
  }

  async function clear() {
    try {
      await api.clearAsk(draftId)
      setTurns([])
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const last = turns[turns.length - 1]

  return (
    <div className="ask">
      {turns.length > 0 && (
        <div className="row ask-top">
          <span className="muted">{turns.length === 1 ? '1 question' : `${turns.length} questions`} about this draft</span>
          <button className="link" onClick={clear} disabled={!!asking}>
            Clear conversation
          </button>
        </div>
      )}

      {!turns.length && !asking && (
        <div className="ask-intro">
          <p className="muted">
            Ask anything while you write. Answers come from your sources, each sentence with a checked quote; anything your sources
            don’t cover is answered from general knowledge and marked as such. Select text in the draft and press <kbd>Ctrl+J</kbd> to ask
            about it.
          </p>
          <div className="examples" aria-label="Examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="example" onClick={() => setQuestion(ex)}>
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {turns.map((t) => (
        <Answer
          key={t.id}
          turn={t}
          followups={t === last && !asking ? t.followups : []}
          onAsk={ask}
          onInsert={onInsert}
          onOpenCitation={onOpenCitation}
        />
      ))}

      {asking && (
        <div className="ask-turn">
          <Question question={asking.question} selection={asking.selection} />
          <p className="ask-thinking muted">Reading your sources…</p>
        </div>
      )}

      <form
        className="ask-compose"
        onSubmit={(e) => {
          e.preventDefault()
          ask(question)
        }}
      >
        {attached && (
          <div className="ask-attached">
            <span className="ask-attached-label">About</span>
            <span className="ask-attached-text">“{attached}”</span>
            <button type="button" className="link" onClick={() => setAttached('')} aria-label="Don’t ask about the selected text" title="Remove">
              ×
            </button>
          </div>
        )}
        <textarea
          ref={box}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={attached ? 'What do you want to know about it?' : turns.length ? 'Ask a follow-up…' : 'Ask a question…'}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              ask(question)
            }
          }}
        />
        <div className="row">
          <span className="muted">
            {sourceCount === 0 ? (
              <>
                No sources yet: general knowledge only ·{' '}
                <button type="button" className="link" onClick={onChooseSources}>
                  Add sources
                </button>
              </>
            ) : (
              <>
                {scope.length ? `From ${scope.length} chosen source${scope.length === 1 ? '' : 's'}` : `From all ${sourceCount} sources`} ·{' '}
                <button type="button" className="link" onClick={onChooseSources}>
                  {scope.length ? 'Change' : 'Choose sources'}
                </button>
              </>
            )}
          </span>
          <button className="primary" disabled={!!asking || !question.trim()} title="Ask (Enter); Shift+Enter for a new line">
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </form>
      {/* After the question box, which stays at the bottom: scrolled to, a new answer shows in full above it. */}
      <div ref={end} />
    </div>
  )
}

function Question({ question, selection }: { question: string; selection: string }) {
  return (
    <div className="ask-q">
      {selection && <blockquote className="ask-q-sel">{selection}</blockquote>}
      <p>{question}</p>
    </div>
  )
}

function Answer({
  turn,
  followups,
  onAsk,
  onInsert,
  onOpenCitation,
}: {
  turn: AskTurn
  followups: string[]
  onAsk: (q: string) => void
  onInsert: (sentences: DraftSentence[]) => void
  onOpenCitation: (c: Citation) => void
}) {
  // One number per citation, in reading order, as in a reference list.
  let n = 0
  const numbered = turn.sentences.map((s) => ({ ...s, nums: s.citations.map(() => ++n) }))
  const sources = numbered.flatMap((s) => s.citations.map((c, i) => ({ c, num: s.nums[i] })))
  const empty = !turn.sentences.length && !turn.general

  return (
    <div className="ask-turn">
      <Question question={turn.question} selection={turn.selection} />
      <div className="ask-a">
        {turn.sentences.length > 0 && (
          <p className="ask-sourced">
            {numbered.map((s, i) => (
              <span key={i}>
                {s.text}
                {s.citations.map((c, j) => (
                  <button
                    key={c.cid ?? j}
                    className={`ask-num ask-num-${c.status}`}
                    onClick={() => onOpenCitation(c)}
                    title={`${c.label}: ${STATUS_WORDS[c.status]}${c.reason ? `. ${c.reason}` : ''}`}
                  >
                    {s.nums[j]}
                  </button>
                ))}{' '}
              </span>
            ))}
          </p>
        )}
        {sources.length > 0 && (
          <ol className="ask-sources">
            {sources.map(({ c, num }) => (
              <li key={num}>
                <button className="cite-row" onClick={() => onOpenCitation(c)} title="Show the quote on its page">
                  <span className="ask-src-num">{num}</span>
                  <span>{c.label}</span>
                  <StatusBadge status={c.status} />
                </button>
              </li>
            ))}
          </ol>
        )}
        {turn.general && (
          <div className="ask-general">
            <div className="ask-general-head">
              <span>Not from your sources</span>
              <button
                className="link"
                onClick={() => onInsert([{ text: turn.general, citations: [] }])}
                title="Insert this part into the draft at the cursor, without a citation"
              >
                Insert anyway
              </button>
            </div>
            <p>{turn.general}</p>
          </div>
        )}
        {empty && <p className="muted">No answer came back. Try rephrasing the question.</p>}
        {turn.sentences.length > 0 && (
          <div className="ask-actions">
            <button onClick={() => onInsert(turn.sentences)} title="Insert the sourced answer into the draft at the cursor, with its citations">
              Insert into draft
            </button>
          </div>
        )}
      </div>
      {followups.length > 0 && (
        <div className="examples ask-followups" aria-label="Follow-up questions">
          {followups.map((f) => (
            <button key={f} type="button" className="example" onClick={() => onAsk(f)}>
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
