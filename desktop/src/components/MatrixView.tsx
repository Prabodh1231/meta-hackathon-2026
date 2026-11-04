import { useEffect, useMemo, useRef, useState } from 'react'
import { MuseTag } from './MuseTag'
import { api } from '../api'
import {
  type DetailFilter, type DetailSort, NUMERIC, detailColumn, detailText, filterText, isDetail, passes, sortRows,
} from '../matrixDetails'
import type { Doc, DocxStyle, DraftSentence, FindingSummary, Folder, Matrix, MatrixCell, MatrixColumn, MatrixDetailField, MatrixPaper, MatrixSummary } from '../types'
import { ago } from './Meters'
import { SourceViewer, type SourceTarget } from './SourceViewer'
import { StatusBadge } from './StatusBadge'
import { WaitStatus } from './WaitStatus'
import { notifyDone, timeLeft } from '../notify'

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
  /** Put sentences written from the matrix into the draft; `finding` is the kept passage they came from. */
  onInsertSentences: (sentences: DraftSentence[], finding: number | null) => void
  /** Put a kept gap or passage into the draft, citing the matrix. */
  onInsertFinding: (id: number) => void
  /** Write a research proposal addressing this matrix's gaps. */
  onWriteProposal: (matrixId: number) => void
  /** Open this matrix (a citation in the draft asked for it); `at` makes each request new. */
  openRequest?: { id: number; at: number } | null
  /** The Matrix place is on screen: a matrix finishing while it isn't sends a desktop notification. */
  visible: boolean
}

const STATUS_TEXT: Record<MatrixCell['status'], string> = {
  pending: 'Reading…',
  found: 'Quote found on the page',
  unverified: "The quote wasn't found in the paper: check it",
  not_reported: 'Not reported in the passages read',
  error: "Couldn't read this",
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const FINDING_GAPS = 'Finding gaps…'

/** Under a gap or passage: what it is to the draft, and what can be done with it. */
function FindingMeta({ finding: f, isNew, earlier, onInsert, onDelete }: {
  finding?: FindingSummary
  isNew?: boolean
  earlier?: boolean // from an earlier Find gaps, kept because a draft cites it
  onInsert: () => void
  onDelete?: () => void
}) {
  return (
    <div className="mx-kept-meta muted">
      {isNew && <span className="mx-tag mx-tag-new">New</span>}
      {f?.in_draft && <span className="mx-tag">In your draft</span>}
      {earlier && <span>Found {f ? ago(f.created_at) : 'earlier'}</span>}
      {f?.kind === 'synthesis' && <span>{ago(f.created_at)}</span>}
      {f?.matrix_changed && <em className="flag">the matrix has changed since</em>}
      <button className="link" onClick={onInsert} title="Insert into the draft, citing every paper in this matrix">
        Insert into draft
      </button>
      {onDelete && (
        <button className="link danger-link" onClick={onDelete}>
          Delete
        </button>
      )}
    </div>
  )
}

/** One chip per paper detail; a lit chip is a column the matrix shows. */
function DetailChips({ fields, columns, onToggle, disabled }: {
  fields: MatrixDetailField[]
  columns: MatrixColumn[]
  onToggle: (field: MatrixDetailField, on: boolean) => void
  disabled?: boolean
}) {
  const shown = new Set(columns.filter(isDetail).map((c) => c.field))
  return (
    <div className="mx-chips" role="group" aria-label="Paper details">
      {fields.map((f) => (
        <button
          key={f.field}
          className={`mx-chip${shown.has(f.field) ? ' on' : ''}`}
          aria-pressed={shown.has(f.field)}
          disabled={disabled}
          onClick={() => onToggle(f, !shown.has(f.field))}
        >
          {f.label}
        </button>
      ))}
    </div>
  )
}

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
  const [fields, setFields] = useState<MatrixDetailField[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    api.matrixColumns().then(setColumns).catch((e) => onError(message(e)))
    api.matrixDetails().then(setFields).catch(() => {}) // an older backend has none
  }, [onError])
  const questionCount = columns.filter((c) => !isDetail(c)).length
  const detailCount = columns.length - questionCount

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
          {columns.map((c, i) => isDetail(c) ? null : (
            <div key={i} className="mx-col">
              <input value={c.label} onChange={(e) => setColumn(i, { label: e.target.value })} aria-label="Column name" className="mx-col-label" />
              <input value={c.instruction} onChange={(e) => setColumn(i, { instruction: e.target.value, query: '' })} aria-label="What to extract" placeholder="What to extract, in a sentence" />
              <button className="icon" onClick={() => setColumns((cs) => cs.filter((_, j) => j !== i))} aria-label={`Remove ${c.label}`} title="Remove this column">
                ×
              </button>
            </div>
          ))}
          {questionCount < 12 && (
            <button className="link" onClick={() => setColumns((cs) => [...cs, { key: '', label: '', instruction: '' }])}>
              + Add a column
            </button>
          )}
        </div>
        {fields.length > 0 && (
          <>
            <h4 className="mx-subhead">Paper details</h4>
            <p className="muted">From each paper's record (OpenAlex, Crossref and your library), shown as they are: no reading, no quotes.</p>
            <DetailChips
              fields={fields}
              columns={columns}
              onToggle={(f, on) => setColumns((cs) => (on ? [...cs, detailColumn(f.field, f.label)] : cs.filter((c) => c.field !== f.field || !isDetail(c))))}
            />
          </>
        )}
      </section>

      <section className="mx-step">
        <h3>3. Name</h3>
        <div className="mx-row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cryptocurrency adoption" aria-label="Matrix name" />
        </div>
      </section>

      <div className="mx-actions">
        <button className="primary" disabled={!chosen.size || !columns.length || columns.some((c) => !c.label.trim()) || !!busy} onClick={build}>
          Build the matrix ({chosen.size} papers × {questionCount} questions{detailCount ? ` + ${detailCount} details` : ''})
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
  onInsert: (sentences: DraftSentence[], finding: number | null) => void
  onClose: () => void
  onError: (msg: string) => void
}) {
  const [instruction, setInstruction] = useState('')
  const [cols, setCols] = useState<Set<string>>(new Set(matrix.columns.map((c) => c.key)))
  const [sentences, setSentences] = useState<DraftSentence[] | null>(null)
  const [finding, setFinding] = useState<number | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [busyAt, setBusyAt] = useState(0)

  async function write() {
    setBusy(true)
    setBusyAt(Date.now())
    setSentences(null)
    try {
      const res = await api.matrixSynthesis(matrix.id, instruction.trim(), [...cols])
      setSentences(res.sentences)
      setFinding(res.finding)
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
        {busy && <WaitStatus label="Muse is writing from the matrix…" startedAt={busyAt} usual="This usually takes 15 to 45 seconds." />}
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
                  onInsert(sentences.filter((_, i) => picked.has(i)), finding)
                  onClose()
                }}
              >
                Insert {picked.size} into the draft
              </button>
              <span className="muted">
                Kept with the matrix. In the draft its citations show in blue and are checked against the matrix.
              </span>
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

export function MatrixView({ docs, folders, selected, query, citationStyle, onError, onOpenPdf, onInsertTable, onInsertSentences, onInsertFinding, onWriteProposal, openRequest, visible }: Props) {
  const [list, setList] = useState<MatrixSummary[] | null>(null)
  const [matrix, setMatrix] = useState<Matrix | null>(null)
  const [creating, setCreating] = useState(false)
  const [cellAt, setCellAt] = useState<{ doc: number; col: string } | null>(null)
  const [dialog, setDialog] = useState<'synthesis' | 'insert' | null>(null)
  const [menu, setMenu] = useState<'export' | 'more' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [busyAt, setBusyAt] = useState(0)
  // Reading cells: the first time and count seen, for "about 2 min left".
  const readingFrom = useRef<{ id: number; at: number; done: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [editingCol, setEditingCol] = useState<{ index: number; label: string; instruction: string } | null>(null)
  const [showGaps, setShowGaps] = useState(false) // collapsed, so the table shows first
  const [kept, setKept] = useState<FindingSummary[] | null>(null) // gaps and passages kept for the draft
  const [fresh, setFresh] = useState<Set<number>>(new Set()) // gaps the latest Find gaps added to earlier ones
  const [fields, setFields] = useState<MatrixDetailField[]>([])
  const [panel, setPanel] = useState<'details' | 'filter' | null>(null)
  const [sort, setSort] = useState<DetailSort | null>(null)
  const [filters, setFilters] = useState<DetailFilter[]>([])
  const [draft, setDraft] = useState<{ field: string; min: string; max: string; text: string }>({ field: 'year', min: '', max: '', text: '' })
  const [detailColsShown, setDetailColsShown] = useState(false) // paper-detail columns stay behind Paper details until asked for
  const [expandedCells, setExpandedCells] = useState<Set<string>>(new Set()) // long answers opened in place

  useEffect(() => {
    api.matrixDetails().then(setFields).catch(() => {})
  }, [])

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
          if (!m.pending) {
            refreshList()
            notifyDone(`“${m.name}” is ready`, `Muse finished reading ${m.cells} cells.`, !visible)
          }
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

  // Kept findings follow the matrix: a new run of Find gaps or Write adds to them, an edit can make them outdated.
  useEffect(() => {
    if (!matrix || matrix.pending) return
    let live = true
    api
      .matrixFindings(matrix.id)
      .then((f) => live && setKept(f))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [matrix, dialog])

  useEffect(() => {
    if (openRequest) open(openRequest.id)
  }, [openRequest]) // eslint-disable-line react-hooks/exhaustive-deps

  async function removeKept(f: FindingSummary) {
    const what = f.kind === 'gap' ? `the gap “${f.title}”` : 'this written passage'
    if (!window.confirm(`Delete ${what}? Citations to it in your drafts keep their colour but can no longer be checked against the matrix.`)) return
    try {
      await api.deleteFinding(f.id)
      setKept((k) => k?.filter((x) => x.id !== f.id) ?? null)
    } catch (e) {
      onError(message(e))
    }
  }

  async function open(id: number) {
    setKept(null)
    setFresh(new Set())
    setCreating(false)
    setCellAt(null)
    setSort(null)
    setFilters([])
    setDetailColsShown(false)
    setExpandedCells(new Set())
    try {
      setMatrix(await api.matrix(id))
    } catch (e) {
      onError(message(e))
    }
  }

  /** Gaps from a new run replace the earlier ones (but those a draft cites); new ones are marked. */
  function findGaps() {
    if (!matrix) return
    // New is by wording: the same gap from an edited matrix is kept again under a new id.
    const said = (g: { title: string; detail: string }) => `${g.title}
${g.detail}`
    const before = matrix.gaps ? new Set(matrix.gaps.map(said)) : null
    setShowGaps(true)
    run(FINDING_GAPS, async () => {
      const m = await api.matrixGaps(matrix.id)
      setFresh(new Set(before ? (m.gaps ?? []).filter((g) => !before.has(said(g))).map((g) => g.id) : []))
      return m
    })
  }

  async function run(label: string, fn: () => Promise<Matrix | void>) {
    setBusy(label)
    setBusyAt(Date.now())
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

  const latestGaps = new Set(matrix?.gaps?.map((g) => g.id) ?? [])
  const keptById = new Map((kept ?? []).map((f) => [f.id, f]))
  const earlierGaps = (kept ?? []).filter((f) => f.kind === 'gap' && !latestGaps.has(f.id))
  const passages = (kept ?? []).filter((f) => f.kind === 'synthesis')

  const needle = query.trim().toLowerCase()
  const doc = (id: number) => docs.find((d) => d.id === id) // a row's paper, for its page links
  const rows = useMemo(() => {
    if (!matrix) return []
    const shown = matrix.rows.filter(
      (r) =>
        (!needle || `${r.title} ${r.label} ${Object.values(r.cells).map((c) => c.answer).join(' ')}`.toLowerCase().includes(needle)) &&
        filters.every((f) => passes(r, f)),
    )
    return sortRows(shown, sort)
  }, [matrix, needle, filters, sort])
  const labelOf = (field: string) => fields.find((f) => f.field === field)?.label ?? field
  const toggleDetail = (f: MatrixDetailField, on: boolean) => {
    if (!matrix) return
    const cols = on ? [...matrix.columns, detailColumn(f.field, f.label)] : matrix.columns.filter((c) => !(isDetail(c) && c.field === f.field))
    if (!on && sort?.field === f.field) setSort(null)
    if (on) setDetailColsShown(true)
    run(on ? 'Adding…' : 'Removing…', () => api.updateMatrix(matrix.id, { columns: cols }))
  }
  const addFilter = () => {
    const f: DetailFilter = NUMERIC.has(draft.field)
      ? { field: draft.field, min: draft.min.trim() ? Number(draft.min) : undefined, max: draft.max.trim() ? Number(draft.max) : undefined }
      : { field: draft.field, text: draft.text.trim() }
    if (f.min == null && f.max == null && !f.text) return
    setFilters((fs) => [...fs.filter((x) => x.field !== f.field), f])
    setDraft({ ...draft, min: '', max: '', text: '' })
  }
  const narrowed = needle !== '' || filters.length > 0
  const sortedBy = (c: MatrixColumn): 0 | 1 | -1 => (sort && sort.field === c.field ? sort.dir : 0)
  /** First click: most or newest first for numbers, A to Z for text; then the other way; then as added. */
  const sortBy = (field: string) => {
    const first: 1 | -1 = NUMERIC.has(field) ? -1 : 1
    setSort((s) => (!s || s.field !== field ? { field, dir: first } : s.dir === first ? { field, dir: -first as 1 | -1 } : null))
  }

  const visibleColumns = matrix ? matrix.columns.filter((c) => !isDetail(c) || detailColsShown) : []
  const hiddenDetailCount = matrix && !detailColsShown ? matrix.columns.filter(isDetail).length : 0
  const showNew = creating || (list !== null && list.length === 0 && !matrix)
  const done = matrix ? matrix.cells - matrix.pending : 0
  if (!matrix?.pending) readingFrom.current = null
  else if (readingFrom.current?.id !== matrix.id) readingFrom.current = { id: matrix.id, at: Date.now(), done }
  const left = matrix?.pending && readingFrom.current
    ? timeLeft(matrix.pending, done - readingFrom.current.done, (Date.now() - readingFrom.current.at) / 1000)
    : ''

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
          <div className="mx-empty">
            <h3>Compare papers side by side</h3>
            <p>
              A review matrix has one row per paper and one column per question (sample, setting, method, findings…). Muse reads
              each paper and answers every question with a quote and its page, so each cell can be checked. From a matrix you can
              find gaps across the studies and write a comparison with citations.
            </p>
            <div className="row">
              {(() => {
                const recent = [...(list ?? [])].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0]
                return recent ? (
                  <button className="primary" onClick={() => open(recent.id)}>
                    Open “{recent.name}” · {recent.papers} papers
                  </button>
                ) : null
              })()}
              <button onClick={() => (setCreating(true), setCellAt(null))}>New matrix</button>
            </div>
          </div>
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
                  {matrix.rows.length} papers · {matrix.columns.filter((c) => !isDetail(c)).length} questions
                  {matrix.columns.some(isDetail) && ` · ${matrix.columns.filter(isDetail).length} details`}
                  {` · ${visibleColumns.length} of ${matrix.columns.length} columns shown`}
                  {narrowed && ` · ${rows.length} shown`}
                  <span className="mx-how"> · each answer shows the page its quote is on: click it to read the quote</span>
                </span>
              </div>
              <div className="mx-tools">
                {fields.length > 0 && (
                  <>
                    <button className={panel === 'details' ? 'on' : ''} aria-expanded={panel === 'details'} onClick={() => {
                        const next = panel === 'details' ? null : 'details'
                        setPanel(next)
                        if (next === 'details') setDetailColsShown(true)
                      }}
                      title="Show the papers' year, journal, citations, abstract… as columns">
                      Paper details
                    </button>
                    <button className={panel === 'filter' || filters.length ? 'on' : ''} aria-expanded={panel === 'filter'} onClick={() => setPanel(panel === 'filter' ? null : 'filter')}
                      title="Show only papers from some years, a journal, with enough citations…">
                      Filter{filters.length ? ` (${filters.length})` : ''}
                    </button>
                  </>
                )}
                {/* Three groups: look at the matrix, analyse it, write from it (the one main action) */}
                <span className="mx-tool-sep" aria-hidden="true" />
                <button onClick={findGaps} disabled={!!matrix.pending || !!busy} title="Muse names what these studies leave out and where they disagree">
                  Find gaps
                </button>
                <button onClick={() => onWriteProposal(matrix.id)} disabled={!!matrix.pending} title="A research proposal for a study that addresses this review's gaps">
                  Write a proposal
                </button>
                <span className="mx-tool-sep" aria-hidden="true" />
                <button className="primary" onClick={() => setDialog('synthesis')} disabled={!!matrix.pending} title="Muse writes a comparison of the studies, each sentence citing its quotes">
                  Write from this matrix
                </button>
                <div className="mx-menu-wrap" onMouseDown={(e) => e.stopPropagation()}>
                  <button onClick={() => setMenu(menu === 'export' ? null : 'export')} aria-haspopup="menu" aria-expanded={menu === 'export'}>
                    Insert or export ▾
                  </button>
                  {menu === 'export' && (
                    <div className="lib-menu" role="menu">
                      <button role="menuitem" onClick={() => (setMenu(null), setDialog('insert'))}>
                        <b>Insert into draft</b>
                        <span>The matrix as a table at the cursor; each cell cites its quote</span>
                      </button>
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
                        <b>Add a question</b>
                        <span>A new column Muse reads for every paper</span>
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
              {busy && busy !== FINDING_GAPS ? ( // finding gaps waits in the gaps box
                <WaitStatus label={busy} startedAt={busyAt} usual="This usually takes 10 to 40 seconds." />
              ) : (
                matrix.pending > 0 && (
                  <div className="mx-progress" role="status">
                    <span className="bar">
                      <span style={{ width: `${matrix.cells ? (100 * done) / matrix.cells : 0}%` }} />
                    </span>
                    Reading papers: {done} of {matrix.cells} cells{left && ` · ${left}`}
                  </div>
                )
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

            {panel === 'details' && (
              <section className="mx-panel" aria-label="Paper details">
                <span className="muted">Show as columns, straight from each paper's record. Click a detail's header to sort by it.</span>
                <DetailChips fields={fields} columns={matrix.columns} onToggle={toggleDetail} disabled={!!busy} />
                <button className={detailColsShown ? 'on' : ''} aria-pressed={detailColsShown} disabled={!matrix.columns.some(isDetail)} onClick={() => setDetailColsShown((s) => !s)}>
                  {detailColsShown ? 'Detail columns shown' : 'Show detail columns'}
                </button>
                {hiddenDetailCount > 0 && <span className="muted">{hiddenDetailCount} hidden from the table until shown here.</span>}
              </section>
            )}
            {(panel === 'filter' || filters.length > 0) && (
              <section className="mx-panel mx-filters" aria-label="Filter papers">
                {panel === 'filter' && (
                  <form
                    className="mx-filter-form"
                    onSubmit={(e) => {
                      e.preventDefault()
                      addFilter()
                    }}
                  >
                    <select value={draft.field} onChange={(e) => setDraft({ ...draft, field: e.target.value })} aria-label="Detail to filter by">
                      {fields.map((f) => (
                        <option key={f.field} value={f.field}>{f.label}</option>
                      ))}
                    </select>
                    {NUMERIC.has(draft.field) ? (
                      <>
                        <input type="number" value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })}
                          placeholder={draft.field === 'year' ? 'From' : 'At least'} aria-label="From" />
                        <input type="number" value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })}
                          placeholder={draft.field === 'year' ? 'To' : 'At most'} aria-label="To" />
                      </>
                    ) : (
                      <input value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} placeholder="Contains…" aria-label="Contains" />
                    )}
                    <button className="primary">Add filter</button>
                  </form>
                )}
                {filters.map((f) => (
                  <span key={f.field} className="tag mx-filter-chip">
                    {filterText(f, labelOf(f.field))}
                    <button className="tag-x" onClick={() => setFilters((fs) => fs.filter((x) => x !== f))} aria-label={`Remove the ${labelOf(f.field)} filter`}>×</button>
                  </span>
                ))}
                {filters.length > 0 && (
                  <span className="muted">
                    {rows.length} of {matrix.rows.length} papers · papers without the detail are left out
                  </span>
                )}
              </section>
            )}

            {(busy === FINDING_GAPS || matrix.gaps !== null || earlierGaps.length > 0 || passages.length > 0) && (
              <section className="mx-gaps">
                <button className="mx-gaps-head" onClick={() => setShowGaps((s) => !s)} aria-expanded={showGaps}>
                  <span className="mx-gaps-title">
                    <b>Gaps across these studies</b> <MuseTag from="this matrix's cells" />
                  </span>
                  <span className="muted">{showGaps ? 'Hide' : `Show ${(matrix.gaps?.length ?? 0) + earlierGaps.length + passages.length}`}</span>
                </button>
                {showGaps && (
                  <div className="mx-gaps-body">
                    {busy === FINDING_GAPS && <WaitStatus label={busy} startedAt={busyAt} usual="This usually takes 10 to 40 seconds." />}
                    {matrix.gaps?.length === 0 && busy !== FINDING_GAPS && <p className="muted">No gaps stood out across these studies.</p>}
                    {(matrix.gaps?.length ?? 0) + earlierGaps.length > 0 && (
                      <ul>
                        {matrix.gaps?.map((g) => (
                          <li key={g.id}>
                            <b>{g.title}</b> <GapText text={g.detail} rows={rows} />
                            <FindingMeta
                              finding={keptById.get(g.id)}
                              isNew={fresh.has(g.id)}
                              onInsert={() => onInsertFinding(g.id)}
                            />
                          </li>
                        ))}
                        {earlierGaps.map((f) => (
                          <li key={f.id} className="mx-earlier">
                            <b>{f.title}</b> <GapText text={f.text} rows={rows} />
                            <FindingMeta finding={f} earlier onInsert={() => onInsertFinding(f.id)} onDelete={() => removeKept(f)} />
                          </li>
                        ))}
                      </ul>
                    )}
                    {passages.length > 0 && (
                      <>
                        <div className="eyebrow mx-passages-label">Written from this matrix</div>
                        <ul className="mx-passages">
                          {passages.map((f) => (
                            <li key={f.id}>
                              <span className="mx-kept-text">{f.text}</span>
                              <FindingMeta finding={f} onInsert={() => onInsertFinding(f.id)} onDelete={() => removeKept(f)} />
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </section>
            )}

            <div className="mx-body">
              <div className="mx-table-wrap">
                <div className="mx-col-count" role="status">
                  <span>
                    {visibleColumns.length} of {matrix.columns.length} columns shown
                    {hiddenDetailCount > 0 && ` · ${hiddenDetailCount} paper-detail column${hiddenDetailCount === 1 ? '' : 's'} hidden: open Paper details to show ${hiddenDetailCount === 1 ? 'it' : 'them'}`}
                  </span>
                  <span className="mx-legend">
                    <span className="mx-dot" aria-hidden="true">✓</span> quote found on the page shown ·{' '}
                    <span className="mx-needs-check">Needs check</span> the quote wasn’t found — check it before you rely on it
                  </span>
                  {visibleColumns.length > 1 && <span className="mx-scroll-cue">Scroll sideways → more columns · the Study column stays in view</span>}
                </div>
                <table className="mx-table">
                  <thead>
                    <tr>
                      <th className="mx-study">Study</th>
                      {visibleColumns.map((c) =>
                        isDetail(c) ? (
                          <th key={c.key} className="mx-detail-h" aria-sort={sortedBy(c) === 1 ? 'ascending' : sortedBy(c) === -1 ? 'descending' : 'none'}>
                            <button onClick={() => sortBy(c.field!)} title={`From each paper's record. Click to sort by ${c.label.toLowerCase()}.`}>
                              {c.label}
                              <span className="sort-arrow" aria-hidden="true">{sortedBy(c) === 1 ? '▲' : sortedBy(c) === -1 ? '▼' : ''}</span>
                            </button>
                          </th>
                        ) : (
                          <th key={c.key}>
                            <button onClick={() => setEditingCol({ index: matrix.columns.indexOf(c), label: c.label, instruction: c.instruction })} title={c.instruction || 'Edit this column'}>
                              {c.label}
                            </button>
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.doc_id} id={`mx-row-${r.doc_id}`}>
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
                        {visibleColumns.map((c) => {
                          if (isDetail(c)) {
                            const text = detailText(r.details[c.field!], c.field)
                            return (
                              <td key={c.key} className={`mx-cell mx-detail mx-detail-${c.field}`} title={text.length > 120 ? text : undefined}>
                                {text ? <span className="mx-detail-text">{text}</span> : <span className="mx-nr">—</span>}
                              </td>
                            )
                          }
                          const cell = r.cells[c.key]
                          const on = cellAt?.doc === r.doc_id && cellAt.col === c.key
                          const cellKey = `${r.doc_id}:${c.key}`
                          const expanded = expandedCells.has(cellKey)
                          const pagePart = cell?.label.split(', ').slice(-1)[0] ?? ''
                          const printedPage = pagePart.match(/^p\. ([\w-]+)$/)?.[1]
                          const pageText = printedPage ? `Printed p. ${printedPage}` : cell?.page ? `PDF page ${cell.page}` : pagePart
                          const pageTitle =
                            printedPage && cell?.page
                              ? `Printed page ${printedPage} · PDF page ${cell.page}: open the PDF at this page`
                              : cell?.page
                                ? `PDF page ${cell.page}: open the PDF at this page`
                                : pagePart
                          return (
                            <td
                              key={c.key}
                              className={`mx-cell mx-${cell?.status ?? 'pending'}${on ? ' on' : ''}`}
                              onClick={() => setCellAt(on ? null : { doc: r.doc_id, col: c.key })}
                              // Reachable with Tab; Enter or Space opens the quote, as a click does.
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter' && e.key !== ' ') return
                                e.preventDefault()
                                setCellAt(on ? null : { doc: r.doc_id, col: c.key })
                              }}
                              aria-expanded={on}
                              title={cell ? `${STATUS_TEXT[cell.status]} · click for the quote` : undefined}
                            >
                              {!cell || cell.status === 'pending' ? (
                                <span className="mx-reading" />
                              ) : cell.status === 'not_reported' && !cell.answer ? (
                                <span className="mx-nr">Not reported</span>
                              ) : cell.status === 'error' ? (
                                <span className="mx-nr">Couldn't read: click to retry</span>
                              ) : (
                                <>
                                  <span className={`mx-answer-text${expanded ? ' expanded' : ''}`}>{cell.answer}</span>
                                  {cell.answer.length > 160 && (
                                    <button
                                      className="link mx-expand"
                                      aria-expanded={expanded}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setExpandedCells((s) => {
                                          const n = new Set(s)
                                          if (n.has(cellKey)) n.delete(cellKey)
                                          else n.add(cellKey)
                                          return n
                                        })
                                      }}
                                    >
                                      {expanded ? 'Show less' : 'Show more'}
                                    </button>
                                  )}
                                  <span className="mx-where">
                                    {/* ✓ the quote was found on that page; ? it wasn't, so check it */}
                                    <span className="mx-dot" aria-hidden="true">{cell.status === 'unverified' ? '?' : '✓'}</span>
                                    {doc(r.doc_id)?.kind === 'pdf' && cell.page ? (
                                      <button
                                        className="mx-page-chip"
                                        onClick={(e) => (e.stopPropagation(), onOpenPdf(doc(r.doc_id)!, cell.page!))}
                                        title={pageTitle}
                                      >
                                        {pageText}
                                      </button>
                                    ) : (
                                      <span className="mx-page-chip" title={pageTitle}>
                                        {pageText}
                                      </span>
                                    )}
                                    {cell.status === 'unverified' && (
                                      <span className="mx-needs-check" title="The quote wasn’t found in the paper: check it">
                                        Needs check
                                      </span>
                                    )}
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
                {rows.length === 0 && (
                  <p className="empty">
                    {needle ? `No study matches “${query.trim()}”` : 'No study passes these filters'}
                    {filters.length > 0 && (
                      <>
                        {' · '}
                        <button className="link" onClick={() => setFilters([])}>Clear the filters</button>
                      </>
                    )}
                  </p>
                )}
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

/** Gap text with each study it names ("Saputra & Darma 2022") as a link to that study's row. */
function GapText({ text, rows }: { text: string; rows: { doc_id: number; label: string }[] }) {
  const byLabel = new Map<string, number>()
  for (const r of rows) if (r.label && !byLabel.has(r.label)) byLabel.set(r.label, r.doc_id)
  if (!byLabel.size) return <>{text}</>
  const escape = (l: string) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(${[...byLabel.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')})`, 'g')
  return (
    <>
      {text.split(pattern).map((part, i) => {
        const id = byLabel.get(part)
        if (id == null) return part
        return (
          <button key={i} className="link mx-gap-ref" onClick={() => jumpToRow(id)} title="Show this study's row">
            {part}
          </button>
        )
      })}
    </>
  )
}

function jumpToRow(docId: number) {
  const row = document.getElementById(`mx-row-${docId}`)
  if (!row) return
  row.scrollIntoView({ behavior: 'smooth', block: 'center' })
  row.classList.remove('mx-row-flash')
  void row.offsetWidth // restart the animation
  row.classList.add('mx-row-flash')
}
