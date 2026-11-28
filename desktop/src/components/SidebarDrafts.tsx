import { useState } from 'react'
import type { DraftSummary } from '../types'
import { DraftNameField } from './DraftNameField'
import { Icon } from './Icon'
import { ago } from './Meters'

interface Props {
  drafts: DraftSummary[]
  currentId: number
  busy: string | null
  onOpen: (id: number) => void
  onNew: () => void
  onRename: (id: number, name: string) => void
  /** Asks first (the app's confirm dialog), then deletes. */
  onDelete: (id: number) => void
}

/** Every draft in the sidebar, under the places, the way a chat app lists its conversations: the open
 * one marked, a click opens one in Write, + starts a new one, and ⋯ on a row offers Rename and Delete
 * (inline, under the row, so nothing pops out past the sidebar's edge). Word files come in from ☰. */
export function SidebarDrafts({ drafts, currentId, busy, onOpen, onNew, onRename, onDelete }: Props) {
  const [renaming, setRenaming] = useState<number | null>(null)
  const [actionsFor, setActionsFor] = useState<number | null>(null)

  return (
    <section className="side-drafts" aria-labelledby="side-drafts-h">
      <div className="side-drafts-head">
        <h3 id="side-drafts-h">Drafts</h3>
        <button className="side-drafts-new" onClick={onNew} disabled={!!busy} title="New draft (Ctrl+N)" aria-label="New draft">
          <Icon name="plus" size={16} />
        </button>
      </div>
      {busy && (
        <p className="side-drafts-busy" role="status">
          {busy}
        </p>
      )}
      <ul>
        {drafts.map((d) => {
          const title = d.title || 'Untitled'
          const current = d.id === currentId
          return (
            <li key={d.id} className={`side-draft${current ? ' on' : ''}${actionsFor === d.id ? ' acting' : ''}`}>
              {renaming === d.id ? (
                <DraftNameField
                  draft={d}
                  className="side-draft-rename"
                  onDone={(name) => {
                    setRenaming(null)
                    if (name !== null) onRename(d.id, name)
                  }}
                />
              ) : (
                <div className="side-draft-row">
                  <button
                    className="side-draft-open"
                    onClick={() => onOpen(d.id)}
                    disabled={!!busy}
                    aria-current={current ? 'page' : undefined}
                    title={`${title}\n${d.updated_at ? `Edited ${ago(d.updated_at)}` : 'New'} · ${d.words.toLocaleString()} words`}
                  >
                    {title}
                  </button>
                  <button
                    className="side-draft-more"
                    onClick={() => setActionsFor((a) => (a === d.id ? null : d.id))}
                    aria-expanded={actionsFor === d.id}
                    aria-label={`Rename or delete ${title}`}
                    title="Rename or delete"
                  >
                    ⋯
                  </button>
                </div>
              )}
              {actionsFor === d.id && renaming !== d.id && (
                <div className="side-draft-actions">
                  <button onClick={() => (setActionsFor(null), setRenaming(d.id))}>Rename</button>
                  <button className="danger-text" onClick={() => (setActionsFor(null), onDelete(d.id))} disabled={!!busy}>
                    Delete…
                  </button>
                </div>
              )}
            </li>
          )
        })}
        {drafts.length === 0 && <li className="side-drafts-empty">Your first draft is saved as you type.</li>}
      </ul>
    </section>
  )
}
