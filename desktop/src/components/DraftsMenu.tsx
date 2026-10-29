import { useEffect, useRef, useState } from 'react'
import type { DraftSummary } from '../types'
import { ago } from './Meters'

interface Props {
  drafts: DraftSummary[]
  currentId: number
  busy: string | null
  onSwitch: (id: number) => void
  onNew: () => void
  onImport: (file: File) => void
  onDelete: (id: number) => void
  onClose: () => void
}

/** The drafts you're writing: switch between them, start a new one, open a Word file as a draft, or delete one. */
export function DraftsMenu({ drafts, currentId, busy, onSwitch, onNew, onImport, onDelete, onClose }: Props) {
  const [confirming, setConfirming] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.doc-switch')) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className="drafts-menu" ref={box} role="dialog" aria-label="Drafts">
      <div className="drafts-head">
        <span className="eyebrow">Your drafts</span>
        <span className="muted">{drafts.length}</span>
      </div>
      <ul className="drafts-list">
        {drafts.map((d) => (
          <li key={d.id} className={d.id === currentId ? 'on' : ''}>
            {confirming === d.id ? (
              <div className="drafts-confirm">
                <span>
                  Delete “{d.title || 'Untitled'}” and its version history? This can't be undone.
                </span>
                <div>
                  <button className="danger" onClick={() => (setConfirming(null), onDelete(d.id))} disabled={!!busy}>
                    Delete draft
                  </button>
                  <button onClick={() => setConfirming(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <button className="drafts-item" onClick={() => onSwitch(d.id)} disabled={!!busy} aria-current={d.id === currentId}>
                  <span className="drafts-title">{d.title || 'Untitled'}</span>
                  <span className="muted">
                    {d.updated_at ? `edited ${ago(d.updated_at)}` : 'new'} · {d.words.toLocaleString()} words
                  </span>
                </button>
                <button className="icon drafts-delete" title="Delete this draft" aria-label={`Delete ${d.title}`} onClick={() => setConfirming(d.id)}>
                  ×
                </button>
              </>
            )}
          </li>
        ))}
        {drafts.length === 0 && <li className="muted drafts-empty">Your first draft is saved as you type.</li>}
      </ul>
      {busy && (
        <div className="lib-busy" role="status">
          <span className="bar" />
          {busy}
        </div>
      )}
      <div className="drafts-foot">
        <button className="primary" onClick={onNew} disabled={!!busy}>
          + New draft
        </button>
        <button onClick={() => file.current?.click()} disabled={!!busy} title="Open a Word document as a draft, or into this one (Ctrl+O)">
          Import Word file…
        </button>
        <input
          ref={file}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) onImport(f)
          }}
        />
      </div>
    </div>
  )
}
