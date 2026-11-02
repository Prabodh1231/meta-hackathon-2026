import { useEffect, useState } from 'react'
import { api } from '../api'

interface Props {
  /** What's happening: "Finding passages and writing…". A step the backend reports replaces it (`steps`). */
  label: string
  /** When the wait began (Date.now()); the timer counts from here, and Muse's notes are read from here on. */
  startedAt: number
  /** How long it usually takes, shown until something more useful is known. */
  usual?: string
  /** Show the backend's "Step 2 of 5: …" notes as the label (a proposal being written). */
  steps?: boolean
  onCancel?: () => void
  cancelTitle?: string
}

const LONG = 45 // seconds after which the wait is called longer than usual

/** A long AI wait that explains itself: a spinner, what's happening, the seconds waited, and Muse's
 * latest note (retrying after a rate limit, switching from Baseten to Meta's API, or which step of a
 * long job is running), read from GET /model/activity. Optionally a Cancel button. */
export function WaitStatus({ label, startedAt, usual, steps = false, onCancel, cancelTitle }: Props) {
  const [waited, setWaited] = useState(0)
  const [note, setNote] = useState<string | null>(null) // the latest retry or route switch
  const [step, setStep] = useState<string | null>(null) // the latest "Step n of m" note

  useEffect(() => {
    setWaited(0)
    setNote(null)
    setStep(null)
    const tick = window.setInterval(() => setWaited(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    const poll = window.setInterval(() => {
      api
        .modelActivity(startedAt / 1000)
        .then(({ events }) => {
          const last = (kinds: string[]) => [...events].reverse().find((e) => kinds.includes(e.kind))?.text ?? null
          setNote(last(['retry', 'switch']))
          if (steps) setStep(last(['stage']))
        })
        .catch(() => {}) // only an explanation: a failed poll changes nothing
    }, 1500)
    return () => {
      window.clearInterval(tick)
      window.clearInterval(poll)
    }
  }, [startedAt, steps])

  const hint = note ?? (waited < LONG ? usual : 'Taking longer than usual: Muse may be under load.') ?? null
  return (
    <div className="wait-status" role="status" aria-live="polite">
      <span className="wait-spin" aria-hidden="true" />
      <div>
        <b>
          {step ?? label} {waited} s
        </b>
        {hint && <p className={note ? 'wait-note' : 'muted'}>{hint}</p>}
      </div>
      {onCancel && (
        <button type="button" onClick={onCancel} title={cancelTitle}>
          Cancel
        </button>
      )}
    </div>
  )
}
