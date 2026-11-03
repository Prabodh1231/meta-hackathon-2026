import { useRef, useState } from 'react'
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
  onRename: (id: number, name: string) => void
}

/** Edit a draft's name in place: Enter or leaving the field keeps it, Esc cancels. Emptying it
 * names the draft after its first line again. `onDone` gets null when nothing changed. */
export function DraftNameField({ draft, className, onDone }: {
  draft: { title: string; named: boolean }
  className?: string
  onDone: (name: string | null) => void
}) {
  const done = useRef(false)
  function finish(value: string | null) {
    if (done.current) return
    done.current = true
    const name = value === null ? null : value.trim()
    if (name === null || name === draft.title) onDone(null) // unchanged: a first line isn't fixed as the name
    else if (!name) onDone(draft.named ? '' : null)
    else onDone(name)
  }
  return (
    <input
      className={`draft-name-field${className ? ` ${className}` : ''}`}
      autoFocus
      defaultValue={draft.title === 'Untitled' && !draft.named ? '' : draft.title}
      placeholder="Name this draft"
      aria-label="Draft name"
      maxLength={120}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value)
        if (e.key === 'Escape') {
          e.stopPropagation()
          finish(null)
        }
      }}
    />
  )
}

/** Everything you're writing: start a new draft or bring in a Word file, then switch between
 * drafts, rename one or delete one. */
export function DraftsPanel({ drafts, currentId, busy, onSwitch, onNew, onImport, onDelete, onRename }: Props) {
  const [confirming, setConfirming] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)

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
              ) : renaming === d.id ? (
                <div className="dp-main dp-renaming">
                  <span className="dp-page" aria-hidden="true" />
                  <DraftNameField
                    draft={d}
                    onDone={(name) => {
                      setRenaming(null)
                      if (name !== null) onRename(d.id, name)
                    }}
                  />
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
                  <button className="icon dp-rename" title="Rename this draft" aria-label={`Rename ${d.title || 'Untitled'}`} onClick={() => setRenaming(d.id)}>
                    <Icon name="write" size={15} />
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
