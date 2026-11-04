import { useEffect, useMemo, useRef, useState } from 'react'
import { BackendUnreachable, api } from '../api'
import { markdownToHtml } from '../markdown'
import type { AskTurn } from '../types'
import { WaitStatus } from './WaitStatus'

// Starting points for an empty chat; clicking one fills the box to edit or send.
const EXAMPLES = [
  'Explain this concept in simple terms',
  'Make the paragraph I’m writing clearer',
  'Suggest a title for this chapter',
  'What are common critiques of this method?',
]

interface Props {
  draftId: number
  /** Text to ask about, from Ctrl+J or the toolbar's Ask button; `n` changes on every request. */
  attach: { text: string; n: number } | null
  /** The paragraph the cursor is in, for questions about "this paragraph". */
  getParagraph: () => string
  /** Put a reply (as HTML) into the draft at the cursor. */
  onInsert: (html: string) => void
  onError: (msg: string) => void
}

/** A plain chatbot beside the draft. It doesn't search the library: the Assistant writes from sources. */
export function AskPanel({ draftId, attach, getParagraph, onInsert, onError }: Props) {
  const [turns, setTurns] = useState<AskTurn[]>([])
  // The question being answered, since when (the wait line counts from it), and how to stop waiting.
  const [asking, setAsking] = useState<{ question: string; selection: string; at: number } | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const [question, setQuestion] = useState('')
  const [attached, setAttached] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const report = useRef(onError)
  report.current = onError

  useEffect(() => {
    let live = true
    setTurns([])
    setAsking(null)
    ;(async () => {
      // At launch the backend may not be listening yet: keep trying quietly, as the draft does.
      while (live) {
        try {
          const list = await api.askTurns(draftId)
          if (live) setTurns(list)
          return
        } catch (e) {
          if (!(e instanceof BackendUnreachable)) {
            if (live) report.current(e instanceof Error ? e.message : String(e))
            return
          }
          await new Promise((r) => setTimeout(r, 700))
        }
      }
    })()
    return () => {
      live = false
    }
  }, [draftId])

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
    const ctrl = new AbortController()
    controller.current = ctrl
    setAsking({ question: q, selection, at: Date.now() })
    setCancelled(false)
    setQuestion('')
    setAttached('')
    try {
      const turn = await api.ask(draftId, q, getParagraph(), selection, ctrl.signal)
      if (!ctrl.signal.aborted) setTurns((ts) => [...ts, turn])
    } catch (e) {
      if (ctrl.signal.aborted) return
      onError(e instanceof Error ? e.message : String(e))
      setQuestion(q) // to try again
      setAttached(selection)
    } finally {
      if (controller.current === ctrl) setAsking(null)
    }
  }

  function cancel() {
    if (!asking) return
    controller.current?.abort()
    setQuestion(asking.question) // back in the box, to edit or send again
    setAttached(asking.selection)
    setAsking(null)
    setCancelled(true)
  }

  async function clear() {
    try {
      await api.clearAsk(draftId)
      setTurns([])
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="ask">
      {turns.length > 0 && (
        <div className="row ask-top">
          <span className="muted" title="The Assistant tab writes from your sources, with every citation checked">
            Chat about this draft · general knowledge, <b>not checked against your library</b>
          </span>
          <button className="link" onClick={clear} disabled={!!asking}>
            Clear conversation
          </button>
        </div>
      )}

      {!turns.length && !asking && (
        <div className="ask-intro">
          <p className="muted">
            Chat with the AI about anything: ideas, explanations, wording. It answers from its own knowledge, not your library (the
            Assistant writes from your sources). Select text in the draft and press <kbd>Ctrl+J</kbd> to ask about it.
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
        <div key={t.id} className="ask-turn">
          <Question question={t.question} selection={t.selection} />
          <Reply text={t.reply} onInsert={onInsert} />
        </div>
      ))}

      {asking && (
        <div className="ask-turn">
          <Question question={asking.question} selection={asking.selection} />
          <WaitStatus
            label="Muse is answering…"
            startedAt={asking.at}
            usual="This usually takes 5 to 20 seconds."
            onCancel={cancel}
            cancelTitle="Stop waiting; your question goes back in the box"
          />
        </div>
      )}
      {cancelled && !asking && (
        <p className="muted wait-cancelled">Cancelled. If Muse still answers, the reply appears here the next time this chat loads.</p>
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
          placeholder={attached ? 'What do you want to know about it?' : turns.length ? 'Reply…' : 'Message the AI…'}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              ask(question)
            }
          }}
        />
        <div className="row">
          <span className="muted">Enter to send · Shift+Enter for a new line</span>
          <button className="primary" disabled={!!asking || !question.trim()}>
            {asking ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
      {/* After the question box, which stays at the bottom: scrolled to, a new reply shows in full above it. */}
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

function Reply({ text, onInsert }: { text: string; onInsert: (html: string) => void }) {
  const html = useMemo(() => markdownToHtml(text), [text])
  return (
    <div className="ask-a">
      {/* Safe: markdownToHtml escapes the reply before adding any markup. */}
      <div className="ask-md" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="ask-actions">
        <button onClick={() => onInsert(html)} title="Insert this reply into the draft at the cursor">
          Insert into draft
        </button>
      </div>
    </div>
  )
}
