import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../useFocusTrap'
import type { PageSetup } from '../editor/docFormat'

/** Esc closes, and goes no further (it would close what's behind too). */
function useEsc(onClose: () => void) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      ref.current()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])
}

// ---------- page setup ----------

const PAPERS: { size: PageSetup['size']; orientation: PageSetup['orientation']; label: string; w: number; h: number }[] = [
  { size: 'a4', orientation: 'portrait', label: 'A4', w: 21, h: 29 },
  { size: 'letter', orientation: 'portrait', label: 'Letter', w: 22, h: 28 },
  { size: 'a4', orientation: 'landscape', label: 'A4 landscape', w: 29, h: 21 },
  { size: 'letter', orientation: 'landscape', label: 'Letter landscape', w: 28, h: 22 },
]
const MARGIN_CHOICES: { value: PageSetup['margins']; label: string; note: string }[] = [
  { value: 'narrow', label: 'Narrow', note: '1.27 cm' },
  { value: 'normal', label: 'Normal', note: '2.54 cm' },
  { value: 'wide', label: 'Wide', note: '3.18 cm sides' },
]

export function PageSetupDialog({ value, onSave, onClose }: { value: PageSetup; onSave: (p: PageSetup) => void; onClose: () => void }) {
  const [p, setP] = useState(value)
  const box = useRef<HTMLDivElement>(null)
  useFocusTrap(box)
  useEsc(onClose)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal page-setup" role="dialog" aria-modal="true" aria-labelledby="ps-title" ref={box}>
        <h2 id="ps-title">Page setup</h2>
        <p className="muted">For this draft's Word file, PDF and printing. On screen the draft stays one long page.</p>
        <div className="ps-grid">
          <span>Paper</span>
          <div className="ps-papers" role="radiogroup" aria-label="Paper">
            {PAPERS.map((x) => {
              const on = p.size === x.size && p.orientation === x.orientation
              return (
                <button key={x.label} role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => setP((o) => ({ ...o, size: x.size, orientation: x.orientation }))}>
                  <i style={{ width: x.w, height: x.h }} />
                  {x.label}
                </button>
              )
            })}
          </div>
          <span>Margins</span>
          <div className="segmented" role="radiogroup" aria-label="Margins">
            {MARGIN_CHOICES.map((m) => (
              <button key={m.value} role="radio" aria-checked={p.margins === m.value} className={p.margins === m.value ? 'active' : ''} onClick={() => setP((o) => ({ ...o, margins: m.value }))}>
                {m.label} <small>{m.note}</small>
              </button>
            ))}
          </div>
          <span>Page numbers</span>
          <label className="toggle">
            <input type="checkbox" checked={p.pageNumbers} onChange={(e) => setP((o) => ({ ...o, pageNumbers: e.target.checked }))} />
            At the foot of each page
          </label>
          <span>Line numbers</span>
          <label className="toggle">
            <input type="checkbox" checked={p.lineNumbers} onChange={(e) => setP((o) => ({ ...o, lineNumbers: e.target.checked }))} />
            In the Word file, for a reviewer's copy
          </label>
        </div>
        <div className="confirm-acts">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => (onSave(p), onClose())}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- keyboard shortcuts ----------

const SHORTCUTS: [string, [string, string][]][] = [
  ['Text', [['Bold', 'Ctrl+B'], ['Italic', 'Ctrl+I'], ['Underline', 'Ctrl+U'], ['Strikethrough', 'Ctrl+Shift+S'], ['Superscript', 'Ctrl+.'], ['Subscript', 'Ctrl+,'], ['Highlight', 'Ctrl+Shift+H'], ['Clear formatting', 'Ctrl+Space'], ['Bigger / smaller text', 'Ctrl+] / Ctrl+[']]],
  ['Paragraph', [['Normal text', 'Ctrl+Alt+0'], ['Heading 1 to 3', 'Ctrl+Alt+1 to 3'], ['Quote', 'Ctrl+Shift+B'], ['Align left / centre / right / justify', 'Ctrl+Shift+L E R J'], ['Bullets / numbers / checklist', 'Ctrl+Shift+8 7 9'], ['Indent a list item', 'Tab / Shift+Tab'], ['New line in the same paragraph', 'Shift+Enter']]],
  ['Insert', [['Link', 'Ctrl+Shift+K'], ['Page break', 'Ctrl+Enter'], ['Footnote', 'Ctrl+Alt+F'], ['Comment', 'Ctrl+Alt+M']]],
  ['Find', [['Find', 'Ctrl+F'], ['Replace', 'Ctrl+H'], ['Next / previous match', 'Enter / Shift+Enter']]],
  ['Groundwork', [['Cite', 'Ctrl+Shift+C'], ['Ask Muse', 'Ctrl+J'], ['Search everything', 'Ctrl+K'], ['Writing tools', 'Ctrl+\\'], ['Focus mode', 'Ctrl+Shift+F'], ['This list', 'Ctrl+/']]],
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useFocusTrap(box)
  useEsc(onClose)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts" role="dialog" aria-modal="true" aria-labelledby="sc-title" ref={box}>
        <div className="modal-head">
          <h2 id="sc-title">Keyboard shortcuts</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="muted">Ctrl+K stays the search box, so a link is Ctrl+Shift+K.</p>
        <div className="sc-cols">
          {SHORTCUTS.map(([group, rows]) => (
            <section key={group}>
              <h3>{group}</h3>
              {rows.map(([what, keys]) => (
                <div key={what} className="sc-row">
                  <span>{what}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------- word count ----------

export interface Counts {
  words: number
  chars: number
  charsNoSpaces: number
  paragraphs: number
  selection: { words: number; chars: number; charsNoSpaces: number } | null
}

/** Opened from the word count in the status bar: the numbers, the selection's, and a word goal. */
export function WordCountPopover({ anchor, counts, goal, onGoal, onClose }: {
  anchor: DOMRect
  counts: Counts
  goal: number
  onGoal: (n: number) => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState(goal ? String(goal) : '')
  useEsc(onClose)
  useEffect(() => {
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose()
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [onClose])
  const sel = counts.selection
  const row = (label: string, a: number, b?: number) => (
    <tr>
      <td>{label}</td>
      <td>{a.toLocaleString()}</td>
      {sel && <td>{b == null ? '' : b.toLocaleString()}</td>}
    </tr>
  )
  const save = () => {
    const n = Math.max(0, Math.round(Number(draft) || 0))
    onGoal(n)
  }
  const pct = goal ? Math.round((counts.words / goal) * 100) : 0
  return (
    <div className="wc-pop" ref={box} role="dialog" aria-label="Word count" style={{ left: anchor.left, bottom: window.innerHeight - anchor.top + 8 }}>
      <h2>Word count</h2>
      <table>
        <thead>
          <tr>
            <th />
            <th>Draft</th>
            {sel && <th>Selection</th>}
          </tr>
        </thead>
        <tbody>
          {row('Words', counts.words, sel?.words)}
          {row('Characters', counts.chars, sel?.chars)}
          {row('Characters, no spaces', counts.charsNoSpaces, sel?.charsNoSpaces)}
          {row('Paragraphs', counts.paragraphs)}
          <tr>
            <td>Reading time</td>
            <td>{Math.max(1, Math.round(counts.words / 230))} min</td>
            {sel && <td />}
          </tr>
        </tbody>
      </table>
      <p className="muted">Citations, footnotes and the reference list aren't counted.</p>
      <form className="wc-goal" onSubmit={(e) => (e.preventDefault(), save())}>
        <label htmlFor="wc-goal">Word goal</label>
        <input id="wc-goal" type="number" min={0} step={100} value={draft} placeholder="e.g. 3000" onChange={(e) => setDraft(e.target.value)} onBlur={save} />
        <span className="muted">{goal ? `${pct}%` : 'none'}</span>
      </form>
    </div>
  )
}
