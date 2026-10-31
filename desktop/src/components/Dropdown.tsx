import { useEffect, useRef, useState } from 'react'

export interface DropOption {
  value: string
  label: string
  /** How the option is drawn in the list: a heading's size, a font's face. */
  style?: React.CSSProperties
}

/** A dropdown drawn like the app's menus rather than the system's. Picking from it never moves
 *  focus, so an editor keeps its selection; while it's open the arrow keys, Enter and Esc work
 *  wherever focus is. */
export function Dropdown({ value, options, onChange, label, className = '' }: {
  value: string
  options: DropOption[]
  onChange: (value: string) => void
  label: string // what it chooses, for screen readers and the tooltip
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [hot, setHot] = useState(0) // the option the keyboard is on
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value) ?? options[0]

  const show = () => {
    setHot(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }
  const pick = (v: string) => {
    setOpen(false)
    if (v !== value) onChange(v)
  }

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    // Capture, so the keys reach the list even while an editor has focus (and don't move its cursor).
    const keys = (e: KeyboardEvent) => {
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
      if (step) setHot((h) => (h + step + options.length) % options.length)
      else if (e.key === 'Enter') pick(options[hot].value)
      else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false)
      else return
      if (e.key !== 'Tab') {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('mousedown', outside)
    window.addEventListener('keydown', keys, true)
    return () => {
      window.removeEventListener('mousedown', outside)
      window.removeEventListener('keydown', keys, true)
    }
  }, [open, hot, options]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) list.current?.children[hot]?.scrollIntoView({ block: 'nearest' })
  }, [open, hot])

  // Keep focus where it is (an editor's selection) on every click inside.
  const keep = (e: React.MouseEvent) => e.preventDefault()

  return (
    <div className={`dd${open ? ' open' : ''} ${className}`} ref={box}>
      <button
        type="button"
        className="dd-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? ''}`}
        title={label}
        onMouseDown={keep}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            show()
          }
        }}
      >
        <span className="dd-value">{current?.label}</span>
        <svg className="dd-chev" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="dd-list" role="listbox" aria-label={label} ref={list}>
          {options.map((o, i) => (
            <button
              key={o.value || '_'}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dd-option${i === hot ? ' dd-hot' : ''}`}
              onMouseDown={keep}
              onMouseEnter={() => setHot(i)}
              onClick={() => pick(o.value)}
            >
              <span className="dd-check" aria-hidden="true">{o.value === value ? '✓' : ''}</span>
              <span style={o.style}>{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
