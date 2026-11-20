import { useEffect, useState } from 'react'
import { api } from '../api'
import type { DocxStyle, ReadingOrder } from '../types'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const STYLE_NAME: Record<DocxStyle, string> = { apa: 'APA 7', mla: 'MLA 9', ieee: 'IEEE' }

const fileName = (title: string) => `${title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Reading list'}.docx`
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Export a topic's papers, or the selected ones, as an annotated reading list in Word: each
 *  paper's reference in the Settings citation style, Muse's summary, and the reader's highlights and
 *  notes with their pages. Made from what's stored: nothing is sent to Muse. */
export function ReadingListDialog({ docIds, papers, notes, defaultTitle, style, onClose, onSaved, onError }: {
  docIds: number[]
  papers: number // of docIds, published papers
  notes: number // and the reader's own notes, listed last
  defaultTitle: string
  style: DocxStyle
  onClose: () => void
  onSaved: (name: string) => void
  onError: (msg: string) => void
}) {
  const [title, setTitle] = useState(defaultTitle)
  const [order, setOrder] = useState<ReadingOrder>('author')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  async function exportIt() {
    setBusy(true)
    try {
      const name = fileName(title)
      const data = await api.exportReadingList(docIds, style, title.trim(), order)
      if (window.rc) {
        const path = await window.rc.saveFile(name, data)
        if (!path) return // cancelled in the save dialog: stay open
        onSaved(path.split(/[\\/]/).pop() ?? name)
      } else {
        // Plain browser (dev without Electron): let the browser download it.
        const url = URL.createObjectURL(new Blob([data], { type: DOCX_MIME }))
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 5000)
        onSaved(name)
      }
      onClose()
    } catch (e) {
      onError(`Could not export the reading list: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }

  const what = [plural(papers, 'paper'), notes ? plural(notes, 'note') : ''].filter(Boolean).join(' and ')
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="modal reading-list"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reading-list-title"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) exportIt()
        }}
      >
        <h2 id="reading-list-title">Export reading list</h2>
        <label className="rl-field">
          <span>Title</span>
          <input autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="rl-field">
          <span id="rl-order">Order</span>
          <div className="segmented" role="group" aria-labelledby="rl-order">
            <button type="button" className={order === 'author' ? 'active' : ''} onClick={() => setOrder('author')}>By author</button>
            <button type="button" className={order === 'year' ? 'active' : ''} onClick={() => setOrder('year')} title="Oldest first">
              By year
            </button>
          </div>
        </div>
        <p className="muted">
          {what}, in {STYLE_NAME[style]} (your citation style in Settings). Each with Muse's summary and your highlights and notes
          {notes ? '; your notes come last' : ''}. Nothing is sent to Muse.
        </p>
        <div className="newfolder-actions">
          <button className="primary" disabled={busy}>{busy ? 'Exporting…' : 'Export…'}</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </div>
  )
}
