import { useRef } from 'react'

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
