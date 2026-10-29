import { useState } from 'react'
import type { DraftSummary } from '../types'
import { Icon } from './Icon'
import { ago } from './Meters'

interface Props {
  drafts: DraftSummary[]
  currentId: number
  busy: string | null
  onSwitch: (id: number) => void
  onNew: () => void
  onImport: () => void
  onDelete: (id: number) => void
}

/** Everything you're writing: start a new draft or bring in a Word file, then switch between
 * drafts or delete one. */
export function DraftsPanel({ drafts, currentId, busy, onSwitch, onNew, onImport, onDelete }: Props) {
  const [confirming, setConfirming] = useState<number | null>(null)

  return (
    <aside className="panel lb dp" aria-label="Drafts">
      <header className="lb-head">
        <div className="lb-title">
          <h2>Drafts</h2>
          <span className="muted">
            {drafts.length} draft{drafts.length === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      <div className="dp-start">
        <button className="dp-tile dp-tile-new" onClick={onNew} disabled={!!busy}>
          <span className="dp-tile-ico" aria-hidden="true">+</span>
          <b>New draft</b>
          <span>A blank page · Ctrl+N</span>
        </button>
        <button className="dp-tile" onClick={onImport} disabled={!!busy}>
          <span className="dp-tile-ico" aria-hidden="true">
            <Icon name="word" size={20} />
          </span>
          <b>Import Word file</b>
          <span>.docx · Ctrl+O</span>
        </button>
      </div>
      {busy && (
        <div className="lib-busy dp-busy" role="status">
          <span className="bar" />
          {busy}
        </div>
      )}

      <div className="eyebrow dp-label">Your drafts</div>
      <ul className="dp-list">
        {drafts.map((d) => {
          const current = d.id === currentId
          return (
            <li key={d.id} className={`dp-item${current ? ' on' : ''}`}>
              {confirming === d.id ? (
                <div className="dp-confirm">
                  <span>Delete “{d.title || 'Untitled'}” and its version history? This can't be undone.</span>
                  <div>
                    <button onClick={() => setConfirming(null)}>Cancel</button>
                    <button className="danger" onClick={() => (setConfirming(null), onDelete(d.id))} disabled={!!busy}>
                      Delete draft
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button className="dp-main" onClick={() => onSwitch(d.id)} disabled={!!busy} aria-current={current}>
                    <span className="dp-page" aria-hidden="true" />
                    <span className="dp-text">
                      <span className="dp-title">{d.title || 'Untitled'}</span>
                      <span className="muted">
                        {d.updated_at ? `Edited ${ago(d.updated_at)}` : 'New'} · {d.words.toLocaleString()} words
                      </span>
                    </span>
                    {current && <span className="dp-open">Open</span>}
                  </button>
                  <button className="icon dp-delete" title="Delete this draft" aria-label={`Delete ${d.title || 'Untitled'}`} onClick={() => setConfirming(d.id)}>
                    ×
                  </button>
                </>
              )}
            </li>
          )
        })}
        {drafts.length === 0 && <li className="muted dp-empty">Your first draft is saved as you type.</li>}
      </ul>
    </aside>
  )
}
