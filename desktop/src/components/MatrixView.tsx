import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { Doc, DocxStyle, DraftSentence, Folder, Matrix, MatrixCell, MatrixColumn, MatrixPaper, MatrixSummary } from '../types'
import { ago } from './Meters'
import { SourceViewer, type SourceTarget } from './SourceViewer'
import { StatusBadge } from './StatusBadge'

interface Props {
  docs: Doc[]
  folders: Folder[]
  /** Sources ticked in the Library: one way to choose a matrix's papers. */
  selected: Set<number>
  /** The app bar's search box, which filters the matrix's rows while it's open. */
  query: string
  citationStyle: DocxStyle
  onError: (msg: string) => void
  onOpenPdf: (doc: Doc, page: number) => void
  /** Put a table (editor content whose cells cite their quotes) into the draft. */
  onInsertTable: (doc: { type: 'doc'; content: unknown[] }) => void
  /** Put sentences written from the matrix into the draft. */
  onInsertSentences: (sentences: DraftSentence[]) => void
}

const STATUS_TEXT: Record<MatrixCell['status'], string> = {
  pending: 'Reading…',
  found: 'Quote found on the page',
  unverified: "The quote wasn't found in the paper: check it",
  not_reported: 'Not reported in the passages read',
  error: "Couldn't read this",
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Where a matrix's papers come from when it's made. */
type Source = 'topic' | 'folder' | 'ticked'

function NewMatrix({ folders, docs, selected, onCreated, onCancel, onError }: {
  folders: Folder[]
  docs: Doc[]
  selected: Set<number>
  onCreated: (m: Matrix) => void
  onCancel?: () => void
  onError: (msg: string) => void
}) {
  const [source, setSource] = useState<Source>(selected.size ? 'ticked' : 'topic')
  const [topic, setTopic] = useState('')
  const [folderId, setFolderId] = useState<number | ''>('')
  const [papers, setPapers] = useState<MatrixPaper[] | null>(null)
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [name, setName] = useState('')
  const [columns, setColumns] = useState<MatrixColumn[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    api.matrixColumns().then(setColumns).catch((e) => onError(message(e)))
  }, [onError])

  const show = (list: MatrixPaper[], title: string) => {
    setPapers(list)
    setChosen(new Set(list.slice(0, 80).map((p) => p.id)))
    if (!name.trim()) setName(title)
  }

  useEffect(() => {
    if (source !== 'ticked') return
    const list = docs.filter((d) => selected.has(d.id)).map((d) => ({ id: d.id, title: d.title, authors: d.authors, year: d.year, kind: d.kind }))
    show(list, '')
  }, [source]) // eslint-disable-line react-hooks/exhaustive-deps

  async function find(by: { topic?: string; folder_id?: number }, title: string) {
    setBusy('Finding papers…')
    try {
      show(await api.matrixPapers(by), title)
    } catch (e) {
      onError(message(e))
    } finally {
      setBusy(null)
    }
  }

  async function build() {
    setBusy('Starting…')
    try {
      onCreated(await api.createMatrix(name.trim() || 'Review matrix', [...chosen], columns))
    } catch (e) {
      onError(message(e))
      setBusy(null)
    }
  }

  const setColumn = (i: number, patch: Partial<MatrixColumn>) => setColumns((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  return (
    <div className="mx-new">
      <h2>New review matrix</h2>
      <p className="muted">
        One row per paper, one column per question. Muse reads each paper and fills every cell with a short answer and the
        quote it comes from, found on the page, or marks it <i>Not reported</i>.
      </p>

      <section className="mx-step">
        <h3>1. Papers</h3>
        <div className="segmented" role="radiogroup" aria-label="Papers from">
          {(
            [
              ['topic', 'About a topic'],
              ['folder', 'A folder'],
              ['ticked', `Ticked in the Library (${selected.size})`],
            ] as const
          ).map(([v, label]) => (
            <button key={v} role="radio" aria-checked={source === v} className={source === v ? 'active' : ''} onClick={() => (setSource(v), setPapers(null))}>
              {label}
            </button>
          ))}
        </div>
        {source === 'topic' && (
          <form className="mx-row" onSubmit={(e) => (e.preventDefault(), topic.trim() && find({ topic: topic.trim() }, topic.trim()))}>
            <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. cryptocurrency adoption" aria-label="Topic" autoFocus />
            <button className="primary" disabled={!topic.trim() || !!busy}>Find papers</button>
          </form>
        )}
        {source === 'folder' && (
          <div className="mx-row">
            <select
              value={folderId}
              aria-label="Folder"
              onChange={(e) => {
                const id = Number(e.target.value)
                setFolderId(id)
                const f = folders.find((x) => x.id === id)
                if (f) find({ folder_id: id }, f.name)
              }}
            >
              <option value="">Choose a folder…</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({f.doc_count})
                </option>
              ))}
            </select>
          </div>
        )}
        {source === 'ticked' && selected.size === 0 && <p className="muted">Tick papers in the Library first, or choose a topic or folder.</p>}
        {busy && <p className="muted">{busy}</p>}
        {papers && (
          <div className="mx-papers">
            <div className="mx-papers-head">
              <span>
                {chosen.size} of {papers.length} papers chosen{papers.length > 80 ? ' (at most 80)' : ''}
              </span>
              <button className="link" onClick={() => setChosen(chosen.size ? new Set() : new Set(papers.slice(0, 80).map((p) => p.id)))}>
                {chosen.size ? 'Choose none' : 'Choose all'}
              </button>
            </div>
            {papers.length === 0 && <p className="muted">No papers found. Try other words, or another folder.</p>}
            <ul>
              {papers.map((p) => (
                <li key={p.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(p.id)}
                      onChange={() =>
                        setChosen((s) => {
                          const n = new Set(s)
                          n.has(p.id) ? n.delete(p.id) : n.size < 80 && n.add(p.id)
                          return n
                        })
                      }
                    />
                    <span className="mx-paper-title">{p.title}</span>
                    <span className="muted">{[p.authors[0], p.year].filter(Boolean).join(' · ')}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="mx-step">
        <h3>2. Columns</h3>
        <p className="muted">What to pull out of every paper. Rename, reword or add your own (an outcome measure, a theory, a dataset…).</p>
        <div className="mx-cols">
          {columns.map((c, i) => (
            <div key={i} className="mx-col">
              <input value={c.label} onChange={(e) => setColumn(i, { label: e.target.value })} aria-label="Column name" className="mx-col-label" />
              <input value={c.instruction} onChange={(e) => setColumn(i, { instruction: e.target.value, query: '' })} aria-label="What to extract" placeholder="What to extract, in a sentence" />
              <button className="icon" onClick={() => setColumns((cs) => cs.filter((_, j) => j !== i))} aria-label={`Remove ${c.label}`} title="Remove this column">
                ×
              </button>
            </div>
          ))}
          {columns.length < 12 && (
            <button className="link" onClick={() => setColumns((cs) => [...cs, { key: '', label: '', instruction: '' }])}>
              + Add a column
            </button>
          )}
        </div>
      </section>

      <section className="mx-step">
        <h3>3. Name</h3>
        <div className="mx-row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cryptocurrency adoption" aria-label="Matrix name" />
        </div>
      </section>

      <div className="mx-actions">
        <button className="primary" disabled={!chosen.size || !columns.length || columns.some((c) => !c.label.trim()) || !!busy} onClick={build}>
          Build the matrix ({chosen.size} papers × {columns.length} columns)
        </button>
        {onCancel && <button onClick={onCancel}>Cancel</button>}
        <span className="muted">About {Math.max(1, Math.ceil(chosen.size / 8) * 8)} seconds; it keeps reading if you go elsewhere.</span>
      </div>
    </div>
  )
}

/** A cell's quote as the source viewer shows it: on its page, highlighted. */
function targetOf(cell: MatrixCell, row: Matrix['rows'][number], column: MatrixColumn): SourceTarget | null {
  if (!cell.page) return null
  return {
    docId: row.doc_id,
    page: cell.page,
    start: cell.start,
    end: cell.end,
    quote: cell.quote,
    status: cell.status === 'found' ? 'verified' : 'quote_not_found',
    reason: cell.status === 'found' ? '' : STATUS_TEXT.unverified,
    label: cell.label,
    badge: column.label,
  }
}

function CellPane({ matrix, docId, col, docs, onSaved, onRerun, onClose, onOpenPdf }: {
  matrix: Matrix
  docId: number
  col: string
  docs: Doc[]
  onSaved: (m: Matrix) => void
  onRerun: () => void
  onClose: () => void
  onOpenPdf: (doc: Doc, page: number) => void
}) {
  const row = matrix.rows.find((r) => r.doc_id === docId)
  const column = matrix.columns.find((c) => c.key === col)
  const cell = row?.cells[col]
  const [answer, setAnswer] = useState(cell?.answer ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => setAnswer(cell?.answer ?? ''), [cell?.answer, docId, col])
  const target = useMemo(() => (cell && row && column ? targetOf(cell, row, column) : null), [cell?.page, cell?.start, cell?.end, cell?.status, docId, col]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!row || !column || !cell) return null
  const doc = docs.find((d) => d.id === docId)

  return (
    <aside className="mx-pane" aria-label="Cell">
      <header className="mx-pane-head">
        <div>
          <span className="eyebrow">{column.label}</span>
          <h3 title={row.title}>{row.label}</h3>
          <p className="muted">{row.title}</p>
        </div>
        <button className="icon" onClick={onClose} aria-label="Close" title="Close (Esc)">
          ×
        </button>
      </header>
      <p className={`mx-status mx-${cell.status}`}>
        {STATUS_TEXT[cell.status]}
        {cell.edited ? ' · answer edited by you' : ''}
        {cell.error ? `: ${cell.error}` : ''}
      </p>
      <label className="mx-answer">
        <span>Answer</span>
        <textarea rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Not reported" />
      </label>
      <div className="mx-pane-actions">
        <button
          className="primary"
          disabled={answer.trim() === cell.answer.trim() || saving}
          onClick={async () => {
            setSaving(true)
            try {
              onSaved(await api.setMatrixCell(matrix.id, docId, col, answer))
            } finally {
              setSaving(false)
            }
          }}
        >
          Save answer
        </button>
        <button onClick={onRerun} disabled={cell.status === 'pending'} title="Ask Muse to read this cell again (replaces your edit)">
          Read again
        </button>
        {doc?.kind === 'pdf' && cell.page && (
          <button onClick={() => onOpenPdf(doc, cell.page!)} title="The whole PDF, at this page">
            Open PDF, p. {cell.label.match(/p\. ([\w-]+)$/)?.[1] ?? cell.page}
          </button>
        )}
      </div>
      {target ? (
        <div className="mx-source">
          <SourceViewer target={target} doc={doc} onOpenPdf={onOpenPdf} />
        </div>
      ) : (
        cell.quote && <blockquote className="mx-quote">“{cell.quote}”</blockquote>
      )}
    </aside>
  )
}

function SynthesisDialog({ matrix, onInsert, onClose, onError }: {
  matrix: Matrix
  onInsert: (sentences: DraftSentence[]) => void
  onClose: () => void
  onError: (msg: string) => void
}) {
  const [instruction, setInstruction] = useState('')
  const [cols, setCols] = useState<Set<string>>(new Set(matrix.columns.map((c) => c.key)))
  const [sentences, setSentences] = useState<DraftSentence[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  async function write() {
    setBusy(true)
    setSentences(null)
    try {
      const res = await api.matrixSynthesis(matrix.id, instruction.trim(), [...cols])
      setSentences(res.sentences)
      setPicked(new Set(res.sentences.map((_, i) => i)))
    } catch (e) {
      onError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal mx-dialog" role="dialog" aria-modal="true" aria-labelledby="mx-syn-title">
        <header className="modal-head">
          <h2 id="mx-syn-title">Write from this matrix</h2>
          <button className="icon" onClick={onClose} aria-label="Close">×</button>
        </header>
        <p className="muted">Muse writes a comparison of the studies from the matrix's quotes, citing each one. Tick what to keep.</p>
        <textarea
          rows={2}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Compare these studies: where findings agree and differ, and how samples, settings and methods explain it. (Or write your own.)"
        />
        <div className="mx-check-row">
          {matrix.columns.map((c) => (
            <label key={c.key}>
              <input
                type="checkbox"
                checked={cols.has(c.key)}
                onChange={() => setCols((s) => (s.has(c.key) ? new Set([...s].filter((k) => k !== c.key)) : new Set([...s, c.key])))}
              />{' '}
              {c.label}
            </label>
          ))}
        </div>
        <div className="mx-actions">
          <button className="primary" disabled={busy || !cols.size} onClick={write}>
            {busy ? 'Writing…' : sentences ? 'Write again' : 'Write'}
          </button>
        </div>
        {sentences && sentences.length === 0 && <p className="muted">Nothing could be written from these columns.</p>}
        {sentences && sentences.length > 0 && (
          <>
            <ul className="mx-sentences">
              {sentences.map((s, i) => (
                <li key={i} className={picked.has(i) ? 'picked' : ''}>
                  <label>
                    <input
                      type="checkbox"
                      checked={picked.has(i)}
                      onChange={() => setPicked((p) => (p.has(i) ? new Set([...p].filter((x) => x !== i)) : new Set([...p, i])))}
                    />
                    <span>{s.text}</span>
                  </label>
                  <div className="muted">
                    {s.citations.map((c, j) => (
                      <span key={j} className="mx-cite">
                        <StatusBadge status={c.status} /> {c.label}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <div className="mx-actions">
              <button
                className="primary"
                disabled={!picked.size}
                onClick={() => {
                  onInsert(sentences.filter((_, i) => picked.has(i)))
                  onClose()
                }}
              >
                Insert {picked.size} into the draft
              </button>
              <span className="muted">Each citation is checked against its source after it's inserted.</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function InsertTableDialog({ matrix, onInsert, onClose, onError }: {
  matrix: Matrix
  onInsert: (doc: { type: 'doc'; content: unknown[] }) => void
  onClose: () => void
  onError: (msg: string) => void
}) {
  const [cols, setCols] = useState<Set<string>>(new Set(matrix.columns.map((c) => c.key)))
  const [busy, setBusy] = useState(false)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal mx-dialog" role="dialog" aria-modal="true" aria-labelledby="mx-ins-title">
        <header className="modal-head">
          <h2 id="mx-ins-title">Insert the matrix into the draft</h2>
          <button className="icon" onClick={onClose} aria-label="Close">×</button>
        </header>
        <p className="muted">
          A table, one row per study, at the cursor (or the end of the draft). Each cell cites its quote, so the reference list
          and Word export include the papers; the citations are checked in the background once inserted.
        </p>
        <div className="mx-check-row">
          {matrix.columns.map((c) => (
            <label key={c.key}>
              <input
                type="checkbox"
                checked={cols.has(c.key)}
                onChange={() => setCols((s) => (s.has(c.key) ? new Set([...s].filter((k) => k !== c.key)) : new Set([...s, c.key])))}
              />{' '}
              {c.label}
            </label>
          ))}
        </div>
        <div className="mx-actions">
          <button
            className="primary"
            disabled={!cols.size || busy}
            onClick={async () => {
              setBusy(true)
              try {
                onInsert(await api.matrixTable(matrix.id, matrix.columns.filter((c) => cols.has(c.key)).map((c) => c.key)))
                onClose()
              } catch (e) {
                onError(message(e))
                setBusy(false)
              }
            }}
          >
            Insert {cols.size} column{cols.size === 1 ? '' : 's'}
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/** Save a matrix export: the desktop app asks where; a browser downloads it. */
async function save(name: string, data: ArrayBuffer, ext: string) {
  const file = `${name.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'Review matrix'}.${ext}`
  if (window.rc) return window.rc.saveFile(file, data)
  const url = URL.createObjectURL(new Blob([data]))
  const a = document.createElement('a')
  a.href = url
  a.download = file
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return file
}

export function MatrixView({ docs, folders, selected, query, citationStyle, onError, onOpenPdf, onInsertTable, onInsertSentences }: Props) {
  const [list, setList] = useState<MatrixSummary[] | null>(null)
  const [matrix, setMatrix] = useState<Matrix | null>(null)
  const [creating, setCreating] = useState(false)
  const [cellAt, setCellAt] = useState<{ doc: number; col: string } | null>(null)
  const [dialog, setDialog] = useState<'synthesis' | 'insert' | null>(null)
  const [menu, setMenu] = useState<'export' | 'more' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [editingCol, setEditingCol] = useState<{ index: number; label: string; instruction: string } | null>(null)
  const [showGaps, setShowGaps] = useState(true)

  const refreshList = () => api.matrices().then(setList).catch((e) => onError(message(e)))
  useEffect(() => {
    refreshList()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // While cells are being read, follow them.
  useEffect(() => {
    if (!matrix?.pending) return
    const t = window.setTimeout(() => {
      api
        .matrix(matrix.id)
        .then((m) => {
          setMatrix(m)
          if (!m.pending) refreshList()
        })
        .catch(() => {})
    }, 1200)
    return () => window.clearTimeout(t)
  }, [matrix]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  async function open(id: number) {
    setCreating(false)
    setCellAt(null)
    try {
      setMatrix(await api.matrix(id))
    } catch (e) {
      onError(message(e))
    }
  }

  async function run(label: string, fn: () => Promise<Matrix | void>) {
    setBusy(label)
    try {
      const m = await fn()
      if (m) setMatrix(m)
      refreshList()
    } catch (e) {
      onError(message(e))
    } finally {
      setBusy(null)
    }
  }

  const needle = query.trim().toLowerCase()
  const rows = useMemo(
    () =>
      !matrix
        ? []
        : !needle
          ? matrix.rows
          : matrix.rows.filter((r) =>
              `${r.title} ${r.label} ${Object.values(r.cells).map((c) => c.answer).join(' ')}`.toLowerCase().includes(needle),
            ),
    [matrix, needle],
  )

  const showNew = creating || (list !== null && list.length === 0 && !matrix)
  const done = matrix ? matrix.cells - matrix.pending : 0

  return (
    <section className="panel mx" aria-label="Review matrices">
      <nav className="mx-list" aria-label="Matrices">
        <div className="lib-nav-label">Review matrices</div>
        {(list ?? []).map((m) => (
          <button key={m.id} className={`mx-list-item${matrix?.id === m.id && !creating ? ' on' : ''}`} onClick={() => open(m.id)}>
            <span className="mx-list-name">{m.name}</span>
            <span className="muted">
              {m.papers} papers · {m.pending ? 'reading…' : `edited ${ago(m.updated_at)}`}
            </span>
          </button>
        ))}
        <button className="lib-nav-item lib-nav-new" onClick={() => (setCreating(true), setCellAt(null))}>
          <span className="lib-nav-ico" aria-hidden="true">+</span>
          <span className="lib-nav-name">New matrix</span>
        </button>
      </nav>

      <div className="mx-main">
        {showNew ? (
          <NewMatrix
            folders={folders}
            docs={docs}
            selected={selected}
            onError={onError}
            onCancel={list && list.length ? () => setCreating(false) : undefined}
            onCreated={(m) => {
              setCreating(false)
              setMatrix(m)
              refreshList()
            }}
          />
        ) : !matrix ? (
          <p className="empty">Open a matrix on the left, or make a new one.</p>
        ) : (
          <>
            <header className="mx-head">
              <div className="mx-title">
                {renaming ? (
                  <input
                    autoFocus
                    defaultValue={matrix.name}
                    aria-label="Matrix name"
                    onBlur={() => setRenaming(false)}
                    onKeyDown={(e) => {
                      const v = e.currentTarget.value.trim()
                      if (e.key === 'Escape') setRenaming(false)
                      if (e.key === 'Enter' && v) {
                        setRenaming(false)
                        run('Renaming…', () => api.updateMatrix(matrix.id, { name: v }))
                      }
                    }}
                  />
                ) : (
                  <h2 onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
                    {matrix.name}
                  </h2>
                )}
                <span className="muted">
                  {matrix.rows.length} papers · {matrix.columns.length} columns
                  {needle && ` · ${rows.length} shown`}
                </span>
              </div>
              <div className="mx-tools">
                <button onClick={() => run('Finding gaps…', () => api.matrixGaps(matrix.id).then((m) => (setShowGaps(true), m)))} disabled={!!matrix.pending || !!busy}>
                  Find gaps
                </button>
                <button onClick={() => setDialog('synthesis')} disabled={!!matrix.pending}>
                  Write from this matrix
                </button>
                <button onClick={() => setDialog('insert')} disabled={!!matrix.pending}>
                  Insert into draft
                </button>
                <div className="mx-menu-wrap" onMouseDown={(e) => e.stopPropagation()}>
                  <button onClick={() => setMenu(menu === 'export' ? null : 'export')} aria-haspopup="menu" aria-expanded={menu === 'export'}>
                    Export ▾
                  </button>
                  {menu === 'export' && (
                    <div className="lib-menu" role="menu">
                      {(
                        [
                          ['xlsx', 'Excel workbook', 'An answer column and an evidence column (page and quote) per question'],
                          ['csv', 'CSV', 'The same, for any spreadsheet or R/Python'],
                          ['docx', 'Word table', `Cells cite their sources in ${citationStyle.toUpperCase()}, with a reference list`],
                        ] as const
                      ).map(([fmt, title, hint]) => (
                        <button
                          key={fmt}
                          role="menuitem"
                          onClick={() => {
                            setMenu(null)
                            run('Exporting…', async () => {
                              const data = await api.exportMatrix(matrix.id, fmt, citationStyle)
                              await save(matrix.name, data, fmt)
                            })
                          }}
                        >
                          <b>{title}</b>
                          <span>{hint}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="mx-menu-wrap" onMouseDown={(e) => e.stopPropagation()}>
                  <button className="ghost lib-icon-btn" onClick={() => setMenu(menu === 'more' ? null : 'more')} aria-label="More" title="More">
                    ⋯
                  </button>
                  {menu === 'more' && (
                    <div className="lib-menu" role="menu">
                      <button role="menuitem" onClick={() => (setMenu(null), setEditingCol({ index: -1, label: '', instruction: '' }))}>
                        <b>Add a column</b>
                        <span>A new question, read for every paper</span>
                      </button>
                      <button role="menuitem" onClick={() => (setMenu(null), run('Reading again…', () => api.rerunMatrix(matrix.id)))}>
                        <b>Read every paper again</b>
                        <span>Replaces all answers, including ones you edited</span>
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenu(null)
                          if (window.confirm(`Delete “${matrix.name}”? The papers stay in your library.`)) {
                            run('Deleting…', async () => {
                              await api.deleteMatrix(matrix.id)
                              setMatrix(null)
                            })
                          }
                        }}
                      >
                        <b>Delete this matrix</b>
                        <span>The papers stay in your library</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {(matrix.pending > 0 || busy) && (
                <div className="mx-progress" role="status">
                  <span className="bar">
                    <span style={{ width: `${matrix.cells ? (100 * done) / matrix.cells : 0}%` }} />
                  </span>
                  {busy ?? `Reading papers: ${done} of ${matrix.cells} cells`}
                </div>
              )}
            </header>

            {editingCol && (
              <form
                className="mx-colform"
                onSubmit={(e) => {
                  e.preventDefault()
                  const cols = [...matrix.columns]
                  const c = { key: editingCol.index >= 0 ? cols[editingCol.index].key : '', label: editingCol.label.trim(), instruction: editingCol.instruction.trim(), query: '' }
                  if (editingCol.index >= 0) cols[editingCol.index] = { ...cols[editingCol.index], ...c, query: c.instruction === cols[editingCol.index].instruction ? cols[editingCol.index].query : '' }
                  else cols.push(c)
                  setEditingCol(null)
                  run('Updating columns…', () => api.updateMatrix(matrix.id, { columns: cols }))
                }}
              >
                <b>{editingCol.index >= 0 ? 'Edit column' : 'New column'}</b>
                <input autoFocus value={editingCol.label} onChange={(e) => setEditingCol({ ...editingCol, label: e.target.value })} placeholder="Name, e.g. Outcome measure" aria-label="Column name" />
                <input value={editingCol.instruction} onChange={(e) => setEditingCol({ ...editingCol, instruction: e.target.value })} placeholder="What to extract, in a sentence" aria-label="What to extract" />
                <button className="primary" disabled={!editingCol.label.trim()}>
                  {editingCol.index >= 0 ? 'Save' : 'Add and read'}
                </button>
                {editingCol.index >= 0 && (
                  <button
                    type="button"
                    className="danger"
                    disabled={matrix.columns.length < 2}
                    onClick={() => {
                      const cols = matrix.columns.filter((_, j) => j !== editingCol.index)
                      setEditingCol(null)
                      run('Removing column…', () => api.updateMatrix(matrix.id, { columns: cols }))
                    }}
                  >
                    Remove column
                  </button>
                )}
                <button type="button" onClick={() => setEditingCol(null)}>
                  Cancel
                </button>
                <span className="muted">Changing what a column asks reads it again for every paper, except answers you wrote.</span>
              </form>
            )}

            {matrix.gaps && matrix.gaps.length > 0 && (
              <section className="mx-gaps">
                <button className="mx-gaps-head" onClick={() => setShowGaps((s) => !s)} aria-expanded={showGaps}>
                  <b>Gaps across these studies</b>
                  <span className="muted">{showGaps ? 'Hide' : `Show ${matrix.gaps.length}`}</span>
                </button>
                {showGaps && (
                  <ul>
                    {matrix.gaps.map((g, i) => (
                      <li key={i}>
                        <b>{g.title}</b> {g.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            {matrix.gaps && matrix.gaps.length === 0 && <p className="muted mx-nogaps">No gaps stood out across these studies.</p>}

            <div className="mx-body">
              <div className="mx-table-wrap">
                <table className="mx-table">
                  <thead>
                    <tr>
                      <th className="mx-study">Study</th>
                      {matrix.columns.map((c, i) => (
                        <th key={c.key}>
                          <button onClick={() => setEditingCol({ index: i, label: c.label, instruction: c.instruction })} title={c.instruction || 'Edit this column'}>
                            {c.label}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.doc_id}>
                        <th className="mx-study" scope="row">
                          <b>{r.label}</b>
                          <span className="mx-study-title" title={r.title}>
                            {r.title}
                          </span>
                          <span className="mx-row-actions">
                            <button className="link" onClick={() => run('Reading again…', () => api.rerunMatrix(matrix.id, { doc_id: r.doc_id }))}>
                              Read again
                            </button>
                            <button className="link danger-link" onClick={() => run('Removing…', () => api.updateMatrix(matrix.id, { remove_doc_ids: [r.doc_id] }))}>
                              Remove
                            </button>
                          </span>
                        </th>
                        {matrix.columns.map((c) => {
                          const cell = r.cells[c.key]
                          const on = cellAt?.doc === r.doc_id && cellAt.col === c.key
                          return (
                            <td
                              key={c.key}
                              className={`mx-cell mx-${cell?.status ?? 'pending'}${on ? ' on' : ''}`}
                              onClick={() => setCellAt(on ? null : { doc: r.doc_id, col: c.key })}
                              title={cell ? STATUS_TEXT[cell.status] : undefined}
                            >
                              {!cell || cell.status === 'pending' ? (
                                <span className="mx-reading" />
                              ) : cell.status === 'not_reported' && !cell.answer ? (
                                <span className="mx-nr">Not reported</span>
                              ) : cell.status === 'error' ? (
                                <span className="mx-nr">Couldn't read: click to retry</span>
                              ) : (
                                <>
                                  <span className="mx-answer-text">{cell.answer}</span>
                                  <span className="mx-where">
                                    <span className="mx-dot" />
                                    {cell.label.split(', ').slice(-1)[0]}
                                    {cell.edited ? ' · edited' : ''}
                                  </span>
                                </>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 && <p className="empty">No study matches “{query.trim()}”.</p>}
              </div>
              {cellAt && (
                <CellPane
                  key={`${cellAt.doc}-${cellAt.col}`}
                  matrix={matrix}
                  docId={cellAt.doc}
                  col={cellAt.col}
                  docs={docs}
                  onSaved={setMatrix}
                  onRerun={() => run('Reading again…', () => api.rerunMatrix(matrix.id, { doc_id: cellAt.doc, column: cellAt.col }))}
                  onClose={() => setCellAt(null)}
                  onOpenPdf={onOpenPdf}
                />
              )}
            </div>

            {dialog === 'synthesis' && <SynthesisDialog matrix={matrix} onInsert={onInsertSentences} onClose={() => setDialog(null)} onError={onError} />}
            {dialog === 'insert' && <InsertTableDialog matrix={matrix} onInsert={onInsertTable} onClose={() => setDialog(null)} onError={onError} />}
          </>
        )}
      </div>
    </section>
  )
}
