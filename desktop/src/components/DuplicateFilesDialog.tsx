import { useEffect, useState } from 'react'
import { api } from '../api'
import type { DuplicateDoc, DuplicateGroup, DuplicateKind, FileDuplicateReport } from '../types'

const KIND_ORDER: DuplicateKind[] = ['exact_file', 'same_text', 'likely_same', 'similar']
const SHORT: Record<DuplicateKind, string> = {
  exact_file: 'Exact file duplicate',
  same_text: 'Same text detected',
  likely_same: 'Likely same paper/version',
  similar: 'Similar paper',
}

export function formatBytes(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function byline(d: DuplicateDoc): string {
  const who = d.authors.length > 2 ? `${d.authors[0]} et al.` : d.authors.join(' & ')
  return [who, d.year, d.venue].filter(Boolean).join(' · ')
}

interface Props {
  getCited: () => number[] // documents the draft cites
  onChanged: () => Promise<void> // the library changed: reload it
  onClose: () => void
  onError: (msg: string) => void
}

type Pending = { id: number; action: 'trash' | 'remove' }

/** Finds duplicate files in the library and recommends cleanup. Nothing is removed unless the
 * user picks a file and confirms; files go to the Recycle Bin / Trash, never deleted outright. */
export function DuplicateFilesDialog({ getCited, onChanged, onClose, onError }: Props) {
  const [report, setReport] = useState<FileDuplicateReport | null>(null)
  const [busy, setBusy] = useState<string | null>('Checking your library…')
  const [filter, setFilter] = useState<DuplicateKind | 'all'>('all')
  const [pending, setPending] = useState<Pending | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const canTrash = !!window.rc?.trashFile

  async function scan() {
    setBusy('Checking your library…')
    try {
      setReport(await api.duplicateFiles(getCited()))
    } catch (e) {
      onError(`Duplicate check failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    scan()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function act(d: DuplicateDoc, action: Pending['action'], g: DuplicateGroup) {
    setPending(null)
    // The copy it duplicates: the one suggested to keep, or another when that's the one removed.
    const original = d.id !== g.keep ? g.keep : g.docs.find((x) => x.id !== d.id)?.id
    setBusy(action === 'trash' ? 'Moving to the Recycle Bin…' : 'Removing from the library…')
    try {
      // The file goes first: if that fails, the library entry stays and nothing is lost.
      if (action === 'trash') await window.rc!.trashFile!(d.source)
      await api.deleteDocument(d.id, { reason: 'duplicate', duplicateOf: original, trashed: action === 'trash' })
      setDone(
        action === 'trash'
          ? `Moved “${d.title}” to the Recycle Bin and removed it from your library.`
          : `Removed “${d.title}” from your library. The file is still at ${d.source}.`,
      )
      await onChanged()
    } catch (e) {
      onError(`${action === 'trash' ? 'Could not move the file' : 'Could not remove it'}: ${e instanceof Error ? e.message : e}`)
    }
    await scan()
  }

  const groups = report?.groups.filter((g) => filter === 'all' || g.kind === filter) ?? []
  const total = report?.groups.length ?? 0

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dupfiles" role="dialog" aria-modal="true" aria-labelledby="dupfiles-title">
        <header className="modal-head">
          <div>
            <h2 id="dupfiles-title">Duplicate files</h2>
            <span className="muted">Suggestions only. Nothing is removed unless you choose a file and confirm.</span>
          </div>
          <span className="spacer" />
          <button onClick={scan} disabled={!!busy}>Scan again</button>
          <button className="icon" onClick={onClose} aria-label="Close duplicate files">×</button>
        </header>

        {report && (
          <section className="df-summary">
            <div className="df-stat">
              <b>{formatBytes(report.recoverable.identical)}</b>
              <span>recoverable from identical files</span>
            </div>
            <div className="df-stat">
              <b>{formatBytes(report.recoverable.likely_same)}</b>
              <span>more if you also remove likely duplicates</span>
            </div>
            <div className="df-stat">
              <b>{total}</b>
              <span>group{total === 1 ? '' : 's'} to review</span>
            </div>
            <p className="muted df-scope">
              Checked {report.scanned} document{report.scanned === 1 ? '' : 's'}: {report.files} file{report.files === 1 ? '' : 's'} on disk
              {report.web > 0 && `, ${report.web} web page${report.web === 1 ? '' : 's'} (compared by text only)`}
              {report.missing > 0 && `, ${report.missing} whose file is missing`}
              {report.no_text > 0 && `, ${report.no_text} with too little text to compare`}. A paper filed in several folders is one
              file, so it's never listed as a duplicate of itself.
              {!canTrash && ' Moving files to the Recycle Bin works in the desktop app; here you can only remove them from the library.'}
            </p>
          </section>
        )}

        {busy && (
          <div className="lib-busy" role="status">
            <span className="bar" />
            {busy}
          </div>
        )}
        {done && (
          <p className="df-done" role="status">
            {done} <button className="link" onClick={() => setDone(null)}>Dismiss</button>
          </p>
        )}

        {report && total > 0 && (
          <div className="lib-filters df-filters" role="group" aria-label="Show">
            <button className={filter === 'all' ? 'chipbtn on' : 'chipbtn'} onClick={() => setFilter('all')}>
              All {total}
            </button>
            {KIND_ORDER.filter((k) => report.counts[k] > 0).map((k) => (
              <button key={k} className={filter === k ? 'chipbtn on' : 'chipbtn'} onClick={() => setFilter(k)}>
                {SHORT[k]} {report.counts[k]}
              </button>
            ))}
          </div>
        )}

        <div className="df-groups">
          {report && total === 0 && !busy && (
            <div className="lib-empty">
              <div className="lib-empty-title">No duplicates found</div>
              <p>No two documents in your library share a file, the same text, the same DOI, or enough of their content to look alike.</p>
            </div>
          )}
          {groups.map((g, i) => (
            <Group key={`${g.kind}-${g.docs.map((d) => d.id).join('-')}-${i}`} group={g} canTrash={canTrash} pending={pending} setPending={setPending} act={act} disabled={!!busy} />
          ))}
        </div>
      </div>
    </div>
  )
}

function Group({
  group: g,
  canTrash,
  pending,
  setPending,
  act,
  disabled,
}: {
  group: DuplicateGroup
  canTrash: boolean
  pending: Pending | null
  setPending: (p: Pending | null) => void
  act: (d: DuplicateDoc, action: Pending['action'], g: DuplicateGroup) => void
  disabled: boolean
}) {
  return (
    <article className={`df-group df-${g.kind}`}>
      <div className="df-group-head">
        <span className={`df-badge df-badge-${g.kind}`}>{g.label}</span>
        {g.similarity != null && g.kind !== 'exact_file' && g.kind !== 'same_text' && (
          <span className="muted">{g.similarity}% text overlap</span>
        )}
        <span className="spacer" />
        {g.recoverable > 0 && <span className="df-frees">Frees {formatBytes(g.recoverable)}</span>}
      </div>
      <p className="df-explain">{g.explanation}</p>
      {g.reasons.length > 0 && (
        <ul className="df-reasons">
          {g.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div className="df-docs">
        {g.docs.map((d) => {
          const keep = d.id === g.keep
          const confirm = pending?.id === d.id ? pending.action : null
          return (
            <div key={d.id} className={`df-doc${keep ? ' keep' : ''}`}>
              <div className="df-flags">
                {keep ? (
                  <span className="df-keep">Suggested to keep · {g.keep_reason}</span>
                ) : (
                  <span className="df-other">Could be removed</span>
                )}
                {d.cited && <span className="df-flag cited">Cited in your draft</span>}
                {d.is_file && !d.exists && <span className="df-flag bad">File missing</span>}
                {!d.is_file && <span className="df-flag">Web page</span>}
              </div>
              <div className="lib-doc-title">{d.title}</div>
              {byline(d) && <div className="lib-doc-by">{byline(d)}</div>}
              <div className="df-path" title={d.source}>
                <code>{d.source}</code>
                {d.exists && window.rc?.showFile && (
                  <button className="link" onClick={() => window.rc!.showFile!(d.source).catch(() => {})}>
                    Show in folder
                  </button>
                )}
              </div>
              <dl className="df-meta">
                <dt>Size</dt>
                <dd>{d.is_file ? formatBytes(d.size) : 'not a file'}</dd>
                <dt>Pages</dt>
                <dd>{d.page_count}</dd>
                {d.doi && (
                  <>
                    <dt>DOI</dt>
                    <dd>{d.doi}</dd>
                  </>
                )}
                <dt>Added</dt>
                <dd>{d.added_at.slice(0, 10)}</dd>
                {d.folders.length > 0 && (
                  <>
                    <dt>Folders</dt>
                    <dd>{d.folders.join(', ')}</dd>
                  </>
                )}
              </dl>

              {confirm ? (
                <div className="df-confirm">
                  <p>
                    {confirm === 'trash' ? (
                      <>
                        Move <code>{d.source}</code> ({formatBytes(d.size)}) to the Recycle Bin and remove it from your library?
                        You can restore the file from the Recycle Bin.
                      </>
                    ) : (
                      <>Remove “{d.title}” from your library? The file stays where it is on disk.</>
                    )}{' '}
                    Its folders, tags and summary are removed from the library.
                  </p>
                  {d.cited && <p className="warn">Your draft cites this document; those citations will show “quote not found”.</p>}
                  {keep && <p className="warn">This is the copy we suggested keeping.</p>}
                  <div className="df-actions">
                    <button className="danger" onClick={() => act(d, confirm, g)} disabled={disabled}>
                      {confirm === 'trash' ? 'Move to Recycle Bin' : 'Remove from library'}
                    </button>
                    <button onClick={() => setPending(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="df-actions">
                  {canTrash && d.exists && (
                    <button className={keep ? '' : 'ghost'} onClick={() => setPending({ id: d.id, action: 'trash' })} disabled={disabled}>
                      Move to Recycle Bin…
                    </button>
                  )}
                  <button className="link" onClick={() => setPending({ id: d.id, action: 'remove' })} disabled={disabled}>
                    Remove from library only
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </article>
  )
}
