import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Finding } from '../types'
import type { ChipAttrs } from './WritingEditor'
import { ago } from './Meters'

interface Props {
  /** The clicked citation, kept up to date as checks come back. */
  chip: ChipAttrs
  onCheck: (how: 'matrix' | 'quote') => Promise<void>
  onOpenMatrix: (id: number) => void
  /** Show the citation's quote on its page (passages written from the matrix have one; gaps don't). */
  onViewQuote: () => void
}

const HEADLINE: Record<ChipAttrs['status'], string> = {
  pending: 'Checking against the matrix…',
  verified: 'Your review matrix supports this',
  weak: 'The matrix only partly supports this',
  unsupported: "The matrix doesn't support this",
  quote_not_found: "The quote wasn't found in the paper",
}

/** A citation written from a review matrix: the gap or passage it came from, the matrix rows
 * behind it, and checking it again, against the matrix or (with a warning) against one quote. */
export function FindingView({ chip, onCheck, onOpenMatrix, onViewQuote }: Props) {
  const [finding, setFinding] = useState<Finding | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmQuote, setConfirmQuote] = useState(false)

  useEffect(() => {
    let live = true
    setFinding(null)
    setMissing(false)
    setConfirmQuote(false)
    if (chip.finding == null) return
    api
      .finding(chip.finding)
      .then((f) => live && setFinding(f))
      .catch(() => live && setMissing(true))
    return () => {
      live = false
    }
  }, [chip.finding, chip.cid])

  async function check(how: 'matrix' | 'quote') {
    setConfirmQuote(false)
    setBusy(true)
    try {
      await onCheck(how)
      if (how === 'matrix' && chip.finding != null) setFinding(await api.finding(chip.finding)) // "changed" may have moved
    } finally {
      setBusy(false)
    }
  }

  const status = busy ? 'pending' : chip.status
  const gap = finding?.kind === 'gap'
  const studies = finding?.snapshot.length ?? 0

  return (
    <div className="finding-view">
      <div className={`cite-head finding-head finding-head-${status}`}>
        <span className={`cite cite-${status} cite-matrix`}>{chip.label}</span>
        <b>{HEADLINE[status]}</b>
      </div>
      {chip.reason && status !== 'pending' && <p className="reason">{chip.reason}</p>}
      <blockquote className="cite-claim">{chip.claim}</blockquote>

      {missing && (
        <p className="warn">
          The matrix finding this came from was deleted, so it can't be checked against the matrix any more.
          {chip.quote ? ' You can still check it against its quote.' : ''}
        </p>
      )}

      {finding && (
        <section className="finding-source">
          <h4 className="eyebrow">
            {gap ? 'Gap' : 'Written from the matrix'} · {finding.matrix_name} · {ago(finding.created_at)}
          </h4>
          {gap ? (
            <p>
              <b>{finding.title}</b> {finding.text}
            </p>
          ) : (
            <p className="finding-passage">
              {finding.sentences.map((s, i) => (
                <span key={i} className={norm(s.text) === norm(chip.claim) ? 'finding-this' : ''}>
                  {s.text}{' '}
                </span>
              ))}
            </p>
          )}
          {!finding.matrix_exists && (
            <p className="warn">The matrix was deleted. Checks use the copy of its rows kept with this finding.</p>
          )}
          {finding.matrix_exists && finding.matrix_changed && (
            <p className="warn">The matrix has changed since this was written. A check uses the matrix as it is now.</p>
          )}
          <details className="finding-rows">
            <summary>
              Rests on {studies} {studies === 1 ? 'study' : 'studies'}
              {gap ? ', all cited' : ''}
            </summary>
            <ul>
              {finding.snapshot.map((r) => (
                <li key={r.doc_id}>
                  <b>{r.label}</b>
                  {r.values.map((v) => (
                    <div key={v.key} className="finding-value">
                      <span className="muted">{v.label}:</span> {v.value || <i className="muted">not reported</i>}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      {confirmQuote && (
        <div className="finding-warn" role="alertdialog" aria-label="Check against one quote">
          <p>
            This sentence was written from the whole matrix and may compare several studies. Checking it against one
            passage will probably show weak or no support, even when the sentence is right.
          </p>
          <div className="row">
            <button onClick={() => check('quote')}>Check against the quote anyway</button>
            <button className="link" onClick={() => setConfirmQuote(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="cite-foot">
        <div className="row">
          <button className="primary" onClick={() => check('matrix')} disabled={busy || missing}>
            {busy ? 'Checking…' : 'Check against the matrix'}
          </button>
          {finding?.matrix_exists && finding.matrix_id != null && (
            <button onClick={() => onOpenMatrix(finding.matrix_id!)}>Open matrix</button>
          )}
        </div>
        {chip.quote && (
          <div className="row">
            <button className="link" onClick={onViewQuote}>
              View quote
            </button>
            <button className="link" onClick={() => setConfirmQuote(true)} disabled={busy}>
              Check against the quote…
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
