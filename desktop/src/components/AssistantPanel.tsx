import { useRef, useState } from 'react'
import { api } from '../api'
import type { Citation, DraftSentence } from '../types'
import { DraftPreview, verifyAll, withCids } from './DraftPreview'
import { WaitStatus } from './WaitStatus'

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

export function AssistantPanel({ scope, passages, sourceCount, onChooseSources, getContext, onInsert, onVerified, onOpenCitation, onError }: Props) {
  const [instruction, setInstruction] = useState('')
  const [sentences, setSentences] = useState<DraftSentence[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [draftNo, setDraftNo] = useState(0) // a new draft starts with nothing ticked
  // While drafting: when it started (the wait line counts from it), and how to stop waiting.
  const [startedAt, setStartedAt] = useState(0)
  const [cancelled, setCancelled] = useState(false)
  const controller = useRef<AbortController | null>(null)

  function cancel() {
    controller.current?.abort()
    setBusy(false)
    setCancelled(true)
  }

  async function draft() {
    const ctrl = new AbortController()
    controller.current = ctrl
    setBusy(true)
    setStartedAt(Date.now())
    setCancelled(false)
    setSentences(null)
    setDraftNo((n) => n + 1)
    try {
      const res = await api.draft(instruction.trim(), getContext(), scope.length ? scope : null, passages, ctrl.signal)
      if (ctrl.signal.aborted) return
      const withIds = withCids(res.sentences)
      setSentences(withIds)
      // Show the draft immediately, then check each citation in the background.
      verifyAll(withIds, setSentences, onVerified, onError)
    } catch (e) {
      if (!ctrl.signal.aborted) onError(e instanceof Error ? e.message : String(e))
    } finally {
      if (controller.current === ctrl) setBusy(false) // a newer draft may have started since
    }
  }

  if (sourceCount === 0) {
    return (
      <div className="assistant">
        <div className="lib-empty">
          <div className="lib-empty-title">Add sources first</div>
          <p>Muse writes only from your own sources here, and quotes them for every sentence. Add a few papers or notes to start.</p>
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
          <button className="primary" disabled={busy || !instruction.trim()} aria-describedby={!busy && !instruction.trim() ? 'draft-needs' : undefined}>
            {busy ? 'Drafting…' : 'Draft with citations'}
          </button>
        </div>
        {!busy && !instruction.trim() && (
          <p id="draft-needs" className="hint draft-needs">
            Type a request or pick a suggestion to draft.
          </p>
        )}
      </form>

      {busy && (
        <WaitStatus
          label="Finding passages and writing…"
          startedAt={startedAt}
          usual="This usually takes 10 to 30 seconds."
          onCancel={cancel}
          cancelTitle="Stop waiting. Muse may still finish in the background; nothing is inserted."
        />
      )}
      {cancelled && !busy && <p className="muted wait-cancelled">Cancelled. Nothing was added to your draft.</p>}

      {sentences && sentences.length === 0 && (
        <p className="empty">Nothing in the library supports this yet. Try adding sources or rephrasing.</p>
      )}

      {sentences && sentences.length > 0 && (
        <DraftPreview key={draftNo} sentences={sentences} onInsert={onInsert} onOpenCitation={onOpenCitation} />
      )}
    </div>
  )
}
