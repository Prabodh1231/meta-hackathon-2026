import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../useFocusTrap'

/** What to ask: a question, what goes and what stays, and the button named for what it does. */
export interface ConfirmAsk {
  title: string // "Remove the sample library?"
  body: string // what goes and what stays
  verb: string // "Remove samples": the button that goes ahead
  danger?: boolean // it deletes something: the button is red
}

/** The app's own "are you sure?", in place of window.confirm (the system's message box, with OK / Cancel
 * and the app's name for a title). `ask` resolves true when the writer goes ahead; render `dialog`. */
export function useConfirm(): [ask: (q: ConfirmAsk) => Promise<boolean>, dialog: ReactNode] {
  const [open, setOpen] = useState<(ConfirmAsk & { answer: (ok: boolean) => void }) | null>(null)
  const ask = useCallback((q: ConfirmAsk) => new Promise<boolean>((answer) => setOpen({ ...q, answer })), [])
  const done = (ok: boolean) => {
    open?.answer(ok)
    setOpen(null)
  }
  return [ask, open ? <ConfirmDialog ask={open} onDone={done} /> : null]
}

function ConfirmDialog({ ask, onDone }: { ask: ConfirmAsk; onDone: (ok: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null)
  useFocusTrap(box)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  // Esc is Cancel, and goes no further (it would close what's behind the dialog too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      doneRef.current(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone(false)}>
      <div ref={box} className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <h2 id="confirm-title">{ask.title}</h2>
        <p id="confirm-body">{ask.body}</p>
        <div className="confirm-acts">
          {/* Cancel first, and focused: Enter on a dialog that just appeared shouldn't delete anything */}
          <button autoFocus onClick={() => onDone(false)}>
            Cancel
          </button>
          <button className={ask.danger ? 'danger' : 'primary'} onClick={() => onDone(true)}>
            {ask.verb}
          </button>
        </div>
      </div>
    </div>
  )
}
