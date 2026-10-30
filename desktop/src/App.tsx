import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_VERSION, api, backendLogPath } from './api'
import { AssistantPanel } from './components/AssistantPanel'
import { CitationWire } from './components/CitationWire'
import { CitePanel } from './components/CitePanel'
import type { CiteMarkAttrs } from './editor/citeMark'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import { CitedPapersDialog } from './components/CitedPapersDialog'
import { DraftsPanel } from './components/DraftsPanel'
import { DuplicateFilesDialog } from './components/DuplicateFilesDialog'
import { ExportControl } from './components/ExportControl'
import { GettingStarted } from './components/GettingStarted'
import { HistoryPanel } from './components/HistoryPanel'
import { Icon, type IconName } from './components/Icon'
import { LibraryPanel } from './components/LibraryPanel'
import { ago, toneOf } from './components/Meters'
import { MissingPapersDialog } from './components/MissingPapersDialog'
import { PdfViewerDialog } from './components/PdfViewerDialog'
import { ReferencesPanel } from './components/ReferencesPanel'
import { ReviewPanel } from './components/ReviewPanel'
import { DEFAULT_SETTINGS, SettingsDialog } from './components/SettingsDialog'
import { WordImportDialog, convertedSummary, simplifiedNotes } from './components/WordImportDialog'
import { applyTheme, cacheTheme, cachedTheme, watchSystemTheme } from './theme'
import { SourceViewer, type SourceTarget } from './components/SourceViewer'
import {
  WritingEditor,
  type ChipAttrs,
  type DraftStats,
  type SaveState,
  type WritingEditorHandle,
} from './components/WritingEditor'
import type {
  Citation,
  Doc,
  DocxConversion,
  DraftSummary,
  DuplicateReport,
  Folder,
  Health,
  IngestJob,
  Settings,
  SourceMatch,
  VersionList,
} from './types'

/** The three places in the app: the draft, the library, and the citation network. */
type Mode = 'write' | 'library' | 'network'
const MODES: { mode: Mode; label: string; icon: IconName; hint: string }[] = [
  { mode: 'write', label: 'Write', icon: 'write', hint: 'Your draft, with the writing tools beside it' },
  { mode: 'library', label: 'Library', icon: 'library', hint: 'Add, organize and pick your sources' },
  { mode: 'network', label: 'Network', icon: 'network', hint: 'Who cites whom in your library' },
]

/** The tabs of the panel beside the draft, in the order you use them while writing. */
type Tab = 'assistant' | 'citations' | 'references' | 'review' | 'history'
const TABS: { tab: Tab; label: string; icon: IconName; hint: string }[] = [
  { tab: 'assistant', label: 'Assistant', icon: 'assistant', hint: 'Draft from your library with cited quotes' },
  { tab: 'citations', label: 'Citations', icon: 'cite', hint: 'Confirm cite markers and see each quote on its page' },
  { tab: 'references', label: 'References', icon: 'references', hint: 'Reference list for the sources you cite' },
  { tab: 'review', label: 'Review', icon: 'review', hint: 'Repeated passages and text matching your sources' },
  { tab: 'history', label: 'History', icon: 'history', hint: 'Versions of the draft and what changed' },
]
const TAB = Object.fromEntries(TABS.map((t) => [t.tab, t])) as Record<Tab, (typeof TABS)[number]>

/** What the one search box does in each place. */
const SEARCH: Record<Exclude<Mode, 'write'>, { scope: string; placeholder: string }> = {
  library: { scope: 'Library', placeholder: 'Filter by title, author, keyword, JEL code…' },
  network: { scope: 'Network', placeholder: 'Search a topic: blockchain, financial inclusion…' },
}

const PROVIDER_NAMES: Record<string, string> = { muse: 'Muse', mock: 'Offline mock' }

/** "Muse · BGE-M3 (GPU)": a short form of the backend's model ids. */
function modelLine(h: Health): string {
  const model = h.embedder.split(':').slice(1).join(':').split('/').pop() || h.embedder
  const embedder = model.replace(/-en-v[\d.]+$/, '').replace(/^bge/, 'BGE').replace('-m3', '-M3')
  const device = h.embedder_device === 'cuda' ? ' (GPU)' : ''
  return `${PROVIDER_NAMES[h.provider] ?? h.provider} · ${embedder}${device}`
}

// Whether the writing tools are open beside the draft; Settings can override it at launch.
const TOOLS_KEY = 'rc.toolsOpen'
function storedToolsOpen(): boolean {
  try {
    return localStorage.getItem(TOOLS_KEY) !== '0'
  } catch {
    return true
  }
}

const GUIDE_KEY = 'rc.gettingStartedHidden'
function guideHidden(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) === '1'
  } catch {
    return false
  }
}

// The draft that was open last time, reopened on launch.
const DRAFT_KEY = 'rc.draftId'
function initialDraft(): number {
  try {
    const v = Number(localStorage.getItem(DRAFT_KEY))
    if (Number.isInteger(v) && v > 0) return v
  } catch {
    /* storage unavailable */
  }
  return 1
}

// The graph library is a large part of the bundle and only this view uses it, so it loads on
// first open instead of slowing every launch.
const NetworkView = lazy(() => import('./components/NetworkView').then((m) => ({ default: m.NetworkView })))

// What the library can read (the file picker in electron/main.cjs offers the same list).
const LIBRARY_TYPES = /\.(pdf|docx|pptx|md|markdown|txt|html?|png|jpe?g|webp)$/i
const WORD_FILE = /\.docx$/i

function importNotice(how: string, name: string, c: DocxConversion): string {
  const notes = simplifiedNotes(c.imported)
  return `${how} “${name}”: ${convertedSummary(c.imported)}.${notes.length ? ` ${notes.join('; ')}.` : ''}`
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')

function saveText(s: SaveState): string {
  if (s.state === 'saving') return 'Saving…'
  if (s.state === 'error') return 'Not saved'
  if (s.state === 'saved') return s.at ? `Saved ${ago(s.at)}` : 'Saved'
  return 'Loading…'
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [docs, setDocs] = useState<Doc[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [mode, setMode] = useState<Mode>('write')
  const [tab, setTab] = useState<Tab>('assistant')
  const [source, setSource] = useState<(SourceTarget & { cid?: string }) | null>(null)
  const [sourceFrom, setSourceFrom] = useState<Tab | null>(null) // showing `source`, opened from this tab
  const [libQuery, setLibQuery] = useState('')
  const [netQuery, setNetQuery] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [draftId, setDraftId] = useState(initialDraft)
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [draftsOpen, setDraftsOpen] = useState(false) // the drafts menu under the title
  const [draftsBusy, setDraftsBusy] = useState<string | null>(null)
  const [hideGuide, setHideGuide] = useState(guideHidden)
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS, theme: cachedTheme() })
  const [showSettings, setShowSettings] = useState(false)
  const [dupFilesOpen, setDupFilesOpen] = useState(false)
  const [citeMarks, setCiteMarks] = useState<CiteMarkAttrs[]>([]) // "cite" markers in the draft, searching or waiting
  const [citeFocus, setCiteFocus] = useState<string | null>(null) // the marker the Citations tab is showing
  const [citedFor, setCitedFor] = useState<number | null>(null) // paper whose cited works are listed
  const [missingQuery, setMissingQuery] = useState<string | null>(null) // topic of the most-cited missing works
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [pdfView, setPdfView] = useState<{ doc: Doc; page: number } | null>(null) // a PDF in the app's viewer
  const openPdf = useCallback((doc: Doc, page = 1) => setPdfView({ doc, page }), [])
  const [toolsOpen, setToolsOpen] = useState(storedToolsOpen) // the writing tools beside the draft
  const [focusMode, setFocusMode] = useState(false) // only the page and its toolbar
  const [stats, setStats] = useState<DraftStats>({ words: 0, citations: 0, verified: 0, flagged: 0, unconfirmed: 0 })
  const [title, setTitle] = useState('Untitled')
  const [saveState, setSaveState] = useState<SaveState>({ state: 'idle' })
  const [versions, setVersions] = useState<VersionList | null>(null)
  // `error` stops the automatic re-checks after a failure until the user asks again.
  const [dup, setDup] = useState<{ report: DuplicateReport | null; at: number | null; busy: boolean; stale: boolean; error: string | null }>({
    report: null,
    at: null,
    busy: false,
    stale: false,
    error: null,
  })
  const [, setTick] = useState(0) // re-renders "Saved 3 min ago"
  const editor = useRef<WritingEditorHandle>(null)
  const [importing, setImporting] = useState<File | null>(null) // the Word file in the import dialog
  const wordInput = useRef<HTMLInputElement>(null)
  const draftsMenu = useRef<HTMLDivElement>(null)
  const [dropping, setDropping] = useState(false) // files dragged over the window
  const [jobs, setJobs] = useState<IngestJob[]>([]) // background imports, newest first
  // Papers the draft cites, for the library to mark. Recounted whenever the draft's stats change,
  // but a new list only when the papers do, so the library doesn't redraw at every pause in typing.
  const citedKey = useMemo(() => (editor.current?.citedDocIds() ?? []).join(','), [stats, draftId]) // eslint-disable-line react-hooks/exhaustive-deps
  const citedIds = useMemo(() => (citedKey ? citedKey.split(',').map(Number) : []), [citedKey])

  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30000)
    return () => window.clearInterval(t)
  }, [])

  const openLibrary = useCallback(() => setMode('library'), [])
  const [libFocus, setLibFocus] = useState<{ id: number; n: number } | null>(null)
  const showPaper = useCallback((id: number) => {
    setMode('library')
    setLibFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }))
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(TOOLS_KEY, toolsOpen ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [toolsOpen])

  /** Bring the writing tools into view: back to the draft, out of focus mode, panel open. */
  const revealTools = useCallback(() => {
    setMode('write')
    setFocusMode(false)
    setToolsOpen(true)
  }, [])

  /** Show a tab of the panel beside the draft. */
  const showTab = useCallback(
    (t: Tab) => {
      revealTools()
      setTab(t)
      setSourceFrom(null)
    },
    [revealTools],
  )

  /** Show a cited passage on its page, in the Citations tab; "back" returns to `from`. */
  function showSource(target: SourceTarget & { cid?: string }, from: Tab = tab) {
    setSource(target)
    setSourceFrom(sourceFrom ?? from)
    revealTools()
    setTab('citations')
  }

  const toggleFocus = useCallback(() => {
    setFocusMode((f) => {
      if (!f) setMode('write')
      return !f
    })
  }, [])

  const pickWord = useCallback(() => wordInput.current?.click(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        pickWord()
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newDraftRef.current()
      } else if (mod && !e.shiftKey && e.key === '\\') {
        e.preventDefault()
        if (mode === 'write' && !focusMode) setToolsOpen((o) => !o)
        else revealTools()
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        toggleFocus()
      } else if (e.key === 'Escape' && !paletteOpen && !importing && !pdfView) {
        if (focusMode) setFocusMode(false)
        else if (draftsOpen) setDraftsOpen(false)
        // Esc on the page itself (not in a field or the library table) goes back to the draft.
        else if (mode !== 'write' && e.target === document.body) setMode('write')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, importing, pdfView, pickWord, draftsOpen, mode, focusMode, revealTools, toggleFocus])

  // The drafts menu closes on a click anywhere else.
  useEffect(() => {
    if (!draftsOpen) return
    const close = (e: MouseEvent) => !draftsMenu.current?.contains(e.target as Node) && setDraftsOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [draftsOpen])

  const onError = useCallback((msg: string) => setErrors((e) => [...e.slice(-2), msg]), [])

  useEffect(() => {
    applyTheme(settings.theme)
    cacheTheme(settings.theme)
    return watchSystemTheme(settings.theme)
  }, [settings.theme])

  // The page's width, text size and font (styles.css reads these from <html>).
  useEffect(() => {
    const root = document.documentElement.dataset
    root.pageWidth = settings.page_width
    root.textSize = settings.text_size
    root.docFont = settings.doc_font
  }, [settings.page_width, settings.text_size, settings.doc_font])

  async function changeSettings(changes: Partial<Settings>) {
    const previous = settings
    setSettings({ ...settings, ...changes }) // apply instantly; the backend just persists it
    try {
      setSettings(await api.updateSettings(changes))
    } catch (e) {
      setSettings(previous)
      onError(`Could not save settings: ${e instanceof Error ? e.message : e}`)
    }
  }

  const refresh = useCallback(async () => {
    const [d, f] = await Promise.all([api.documents(), api.folders()])
    setDocs(d)
    setFolders(f)
    setSelected((s) => new Set([...s].filter((id) => d.some((doc) => doc.id === id))))
  }, [])

  const refreshVersions = useCallback(async () => {
    setVersions(await api.versions(draftId))
  }, [draftId])

  const refreshDrafts = useCallback(async () => {
    const list = await api.drafts()
    setDrafts(list)
    return list
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, String(draftId))
    } catch {
      /* storage unavailable */
    }
    setVersions(null)
    setDup({ report: null, at: null, busy: false, stale: false, error: null })
    refreshVersions().catch(() => {})
  }, [draftId, refreshVersions])

  // Once the backend is up: if the remembered draft was deleted, open the most recent one.
  useEffect(() => {
    if (!health) return
    refreshDrafts()
      .then((list) => {
        if (list.length && !list.some((d) => d.id === draftId)) setDraftId(list[0].id)
      })
      .catch(() => {})
  }, [health !== null])

  /** Save what's pending in the open draft, then show another. */
  async function switchDraft(id: number) {
    setDraftsOpen(false)
    setMode('write')
    if (id === draftId) return
    await editor.current?.flush()
    setDraftId(id)
  }

  async function newDraft() {
    setDraftsOpen(false)
    setMode('write')
    // The open draft is still a blank page: that's the new draft, rather than another empty one.
    if (editor.current?.isEmpty()) {
      editor.current.focus()
      return
    }
    setDraftsBusy('Creating a draft…')
    try {
      await editor.current?.flush()
      const d = await api.createDraft()
      await refreshDrafts()
      setDraftId(d.id)
      window.setTimeout(() => editor.current?.focus(), 150) // once it has loaded
    } catch (e) {
      onError(`Could not create a draft: ${e instanceof Error ? e.message : e}`)
    } finally {
      setDraftsBusy(null)
    }
  }
  const newDraftRef = useRef(newDraft)
  newDraftRef.current = newDraft

  // ---------- Word files and dropped files ----------

  /** Show the import dialog for a Word file (picked, dropped, or from the drafts menu). */
  function importWord(file: File) {
    setDraftsOpen(false)
    if (!WORD_FILE.test(file.name)) {
      onError(`${file.name} isn't a .docx file. Older .doc files: open them in Word and save as .docx first.`)
      return
    }
    setImporting(file)
  }

  async function openAsNewDraft(file: File, c: DocxConversion) {
    await editor.current?.flush()
    const d = await api.createDraft(c.title)
    await api.saveDraft(d.id, c.title, JSON.stringify(c.content)) // also takes its first version
    await refreshDrafts()
    setDraftId(d.id)
    setMode('write')
    setNotice(importNotice('Opened', file.name, c))
  }

  function insertIntoDraft(file: File, c: DocxConversion) {
    setMode('write')
    editor.current?.insertDocument(c.content)
    setNotice(importNotice('Inserted', file.name, c))
  }

  /** Add files or folders on disk to the library in the background; the library shows progress. */
  const addToLibrary = useCallback(
    async (paths: string[]) => {
      setMode('library')
      try {
        const job = await api.startIngest(paths)
        setJobs((js) => [job, ...js.filter((j) => j.id !== job.id)])
      } catch (e) {
        onError(`Could not start adding files: ${e instanceof Error ? e.message : e}`)
      }
    },
    [onError],
  )

  // Follow running imports: the library list updates as each file lands, and when an import
  // ends a short summary is shown (the details stay in the library until dismissed).
  useEffect(() => {
    const running = jobs.filter((j) => j.finished_at == null)
    if (!running.length) return
    const t = window.setTimeout(async () => {
      let fresh: IngestJob[]
      try {
        fresh = await Promise.all(running.map((j) => api.ingestJob(j.id)))
      } catch {
        return // backend restarting: the next poll tries again (the dock shows it's offline)
      }
      const before = new Map(running.map((j) => [j.id, j]))
      setJobs((js) => js.map((j) => fresh.find((f) => f.id === j.id) ?? j))
      if (fresh.some((f) => f.done !== before.get(f.id)?.done || f.finished_at)) refresh().catch(() => {})
      for (const f of fresh.filter((f) => f.finished_at)) {
        if (f.state === 'failed') onError(`Adding files stopped: ${f.error}`)
        else if (f.done) setNotice(`Added ${f.done} source${f.done === 1 ? '' : 's'} to your library${f.failed ? `; ${f.failed} couldn't be read` : ''}.`)
      }
    }, 700)
    return () => window.clearTimeout(t)
  }, [jobs, refresh, onError])

  const cancelJob = useCallback(
    async (id: number) => {
      try {
        const job = await api.cancelIngest(id)
        setJobs((js) => js.map((j) => (j.id === id ? job : j)))
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e))
      }
    },
    [onError],
  )
  const dismissJob = useCallback((id: number) => setJobs((js) => js.filter((j) => j.id !== id)), [])
  const toggleSelected = useCallback(
    (id: number) =>
      setSelected((s) => {
        const n = new Set(s)
        n.has(id) ? n.delete(id) : n.add(id)
        return n
      }),
    [],
  )
  const findDuplicateFiles = useCallback(() => setDupFilesOpen(true), [])
  const findMissing = useCallback(() => setMissingQuery(''), [])

  // Files dragged in from outside: one Word file opens the import dialog, anything else goes to
  // the library. Without this, Electron would navigate the window to the dropped file.
  // Subscribed once: re-subscribing on every render reset the enter/leave count mid-drag, and the
  // overlay vanished as soon as the pointer crossed into another element.
  const onDropRef = useRef({ importWord, addToLibrary, onError })
  onDropRef.current = { importWord, addToLibrary, onError }
  useEffect(() => {
    let depth = 0 // dragenter/leave fire for every child element crossed
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDropping(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDropping(false)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDropping(false)
      const { importWord, addToLibrary, onError } = onDropRef.current
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length === 1 && WORD_FILE.test(files[0].name)) return importWord(files[0])
      const usable = files.filter((f) => LIBRARY_TYPES.test(f.name))
      const paths = usable.map((f) => window.rc?.pathForFile?.(f) ?? '').filter(Boolean)
      if (usable.length < files.length) {
        const skipped = files.filter((f) => !LIBRARY_TYPES.test(f.name)).map((f) => f.name)
        onError(`Can't read ${skipped.join(', ')}. The library takes PDF, Word, PowerPoint, Markdown, text, HTML and images.`)
      }
      if (!paths.length) {
        if (usable.length) onError('Drop files onto the desktop app to add them to your library.')
        return
      }
      addToLibrary(paths).catch((err) => onError(err instanceof Error ? err.message : String(err)))
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  async function deleteDraft(id: number) {
    setDraftsBusy('Deleting…')
    try {
      if (id === draftId) await editor.current?.flush()
      await api.deleteDraft(id)
      const left = await refreshDrafts()
      if (id === draftId) {
        if (left.length) setDraftId(left[0].id)
        else {
          const d = await api.createDraft()
          await refreshDrafts()
          setDraftId(d.id)
        }
      }
    } catch (e) {
      onError(`Could not delete the draft: ${e instanceof Error ? e.message : e}`)
    } finally {
      setDraftsBusy(null)
    }
  }

  // The backend may take a while on first launch (embedding model download).
  useEffect(() => {
    let stop = false
    const poll = async () => {
      while (!stop) {
        try {
          setHealth(await api.health())
          api
            .settings()
            .then((s) => {
              setSettings(s)
              if (s.tools_at_start !== 'last') setToolsOpen(s.tools_at_start === 'open')
            })
            .catch((e) => onError(`Could not load settings: ${e instanceof Error ? e.message : e}`))
          // An import still running from before a reload keeps showing its progress.
          api
            .ingestJobs()
            .then((js) => setJobs(js.filter((j) => j.finished_at == null)))
            .catch(() => {})
          await refresh()
          return
        } catch {
          await new Promise((r) => setTimeout(r, 700))
        }
      }
    }
    poll()
    return () => {
      stop = true
    }
  }, [refresh])

  // Once running, keep an eye on the backend so an outage shows in the dock instead of
  // surfacing only as errors on the next click. The desktop app restarts it automatically.
  const [offline, setOffline] = useState(false)
  const [logPath, setLogPath] = useState('')
  const started = health !== null
  useEffect(() => {
    if (!started) return
    backendLogPath().then(setLogPath)
    let wasOffline = false
    const timer = window.setInterval(async () => {
      try {
        await api.health()
        if (wasOffline) await refresh() // back after a restart: reload what may have changed
        wasOffline = false
      } catch {
        wasOffline = true
      }
      setOffline(wasOffline)
    }, 4000)
    return () => window.clearInterval(timer)
  }, [started, refresh])

  // ---------- duplication check ----------

  const runCheck = useCallback(async () => {
    const content = editor.current?.getJSON()
    if (!content) return
    setDup((d) => ({ ...d, busy: true, error: null }))
    try {
      const report = await api.checkDuplicates(content)
      setDup({ report, at: Date.now(), busy: false, stale: false, error: null })
    } catch (e) {
      setDup((d) => ({ ...d, busy: false, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [])

  const reviewing = mode === 'write' && tab === 'review'

  // Underline what the check found while the Review tab is open.
  useEffect(() => {
    const r = dup.report
    if (!reviewing || !r) {
      editor.current?.markReview([])
      return
    }
    editor.current?.markReview([
      ...r.source_matches.map((m) => ({
        block: m.block,
        text: m.sentence,
        kind: m.cited ? ('cited' as const) : ('source' as const),
        title: `${m.similarity}% match with ${m.label}${m.cited ? '' : ' (not cited)'}`,
      })),
      ...r.repeated_sentences.map((p) => ({
        block: p.second_block,
        text: p.second,
        kind: 'repeat' as const,
        title: `${p.similarity}% like an earlier sentence`,
      })),
    ])
  }, [reviewing, dup.report])

  // Opening the tab checks the draft; while it stays open, it re-checks a few seconds after edits.
  useEffect(() => {
    if (!reviewing || dup.busy || dup.error) return
    if (!dup.report) {
      runCheck()
      return
    }
    if (!dup.stale || !settings.auto_recheck) return
    const t = window.setTimeout(runCheck, 4000)
    return () => window.clearTimeout(t)
  }, [reviewing, dup.stale, dup.report, dup.busy, dup.error, runCheck, settings.auto_recheck])

  // Leaving the tab forgets a failed check, so opening it again tries once more.
  useEffect(() => {
    if (!reviewing) setDup((d) => (d.error ? { ...d, error: null } : d))
  }, [reviewing])

  function onStats(s: DraftStats) {
    setStats(s)
    setTitle(editor.current?.getTitle() ?? 'Untitled')
    setDup((d) => (d.report && !d.stale ? { ...d, stale: true } : d))
  }

  function onSaveState(s: SaveState) {
    setSaveState(s)
    if (s.state === 'saved') {
      refreshVersions().catch(() => {})
      if (s.at) refreshDrafts().catch(() => {}) // a real save, not just a load: titles and word counts changed
    }
  }

  // ---------- sources ----------

  function openMatch(m: SourceMatch) {
    showSource({
      docId: m.doc_id,
      page: m.page,
      start: m.start,
      end: m.end,
      quote: m.quote,
      status: m.cited ? 'verified' : 'weak',
      reason: m.cited
        ? `Your sentence matches this passage ${m.similarity}% and cites it. Consider quoting it exactly or rewording it.`
        : `Your sentence matches this passage ${m.similarity}% but doesn't cite it. Cite it, quote it, or put it in your own words.`,
      label: m.label,
      badge: m.cited ? 'cited match' : 'uncited match',
    })
  }

  function openCitation(c: Citation) {
    showSource({
      cid: c.cid,
      docId: c.doc_id,
      page: c.page,
      start: c.start,
      end: c.end,
      quote: c.quote,
      status: c.status,
      reason: c.reason,
      label: c.label,
    })
  }

  async function openChip(a: ChipAttrs) {
    showSource({ ...a })
    // The file may have been re-added since this chip was written; jump to where the quote is now.
    try {
      const current = (await editor.current?.resolveChip(a)) ?? a
      // Only a chip that moved (or lost its passage) shows again: the same page needn't load twice.
      const moved = (s: SourceTarget) => (['docId', 'page', 'start', 'end', 'status', 'label'] as const).some((k) => s[k] !== current[k])
      setSource((s) => (s?.cid === a.cid && moved(s) ? { ...current } : s))
    } catch (e) {
      onError(`Could not refresh citation: ${e instanceof Error ? e.message : e}`)
    }
  }

  function onVerified(cid: string, v: Citation) {
    editor.current?.updateCitation(cid, { status: v.status, reason: v.reason, start: v.start, end: v.end })
    setSource((s) => (s?.cid === cid ? { ...s, status: v.status, reason: v.reason } : s))
  }

  function showCitations(focus: string | null = null) {
    showTab('citations')
    setCiteFocus(focus)
  }

  const paletteItems: PaletteItem[] = [
    ...docs.map((d) => ({
      group: d.kind.toUpperCase(),
      name: d.title,
      hint: [d.authors[0], d.year].filter(Boolean).join(' '),
      run: () => showPaper(d.id),
    })),
    ...folders.map((f) => ({ group: 'FOLDER', name: f.name, hint: `${f.doc_count} docs`, run: openLibrary })),
    ...drafts
      .filter((d) => d.id !== draftId)
      .map((d) => ({ group: 'DRAFT', name: d.title || 'Untitled', hint: `${d.words} words`, run: () => switchDraft(d.id) })),
    { group: 'GO', name: 'Write', hint: 'the draft and its tools', run: () => setMode('write') },
    { group: 'GO', name: 'Library', hint: 'add and organize sources', run: openLibrary },
    { group: 'GO', name: 'Citation network', hint: 'who cites whom, shared references', run: () => setMode('network') },
    { group: 'DO', name: 'Ask the assistant', hint: 'draft with citations', run: () => showTab('assistant') },
    {
      group: 'DO',
      name: 'Citations to confirm',
      hint: citeMarks.length ? `${citeMarks.length} waiting` : 'Ctrl+Shift+C marks a sentence',
      run: () => showCitations(),
    },
    { group: 'DO', name: 'Show references', hint: settings.citation_style.toUpperCase(), run: () => showTab('references') },
    { group: 'DO', name: 'Check for duplication', hint: 'repeats and text matching sources', run: () => showTab('review') },
    { group: 'DO', name: 'Version history', hint: 'save, compare and restore versions', run: () => showTab('history') },
    { group: 'DO', name: 'New draft', hint: 'a blank page · Ctrl+N', run: () => newDraft() },
    { group: 'DO', name: 'Show drafts', hint: 'switch, import or delete', run: () => setDraftsOpen(true) },
    { group: 'DO', name: 'Import a Word file', hint: '.docx · Ctrl+O', run: pickWord },
    { group: 'DO', name: 'Find duplicate files', hint: 'suggests cleanup, removes nothing', run: findDuplicateFiles },
    { group: 'DO', name: "Most-cited papers you don't have", hint: 'what your papers cite most, by topic', run: findMissing },
    { group: 'DO', name: 'Show getting started', hint: 'the three steps', run: () => {
      setMode('write')
      setHideGuide(false)
      try {
        localStorage.removeItem(GUIDE_KEY)
      } catch {
        /* storage unavailable */
      }
    } },
    { group: 'DO', name: toolsOpen ? 'Close the writing tools' : 'Open the writing tools', hint: 'Ctrl+\\', run: () => (toolsOpen ? setToolsOpen(false) : revealTools()) },
    { group: 'DO', name: 'Focus mode', hint: 'only the page · Ctrl+Shift+F', run: toggleFocus },
    { group: 'DO', name: 'Settings', hint: 'appearance, writing, review, library, AI model', run: () => setShowSettings(true) },
  ]

  const running = jobs.filter((j) => j.finished_at == null)
  const importingNow = running.length
    ? { total: running.reduce((n, j) => n + j.total, 0), settled: running.reduce((n, j) => n + j.done + j.failed + j.skipped, 0) }
    : null
  const latest = versions?.versions[0]
  const change = versions?.current_change ?? null
  const dupPct = dup.report?.overall ?? null
  const showingSource = tab === 'citations' && sourceFrom !== null

  function badgeFor(t: Tab): string | null {
    if (t === 'citations' && citeMarks.length) return String(citeMarks.length)
    if (t === 'review' && dupPct != null) return `${dupPct}%`
    if (t === 'history' && change) return `${change}%`
    return null
  }

  /** A tab (or strip icon) was clicked. Clicking Citations again goes back to the list of markers. */
  function pickTab(t: Tab) {
    if (t === 'citations') showCitations(tab === 'citations' && toolsOpen ? null : citeFocus)
    else showTab(t)
  }

  function tabBadge(t: Tab) {
    const badge = badgeFor(t)
    if (!badge) return null
    return (
      <em className="tab-badge" style={t === 'review' && dupPct != null ? { background: toneOf(dupPct, 'risk') } : undefined}>
        {badge}
      </em>
    )
  }

  const query = mode === 'library' ? libQuery : netQuery
  const setQuery = mode === 'library' ? setLibQuery : setNetQuery

  return (
    <div className={`app${focusMode ? ' focus' : ''}`}>
      {focusMode && (
        <div className="focus-exit">
          <span className={`save-state save-${saveState.state}`}>{saveText(saveState)}</span>
          <button onClick={() => setFocusMode(false)} title="Show the rail, the writing tools and the status bar again">
            Exit focus <kbd>Esc</kbd>
          </button>
        </div>
      )}
      <header className="app-bar">
        <div className="doc-id" ref={draftsMenu}>
          <span className="logo" aria-hidden="true">rc</span>
          <div className="doc-id-text">
            <button
              className="doc-switch"
              onClick={() => setDraftsOpen((o) => !o)}
              aria-expanded={draftsOpen}
              aria-haspopup="dialog"
              title="Your drafts: switch, start a new one, import a Word file, or delete one"
            >
              <span className="doc-name">{title}</span>
              <span className="doc-caret" aria-hidden="true">▾</span>
              {drafts.length > 1 && <span className="doc-count">{drafts.length}</span>}
            </button>
            <div className={`save-state save-${saveState.state}`}>
              {saveText(saveState)}
              {latest && (
                <>
                  {' · '}
                  <button className="link" onClick={() => showTab('history')} title="Version history">
                    v{latest.number}
                  </button>
                </>
              )}
            </div>
          </div>
          {draftsOpen && (
            <div className="drafts-menu" role="dialog" aria-label="Drafts">
              <DraftsPanel
                drafts={drafts}
                currentId={draftId}
                busy={draftsBusy}
                onSwitch={switchDraft}
                onNew={newDraft}
                onImport={() => {
                  setDraftsOpen(false)
                  pickWord()
                }}
                onDelete={deleteDraft}
              />
            </div>
          )}
        </div>

        {mode === 'write' ? (
          <button className="search-pill" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={16} />
            <span>Search sources, drafts and actions</span>
            <kbd>Ctrl K</kbd>
          </button>
        ) : (
          <div className="search-pill search-field">
            <Icon name="search" size={16} />
            <span className="search-scope">{SEARCH[mode].scope}</span>
            <input
              key={mode}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.stopPropagation()
                if (query) setQuery('')
                else e.currentTarget.blur()
              }}
              placeholder={SEARCH[mode].placeholder}
              aria-label={`Search the ${SEARCH[mode].scope.toLowerCase()}`}
            />
            {query && (
              <button className="search-clear" onClick={() => setQuery('')} aria-label="Clear the search" title="Clear (Esc)">
                ×
              </button>
            )}
            <button className="search-all" onClick={() => setPaletteOpen(true)} title="Search everything and run actions">
              <kbd>Ctrl K</kbd>
            </button>
          </div>
        )}

        <div className="bar-actions">
          <ExportControl
            style={settings.citation_style}
            getJSON={() => editor.current?.getJSON() ?? null}
            getTitle={() => editor.current?.getTitle() ?? 'Untitled'}
            onError={onError}
          />
          <input
            ref={wordInput}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) importWord(f)
            }}
          />
          <button className="icon-button" onClick={toggleFocus} title="Focus: only the page and its toolbar (Ctrl+Shift+F)" aria-label="Focus mode">
            <Icon name="focus" size={18} />
          </button>
          <button className="icon-button" onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings">
            <Icon name="settings" size={18} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <nav className="rail" aria-label="Places">
          {MODES.map((m) => (
            <button
              key={m.mode}
              className={`rail-btn${mode === m.mode ? ' on' : ''}`}
              onClick={() => setMode(m.mode)}
              title={m.hint}
              aria-current={mode === m.mode ? 'page' : undefined}
            >
              <Icon name={m.icon} />
              <span>{m.label}</span>
              {m.mode === 'library' && docs.length > 0 && <em className="rail-badge">{docs.length}</em>}
            </button>
          ))}
        </nav>

        <div className={`view write-view${toolsOpen ? '' : ' tools-closed'}`} hidden={mode !== 'write'}>
          <main className="writing">
            <WritingEditor
              ref={editor}
              draftId={draftId}
              banner={
                health && !hideGuide && (docs.length === 0 || stats.words === 0) ? (
                  <GettingStarted
                    sources={docs.length}
                    words={stats.words}
                    citations={stats.citations}
                    onAddSources={openLibrary}
                    onAsk={() => showTab('assistant')}
                    onOpenWord={pickWord}
                    onHide={() => {
                      setHideGuide(true)
                      try {
                        localStorage.setItem(GUIDE_KEY, '1')
                      } catch {
                        /* storage unavailable */
                      }
                    }}
                  />
                ) : null
              }
              onStats={onStats}
              onSaveState={onSaveState}
              onCitationClick={openChip}
              onCiteMarkClick={(cid) => showCitations(cid)}
              onCiteMarks={setCiteMarks}
              getScope={() => (settings.cite_scope === 'library' || !selected.size ? null : [...selected])}
              spellcheck={settings.spellcheck}
              onError={onError}
            />
          </main>

          <aside className="panel side-panel" aria-label="Writing tools">
            {toolsOpen ? (
              <>
                <div className="tabs" role="tablist" aria-label="Writing tools">
                  {TABS.map((t) => (
                    <button
                      key={t.tab}
                      role="tab"
                      aria-selected={tab === t.tab}
                      className={`tab${tab === t.tab ? ' on' : ''}`}
                      onClick={() => pickTab(t.tab)}
                      title={t.hint}
                    >
                      <Icon name={t.icon} size={18} />
                      <span>{t.label}</span>
                      {tabBadge(t.tab)}
                    </button>
                  ))}
                  <button
                    className="tabs-close"
                    onClick={() => setToolsOpen(false)}
                    title="Close the writing tools (Ctrl+\)"
                    aria-label="Close the writing tools"
                  >
                    »
                  </button>
                </div>
                <p className="tab-hint">{TAB[tab].hint}</p>
              </>
            ) : (
              <nav className="tool-strip" aria-label="Writing tools">
                {TABS.map((t) => (
                  <button key={t.tab} className="strip-btn" onClick={() => pickTab(t.tab)} title={`${t.label}: ${t.hint}`} aria-label={t.label}>
                    <Icon name={t.icon} size={20} />
                    {tabBadge(t.tab)}
                  </button>
                ))}
                <button className="strip-btn strip-open" onClick={() => setToolsOpen(true)} title="Open the writing tools (Ctrl+\)" aria-label="Open the writing tools">
                  «
                </button>
              </nav>
            )}
            {/* Kept mounted while closed, so a draft from the Assistant or a cite search's results survive. */}
            <div className="tab-body" hidden={!toolsOpen}>
              <div hidden={tab !== 'assistant'}>
                <AssistantPanel
                  passages={settings.assistant_passages}
                  scope={[...selected]}
                  sourceCount={docs.length}
                  onChooseSources={openLibrary}
                  getContext={() => editor.current?.getText() ?? ''}
                  onInsert={(s) => editor.current?.insertDraft(s)}
                  onVerified={onVerified}
                  onOpenCitation={openCitation}
                  onError={onError}
                />
              </div>
              {tab === 'citations' && sourceFrom && (
                <>
                  <button className="link cite-back" onClick={() => showTab(sourceFrom)}>
                    ‹ Back to {sourceFrom === 'citations' ? 'citations to confirm' : TAB[sourceFrom].label}
                  </button>
                  <SourceViewer target={source} doc={docs.find((d) => d.id === source?.docId)} onOpenPdf={openPdf} />
                </>
              )}
              {/* Kept mounted (hidden) so results survive a look at a source. */}
              <div hidden={tab !== 'citations' || showingSource}>
                <CitePanel
                  marks={citeMarks}
                  focus={citeFocus}
                  onFocus={(cid) => {
                    setCiteFocus(cid)
                    if (cid) editor.current?.showCite(cid)
                  }}
                  onConfirm={(cid, c) => {
                    if (editor.current?.confirmCite(cid, c)) setCiteFocus(null)
                    else onError('That marker was deleted from the draft.')
                  }}
                  onRecheck={(cid) => editor.current?.recheckCite(cid)}
                  onRemove={(cid) => {
                    editor.current?.removeCite(cid)
                    setCiteFocus(null)
                  }}
                  onOpenSource={(c) => openCitation(c)}
                />
              </div>
              {tab === 'references' && (
                <ReferencesPanel
                  style={settings.citation_style}
                  citedDocIds={() => editor.current?.citedDocIds() ?? []}
                  onError={onError}
                />
              )}
              {tab === 'review' && (
                <ReviewPanel
                  report={dup.report}
                  checkedAt={dup.at}
                  busy={dup.busy}
                  stale={dup.stale}
                  error={dup.error}
                  onRun={runCheck}
                  onReveal={(block, text) => editor.current?.reveal(block, text)}
                  onOpenSource={openMatch}
                />
              )}
              {tab === 'history' && (
                <HistoryPanel
                  key={draftId}
                  draftId={draftId}
                  list={versions}
                  onRefresh={refreshVersions}
                  getJSON={() => editor.current?.getJSON() ?? null}
                  getTitle={() => editor.current?.getTitle() ?? 'Untitled'}
                  onRestore={(content) => editor.current?.setContent(content)}
                  onFlush={async () => {
                    await editor.current?.flush()
                  }}
                  onError={onError}
                />
              )}
            </div>
          </aside>

          <CitationWire cid={source?.cid} status={source?.status ?? 'pending'} active={mode === 'write' && toolsOpen && !focusMode && showingSource} />
        </div>

        <div className="view library-view" hidden={mode !== 'library'}>
          <LibraryPanel
            docs={docs}
            folders={folders}
            query={libQuery}
            onQuery={setLibQuery}
            selected={selected}
            onToggle={toggleSelected}
            onChanged={refresh}
            onError={onError}
            focus={libFocus}
            jobs={jobs}
            onAddPaths={addToLibrary}
            onCancelJob={cancelJob}
            onDismissJob={dismissJob}
            onFindDuplicates={findDuplicateFiles}
            onCitedPapers={setCitedFor}
            onFindMissing={findMissing}
            folderSimilarity={settings.folder_similarity}
            onOpenPdf={openPdf}
            cited={citedIds}
          />
        </div>

        {mode === 'network' && (
          <div className="view network-view">
            <Suspense fallback={<p className="network-note">Loading the network…</p>}>
              <NetworkView
                query={netQuery}
                onOpenPaper={showPaper}
                onCitedPapers={setCitedFor}
                onFindMissing={setMissingQuery}
                onError={onError}
              />
            </Suspense>
          </div>
        )}
      </div>

      <footer className="dock">
        <div className="dock-stats">
          <span className="stat" title="Words in the draft">
            <b>{stats.words.toLocaleString()}</b> <span className="lbl">words</span>
          </span>
          <button
            className="stat"
            onClick={() => (stats.unconfirmed ? showCitations() : showTab('references'))}
            title={stats.unconfirmed ? 'Cite markers waiting for you to confirm a source' : 'Citations verified against their source'}
          >
            <span className="mini-bar">
              <span style={{ width: `${stats.citations ? (100 * stats.verified) / stats.citations : 0}%` }} />
            </span>
            <b>{stats.verified}</b>/{stats.citations} <span className="lbl">citations verified</span>
            {stats.flagged > 0 && <em className="flag">{stats.flagged} flagged</em>}
            {stats.unconfirmed > 0 && <em className="flag to-confirm">{stats.unconfirmed} to confirm</em>}
          </button>
          <button className="stat" onClick={() => showTab('review')} title="Share of the draft that repeats itself or matches a source">
            <span className="dot" style={{ background: dupPct == null ? 'var(--pending)' : toneOf(dupPct, 'risk') }} />
            {dupPct == null ? <span className="lbl">Duplication not checked</span> : <><b>{dupPct}%</b> <span className="lbl">duplication{dup.stale ? ' (outdated)' : ''}</span></>}
          </button>
          <button className="stat" onClick={() => showTab('history')} title="How much the draft changed since the newest version">
            <Icon name="history" size={14} />
            {change == null ? <span className="lbl">No versions yet</span> : <><b>{change}%</b> <span className="lbl">changed since v{latest?.number}</span></>}
          </button>
        </div>
        <span className="spacer" />
        {health && health.api !== API_VERSION && !offline && (
          <span className="offline status" title="The backend was started before the app was updated">
            Restart the app to finish updating
          </span>
        )}
        {importingNow && (
          <button className="stat dock-import" onClick={openLibrary} title="Adding files to your library: open it to see each file">
            <span className="mini-bar">
              <span style={{ width: `${importingNow.total ? (100 * importingNow.settled) / importingNow.total : 0}%` }} />
            </span>
            <span className="lbl">
              Adding files {importingNow.total ? `${importingNow.settled}/${importingNow.total}` : '…'}
            </span>
          </button>
        )}
        {offline ? (
          <span className="offline status" title={logPath ? `Backend log: ${logPath}` : undefined}>
            Backend offline, reconnecting…
          </span>
        ) : (
          <span className="status" title={health ? `model: ${health.provider} · embeddings: ${health.embedder}` : undefined}>
            <span className={`dot${health ? ' live' : ''}`} />
            {health ? `${docs.length} source${docs.length === 1 ? '' : 's'} · ${modelLine(health)}` : 'Starting backend…'}
          </span>
        )}
      </footer>

      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}

      {dupFilesOpen && (
        <DuplicateFilesDialog
          getCited={() => editor.current?.citedDocIds() ?? []}
          onChanged={refresh}
          onClose={() => setDupFilesOpen(false)}
          onError={onError}
        />
      )}

      {citedFor != null && (
        <CitedPapersDialog
          docId={citedFor}
          onOpenPaper={showPaper}
          onChanged={refresh}
          onClose={() => setCitedFor(null)}
          onError={onError}
        />
      )}

      {missingQuery != null && (
        <MissingPapersDialog
          initialQuery={missingQuery}
          onOpenPaper={showPaper}
          onChanged={refresh}
          onClose={() => setMissingQuery(null)}
          onError={onError}
        />
      )}

      {pdfView && <PdfViewerDialog doc={pdfView.doc} page={pdfView.page} onClose={() => setPdfView(null)} />}

      {showSettings && (
        <SettingsDialog
          settings={settings}
          onChange={changeSettings}
          onModelChanged={() => api.health().then(setHealth).catch(() => {})}
          onClose={() => setShowSettings(false)}
        />
      )}

      {importing && (
        <WordImportDialog
          file={importing}
          currentTitle={title}
          currentEmpty={editor.current?.isEmpty() ?? true}
          path={window.rc?.pathForFile?.(importing) ?? ''}
          onNewDraft={(c) => openAsNewDraft(importing, c)}
          onInsert={(c) => insertIntoDraft(importing, c)}
          onAddToLibrary={(p) => addToLibrary([p])}
          onClose={() => setImporting(null)}
        />
      )}

      {dropping && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card">
            <Icon name="upload" size={34} />
            <b>Drop to import</b>
            <span>A Word file opens as a draft or goes into this one. Papers, notes, slides and scans go to your library.</span>
          </div>
        </div>
      )}

      {(errors.length > 0 || notice) && (
        <div className="toasts">
          {notice && (
            <div className="toast info" onClick={() => setNotice(null)} title="Click to dismiss">
              {notice}
            </div>
          )}
          {errors.map((e, i) => (
            <div key={i} className="toast" onClick={() => setErrors((es) => es.filter((_, j) => j !== i))}>
              {e}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
