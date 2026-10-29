import { useEffect, useMemo, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { api } from '../api'
import type { DocxConversion, DocxStats } from '../types'
import { Icon } from './Icon'

export type ImportChoice = 'new' | 'insert' | 'library'

interface Props {
  file: File
  /** The draft that's open, for "Insert into …". */
  currentTitle: string
  currentEmpty: boolean
  /** The file's path on disk, when known: the library reads sources from disk. */
  path: string
  onNewDraft: (c: DocxConversion) => Promise<void>
  onInsert: (c: DocxConversion) => void
  onAddToLibrary: (path: string) => Promise<void>
  onClose: () => void
}

/** A file's contents as base64, for sending a Word file to the backend. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',', 2)[1] ?? '')
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'))
    r.readAsDataURL(file)
  })
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** "12 paragraphs · 4 headings · 6 list items": what came across. */
export function convertedSummary(n: DocxStats): string {
  const parts = [plural(n.paragraphs, 'paragraph'), plural(n.headings, 'heading')]
  if (n.list_items) parts.push(plural(n.list_items, 'list item'))
  if (n.quotes) parts.push(plural(n.quotes, 'quote'))
  if (n.links) parts.push(plural(n.links, 'link'))
  return parts.join(' · ')
}

/** What the editor can't hold, said plainly. */
export function simplifiedNotes(n: DocxStats): string[] {
  const notes = []
  if (n.tables) notes.push(`${plural(n.tables, 'table')} become${n.tables === 1 ? 's' : ''} plain lines, cells separated by |`)
  if (n.images) notes.push(`${plural(n.images, 'image')} ${n.images === 1 ? 'is' : 'are'} left out`)
  return notes
}

function textOf(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return ' '
  return (node.content ?? []).map(textOf).join('')
}

interface Line {
  kind: 'heading' | 'paragraph' | 'item' | 'quote'
  level: number // heading level, or list nesting depth
  text: string
}

/** The opening blocks as lines to preview: headings by level, list items indented by depth. */
function outline(doc: DocxConversion['content'], max = 9): Line[] {
  const out: Line[] = []
  const add = (kind: Line['kind'], level: number, node: JSONContent) => {
    const text = textOf(node).trim()
    if (text && out.length < max) out.push({ kind, level, text: text.length > 140 ? `${text.slice(0, 140)}…` : text })
  }
  const walk = (nodes: JSONContent[], depth: number, quote: boolean) => {
    for (const node of nodes) {
      if (out.length >= max) return
      if (node.type === 'bulletList' || node.type === 'orderedList') {
        for (const item of node.content ?? []) {
          const [first, ...rest] = item.content ?? []
          if (first) add('item', depth, first)
          walk(rest, depth + 1, quote)
        }
      } else if (node.type === 'blockquote') walk(node.content ?? [], depth, true)
      else if (node.type === 'heading') add('heading', Number(node.attrs?.level ?? 1), node)
      else add(quote ? 'quote' : 'paragraph', depth, node)
    }
  }
  walk(doc.content, 0, false)
  return out
}

const short = (s: string, n = 36) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** Opening a Word file: shows what was read, then puts it where the writer wants it. */
export function WordImportDialog({ file, currentTitle, currentEmpty, path, onNewDraft, onInsert, onAddToLibrary, onClose }: Props) {
  const [conv, setConv] = useState<DocxConversion | null>(null)
  const [error, setError] = useState<string | null>(null)
  // An empty draft is the natural place for it; otherwise keep what's being written untouched.
  const [choice, setChoice] = useState<ImportChoice>(currentEmpty ? 'insert' : 'new')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stale = false
    fileToBase64(file)
      .then((data) => api.convertDocx(file.name, data))
      .then((c) => !stale && setConv(c))
      .catch((e) => !stale && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      stale = true
    }
  }, [file])

  const preview = useMemo(() => (conv ? outline(conv.content) : []), [conv])
  const ready = choice === 'library' ? !!path : !!conv

  async function confirm() {
    if (!ready || busy) return
    setBusy(true)
    try {
      if (choice === 'library') await onAddToLibrary(path)
      else if (choice === 'insert') onInsert(conv!)
      else await onNewDraft(conv!)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
      else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) confirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const insertName = currentTitle && currentTitle !== 'Untitled' ? `“${short(currentTitle)}”` : 'this draft'
  const options: { value: ImportChoice; title: string; text: string; disabled?: boolean }[] = [
    { value: 'new', title: 'Open as a new draft', text: currentEmpty ? 'Its own draft, listed with your others.' : `A draft of its own. ${insertName} stays as it is.` },
    {
      value: 'insert',
      title: currentEmpty ? 'Use it for this empty draft' : `Insert into ${insertName}`,
      text: currentEmpty ? 'Fills the page that’s open now.' : 'Goes in where your cursor is, or at the end. Ctrl+Z takes it out again.',
    },
    {
      value: 'library',
      title: 'Add to the library as a source',
      text: path ? 'Muse reads it, so you can search it and cite it.' : 'Only for a file opened from disk in the desktop app.',
      disabled: !path,
    },
  ]
  const action = choice === 'library' ? 'Add to library' : choice === 'insert' ? (currentEmpty ? 'Use for this draft' : 'Insert') : 'Open as new draft'
  const notes = conv ? simplifiedNotes(conv.imported) : []

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal word-import" role="dialog" aria-modal="true" aria-labelledby="word-import-title">
        <header className="wi-head">
          <span className="wi-file" aria-hidden="true"><Icon name="word" size={22} /></span>
          <div className="wi-head-text">
            <h2 id="word-import-title" title={file.name}>{file.name}</h2>
            <span className="muted">
              {size(file.size)}
              {conv && ` · ${convertedSummary(conv.imported)}`}
            </span>
          </div>
          <button className="icon" onClick={onClose} disabled={busy} aria-label="Close">
            ×
          </button>
        </header>

        <section className="wi-preview" aria-label="Preview" aria-busy={!conv && !error}>
          {!conv && !error && (
            <div className="lib-busy" role="status">
              <span className="bar" />
              Reading the document…
            </div>
          )}
          {error && <p className="error-text" role="alert">{error}</p>}
          {conv && (
            <ol className="wi-outline">
              {preview.map((p, i) => (
                <li
                  key={i}
                  className={p.kind === 'heading' ? `wi-h wi-h${Math.min(p.level, 3)}` : `wi-${p.kind}`}
                  style={p.kind === 'item' ? { paddingLeft: 14 + p.level * 16 } : undefined}
                >
                  {p.text}
                </li>
              ))}
            </ol>
          )}
        </section>
        {notes.length > 0 && <p className="wi-notes muted">Simplified: {notes.join('; ')}.</p>}

        <fieldset className="wi-choices" disabled={busy}>
          <legend className="eyebrow">Where should it go?</legend>
          {options.map((o) => (
            <label key={o.value} className={`wi-choice${choice === o.value ? ' active' : ''}${o.disabled ? ' off' : ''}`}>
              <input type="radio" name="word-import" checked={choice === o.value} disabled={o.disabled} onChange={() => setChoice(o.value)} />
              <span>
                <b>{o.title}</b>
                <span className="muted">{o.text}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <footer className="wi-foot">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={confirm} disabled={!ready || busy}>
            {busy ? 'Working…' : action}
          </button>
        </footer>
      </div>
    </div>
  )
}
