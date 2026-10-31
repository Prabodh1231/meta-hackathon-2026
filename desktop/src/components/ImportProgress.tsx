import { useState } from 'react'
import type { IngestFile, IngestJob } from '../types'

const STAGE: Record<IngestFile['stage'], string> = {
  '': 'Starting…',
  reading: 'Reading the file…',
  analysing: 'Muse is reading it…',
  filing: 'Filing into folders…',
}

const OWED: Record<string, string> = { metadata: 'details', title: 'title', summary: 'summary', tags: 'tags' }

/** "summary and tags": the parts of a source Muse couldn't produce yet. */
export function owedText(missing: string[]): string {
  const parts = [...new Set(missing.map((m) => OWED[m] ?? m))]
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? ''
}

function headline(j: IngestJob): string {
  const files = `${j.total} file${j.total === 1 ? '' : 's'}`
  if (j.state === 'queued' || j.state === 'listing') return 'Looking for files…'
  if (j.state === 'running') return `Adding ${files}`
  if (j.state === 'retrying') return 'Asking Muse again for what failed…'
  if (j.state === 'looking_up') return 'Looking the papers up in OpenAlex and Crossref…'
  if (j.state === 'failed') return 'The import stopped'
  if (j.state === 'cancelled') return `Stopped: added ${j.done} of ${files}`
  return j.failed ? `Added ${j.done} of ${files}` : `Added ${files}`
}

function FileRow({ f }: { f: IngestFile }) {
  const icon = { queued: '○', working: '', done: '✓', failed: '✕', skipped: '–' }[f.state]
  return (
    <li className={`ij-file ij-${f.state}`} title={f.source}>
      <span className="ij-icon" aria-hidden="true">{f.state === 'working' ? <span className="ij-spin" /> : icon}</span>
      <span className="ij-name">{f.title || f.name}</span>
      <span className="ij-status">
        {f.state === 'working' && STAGE[f.stage]}
        {f.state === 'queued' && 'Waiting'}
        {f.state === 'skipped' && 'Skipped'}
        {f.state === 'failed' && <span className="ij-error">{f.error}</span>}
        {f.state === 'done' && (f.missing.length ? <span className="ij-owed">no {owedText(f.missing)} yet</span> : 'Added')}
      </span>
    </li>
  )
}

/** One background import: overall progress, then each file's state. */
export function ImportProgress({ job, onCancel, onDismiss }: { job: IngestJob; onCancel: () => void; onDismiss: () => void }) {
  const finished = job.finished_at != null
  const settled = job.done + job.failed + job.skipped
  const pct = job.total ? Math.round((100 * settled) / job.total) : 0
  // Long imports start folded; failures are always worth seeing.
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? (job.total <= 6 || job.failed > 0)
  const waiting = job.files.filter((f) => f.state === 'queued').length
  const working = job.files.filter((f) => f.state === 'working').length
  const counts = [
    job.done && `${job.done} added`,
    job.failed && `${job.failed} failed`,
    !finished && working && `${working} in progress`,
    !finished && waiting && `${waiting} waiting`,
    job.skipped && `${job.skipped} skipped`,
  ].filter(Boolean)
  // Working files first while it runs, so what's happening is at the top.
  const order = { working: 0, failed: 1, queued: 2, done: 3, skipped: 4 }
  const files = finished ? job.files : [...job.files].sort((a, b) => order[a.state] - order[b.state])

  return (
    <section className={`ij${finished ? ' finished' : ''}${job.failed ? ' has-failed' : ''}`} aria-label="Import progress">
      <div className="ij-head">
        <div className="ij-title">
          <b>{headline(job)}</b>
          <span className="muted">
            {job.error ?? counts.join(' · ')}
            {finished && job.incomplete > 0 && ` · ${job.incomplete} without a summary yet`}
          </span>
        </div>
        {!finished && !job.cancelled && (
          <button className="link" onClick={onCancel} title="Files already being read finish; the rest are skipped">
            Stop
          </button>
        )}
        {finished && (
          <button className="icon" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        )}
      </div>
      <div className={`ij-bar${job.state === 'listing' || job.state === 'queued' || job.state === 'retrying' || job.state === 'looking_up' ? ' busy' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {job.files.length > 0 && (
        <>
          <button className="link ij-toggle" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
            {expanded ? 'Hide files' : `Show ${job.files.length} files`}
          </button>
          {expanded && (
            <ul className="ij-files">
              {files.map((f, i) => (
                <FileRow key={`${f.source}-${i}`} f={f} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
