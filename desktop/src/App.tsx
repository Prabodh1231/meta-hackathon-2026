import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { API_VERSION, api, backendLogPath } from './api'
import { AssistantPanel } from './components/AssistantPanel'
import { CitationWire } from './components/CitationWire'
import { CitePanel } from './components/CitePanel'
import type { CiteMarkAttrs } from './editor/citeMark'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import { DraftsPanel } from './components/DraftsPanel'
import { DuplicateFilesDialog } from './components/DuplicateFilesDialog'
import { ExportControl } from './components/ExportControl'
import { GettingStarted } from './components/GettingStarted'
import { HistoryPanel } from './components/HistoryPanel'
import { Icon, type IconName } from './components/Icon'
import { LibraryPanel } from './components/LibraryPanel'
import { ago, toneOf } from './components/Meters'
import { ReferencesPanel } from './components/ReferencesPanel'
import { ReviewPanel } from './components/ReviewPanel'
import { SettingsDialog } from './components/SettingsDialog'
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

type Tab = 'assistant' | 'cite' | 'source' | 'references' | 'review' | 'history'
interface Tool {
  tab: Tab
  label: string
  icon: IconName
  hint: string
}

/** The right-hand tools, grouped by stage of writing: draft, back it up, then check it. */
const TOOLS: { group: string; tools: Tool[] }[] = [
  {
    group: 'Write',
    tools: [
      { tab: 'assistant', label: 'Assistant', icon: 'assistant', hint: 'Draft from your library with cited quotes' },
      { tab: 'cite', label: 'Cite', icon: 'cite', hint: 'Sources found for your cite markers, to confirm' },
    ],
  },
  {
    group: 'Evidence',
    tools: [
      { tab: 'source', label: 'Source', icon: 'source', hint: 'The cited passage, highlighted on its page' },
      { tab: 'references', label: 'Refs', icon: 'references', hint: 'Reference list for the sources you cite' },
    ],
  },
  {
    group: 'Review',
    tools: [
      { tab: 'review', label: 'Duplicates', icon: 'review', hint: 'Repeated passages and text matching your sources' },
      { tab: 'history', label: 'History', icon: 'history', hint: 'Versions of the draft and what changed' },
    ],
  },
]
const TOOL = Object.fromEntries(TOOLS.flatMap((g) => g.tools.map((t) => [t.tab, t]))) as Record<Tab, Tool>

const PROVIDER_NAMES: Record<string, string> = { muse: 'Muse', mock: 'Offline mock' }

/** "Muse · BGE-M3 (GPU)": a short form of the backend's model ids. */
function modelLine(h: Health): string {
  const model = h.embedder.split(':').slice(1).join(':').split('/').pop() || h.embedder
  const embedder = model.replace(/-en-v[\d.]+$/, '').replace(/^bge/, 'BGE').replace('-m3', '-M3')
  const device = h.embedder_device === 'cuda' ? ' (GPU)' : ''
  return `${PROVIDER_NAMES[h.provider] ?? h.provider} · ${embedder}${device}`
}

// Whether the right panel sits beside the page (pinned) or slides over it. Wide windows pin by default.
const PIN_KEY = 'rc.panelPinned'
function initialPinned(): boolean {
  try {
    const v = localStorage.getItem(PIN_KEY)
    if (v != null) return v === '1'
  } catch {
    /* storage unavailable */
  }
  return window.innerWidth >= 1280
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
  const [tab, setTab] = useState<Tab>('assistant')
  const [source, setSource] = useState<(SourceTarget & { cid?: string }) | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [draftId, setDraftId] = useState(initialDraft)
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [draftsOpen, setDraftsOpen] = useState(false)
  const [draftsBusy, setDraftsBusy] = useState<string | null>(null)
  const [hideGuide, setHideGuide] = useState(guideHidden)
  const [settings, setSettings] = useState<Settings>({ theme: cachedTheme(), citation_style: 'apa' })
  const [showSettings, setShowSettings] = useState(false)
  const [dupFilesOpen, setDupFilesOpen] = useState(false)
  const [citeMarks, setCiteMarks] = useState<CiteMarkAttrs[]>([]) // "cite" markers in the draft, searching or waiting
  const [citeFocus, setCiteFocus] = useState<string | null>(null) // the marker the Cite panel is showing
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryWide, setLibraryWide] = useState(false) // library as a file manager
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [pinned, setPinned] = useState(initialPinned)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [networkOpen, setNetworkOpen] = useState(false)
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
  const [dropping, setDropping] = useState(false) // files dragged over the window
  const [jobs, setJobs] = useState<IngestJob[]>([]) // background imports, newest first

  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(PIN_KEY, pinned ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [pinned])

  // The drafts and library drawers and the network view cover the same area, so only one is open at a time.
  const openDrafts = useCallback((open = true) => {
    setDraftsOpen(open)
    if (open) {
      setLibraryOpen(false)
      setNetworkOpen(false)
    }
  }, [])
  const openLibrary = useCallback((open = true) => {
    setLibraryOpen(open)
    if (open) {
      setDraftsOpen(false)
      setNetworkOpen(false)
    }
  }, [])
  const openNetwork = useCallback((open = true) => {
    setNetworkOpen(open)
    if (open) {
      setDraftsOpen(false)
      setLibraryOpen(false)
    }
  }, [])
  const [libFocus, setLibFocus] = useState<{ id: number; n: number } | null>(null)
  const showPaper = useCallback(
    (id: number) => {
      openLibrary()
      setLibFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }))
    },
    [openLibrary],
  )

  const showTab = useCallback((t: Tab) => {
    setTab(t)
    setDrawerOpen(true)
  }, [])

  // A rail button opens its tool, or closes the panel when that tool is already showing.
  function toggleTool(t: Tab) {
    if (drawerOpen && tab === t) setDrawerOpen(false)
    else showTab(t)
  }

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
      } else if (e.key === 'Escape' && !paletteOpen && !importing) {
        setLibraryOpen(false)
        setDraftsOpen(false)
        setDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, importing, pickWord])

  const onError = useCallback((msg: string) => setErrors((e) => [...e.slice(-2), msg]), [])

  useEffect(() => {
    applyTheme(settings.theme)
    cacheTheme(settings.theme)
    return watchSystemTheme(settings.theme)
  }, [settings.theme])

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
    if (id === draftId) return
    await editor.current?.flush()
    setDraftId(id)
  }

  async function newDraft() {
    setDraftsOpen(false)
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
    setNotice(importNotice('Opened', file.name, c))
  }

  function insertIntoDraft(file: File, c: DocxConversion) {
    editor.current?.insertDocument(c.content)
    setNotice(importNotice('Inserted', file.name, c))
  }

  /** Add files or folders on disk to the library, all in one request. */
  /** Add files or folders on disk to the library in the background; the library shows progress. */
  async function addToLibrary(paths: string[]) {
    openLibrary()
    try {
      const job = await api.startIngest(paths)
      setJobs((js) => [job, ...js.filter((j) => j.id !== job.id)])
    } catch (e) {
      onError(`Could not start adding files: ${e instanceof Error ? e.message : e}`)
    }
  }

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

  async function cancelJob(id: number) {
    try {
      const job = await api.cancelIngest(id)
      setJobs((js) => js.map((j) => (j.id === id ? job : j)))
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  // Files dragged in from outside: one Word file opens the import dialog, anything else goes to
  // the library. Without this, Electron would navigate the window to the dropped file.
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
  })

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
            .then(setSettings)
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

  const reviewing = drawerOpen && tab === 'review'

  // Underline what the check found while the Duplicates panel is open.
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

  // Opening the panel checks the draft; while it stays open, it re-checks a few seconds after edits.
  useEffect(() => {
    if (!reviewing || dup.busy || dup.error) return
    if (!dup.report) {
      runCheck()
      return
    }
    if (!dup.stale) return
    const t = window.setTimeout(runCheck, 4000)
    return () => window.clearTimeout(t)
  }, [reviewing, dup.stale, dup.report, dup.busy, dup.error, runCheck])

  // Closing the panel forgets a failed check, so opening it again tries once more.
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
    setSource({
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
    showTab('source')
  }

  function openCitation(c: Citation) {
    setSource({
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
    showTab('source')
  }

  async function openChip(a: ChipAttrs) {
    setSource({ ...a })
    showTab('source')
    // The file may have been re-added since this chip was written; jump to where the quote is now.
    try {
      const current = (await editor.current?.resolveChip(a)) ?? a
      setSource((s) => (s?.cid === a.cid ? { ...current } : s))
    } catch (e) {
      onError(`Could not refresh citation: ${e instanceof Error ? e.message : e}`)
    }
  }

  function onVerified(cid: string, v: Citation) {
    editor.current?.updateCitation(cid, { status: v.status, reason: v.reason, start: v.start, end: v.end })
    setSource((s) => (s?.cid === cid ? { ...s, status: v.status, reason: v.reason } : s))
  }

  const paletteItems: PaletteItem[] = [
    ...docs.map((d) => ({
      group: d.kind.toUpperCase(),
      name: d.title,
      hint: [d.authors[0], d.year].filter(Boolean).join(' '),
      run: () => showPaper(d.id),
    })),
    ...folders.map((f) => ({ group: 'FOLDER', name: f.name, hint: `${f.doc_count} docs`, run: () => openLibrary() })),
    { group: 'DO', name: 'Show citation network', hint: 'who cites whom, shared references', run: () => openNetwork() },
    { group: 'DO', name: 'Open library', hint: 'add and organize sources', run: () => openLibrary() },
    { group: 'DO', name: 'Ask the assistant', hint: 'draft with citations', run: () => showTab('assistant') },
    {
      group: 'DO',
      name: 'Citations to confirm',
      hint: citeMarks.length ? `${citeMarks.length} waiting` : 'Ctrl+Shift+C marks a sentence',
      run: () => {
        setCiteFocus(null)
        showTab('cite')
      },
    },
    { group: 'DO', name: 'Show references', hint: settings.citation_style.toUpperCase(), run: () => showTab('references') },
    { group: 'DO', name: 'Check for duplication', hint: 'repeats and text matching sources', run: () => showTab('review') },
    { group: 'DO', name: 'Version history', hint: 'save, compare and restore versions', run: () => showTab('history') },
    ...drafts
      .filter((d) => d.id !== draftId)
      .map((d) => ({ group: 'DRAFT', name: d.title || 'Untitled', hint: `${d.words} words`, run: () => switchDraft(d.id) })),
    { group: 'DO', name: 'New draft', hint: 'a blank page · Ctrl+N', run: () => newDraft() },
    { group: 'DO', name: 'Show drafts', hint: 'switch, import or delete', run: () => openDrafts() },
    { group: 'DO', name: 'Import a Word file', hint: '.docx · Ctrl+O', run: pickWord },
    { group: 'DO', name: 'Find duplicate files', hint: 'suggests cleanup, removes nothing', run: () => setDupFilesOpen(true) },
    { group: 'DO', name: 'Show getting started', hint: 'the three steps', run: () => {
      setHideGuide(false)
      try {
        localStorage.removeItem(GUIDE_KEY)
      } catch {
        /* storage unavailable */
      }
    } },
    { group: 'DO', name: 'Settings', hint: 'theme, citation style', run: () => setShowSettings(true) },
  ]

  const running = jobs.filter((j) => j.finished_at == null)
  const importingNow = running.length
    ? { total: running.reduce((n, j) => n + j.total, 0), settled: running.reduce((n, j) => n + j.done + j.failed + j.skipped, 0) }
    : null
  const latest = versions?.versions[0]
  const change = versions?.current_change ?? null
  const dupPct = dup.report?.overall ?? null
  const tool = TOOL[tab]

  function badgeFor(t: Tab): string | null {
    if (t === 'cite' && citeMarks.length) return String(citeMarks.length)
    if (t === 'review' && dupPct != null) return `${dupPct}%`
    if (t === 'history' && change) return `${change}%`
    return null
  }

  return (
    <div className="app">
      <header className="app-bar">
        <div className="doc-id">
          <span className="logo" aria-hidden="true">rc</span>
          <div className="doc-id-text">
            <button
              className="doc-switch"
              onClick={() => openDrafts(!draftsOpen)}
              aria-expanded={draftsOpen}
              title="Your drafts: switch, start a new one, or import a Word file"
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
        </div>
        <button className="search-pill" onClick={() => setPaletteOpen(true)}>
          <Icon name="search" size={16} />
          <span>Search sources, jump, run actions</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="bar-actions">
          <div className="bar-group" role="group" aria-label="Document">
            <button className="bar-btn" onClick={newDraft} title="Start a new draft (Ctrl+N)">
              <Icon name="plus" size={16} />
              <span>New</span>
            </button>
            <button className="bar-btn" onClick={pickWord} title="Open a Word file as a draft, into this draft, or as a source (Ctrl+O). You can also drop it on the window.">
              <Icon name="upload" size={16} />
              <span>Import</span>
            </button>
            <ExportControl
              style={settings.citation_style}
              getJSON={() => editor.current?.getJSON() ?? null}
              getTitle={() => editor.current?.getTitle() ?? 'Untitled'}
              onError={onError}
            />
          </div>
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
          <button className="icon-button" onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings">
            <Icon name="settings" size={18} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <nav className="rail rail-left" aria-label="Drafts and sources">
          <button className={`rail-btn${draftsOpen ? ' on' : ''}`} onClick={() => openDrafts(!draftsOpen)} title="Your drafts: start a new one, import a Word file, or switch">
            <Icon name="drafts" />
            <span>Drafts</span>
            {drafts.length > 1 && <em className="rail-badge">{drafts.length}</em>}
          </button>
          <button className={`rail-btn${libraryOpen ? ' on' : ''}`} onClick={() => openLibrary(!libraryOpen)} title="Add and organize sources">
            <Icon name="library" />
            <span>Library</span>
            {docs.length > 0 && <em className="rail-badge">{docs.length}</em>}
          </button>
          <button className={`rail-btn${networkOpen ? ' on' : ''}`} onClick={() => openNetwork(!networkOpen)} title="Who cites whom in your library">
            <Icon name="network" />
            <span>Network</span>
          </button>
        </nav>

        <div className={`stage${pinned && drawerOpen ? ' pinned' : ''}`}>
          <div className={`drawer drawer-left drafts-drawer${draftsOpen ? ' show' : ''}`} aria-hidden={!draftsOpen}>
            <button className="drawer-close" onClick={() => setDraftsOpen(false)} aria-label="Close drafts">
              ×
            </button>
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
          <div className={`drawer drawer-left${libraryOpen ? ' show' : ''}${libraryWide ? ' wide' : ''}`} aria-hidden={!libraryOpen}>
            <button className="drawer-close" onClick={() => setLibraryOpen(false)} aria-label="Close library">
              ×
            </button>
            <LibraryPanel
              docs={docs}
              folders={folders}
              wide={libraryWide}
              onToggleWide={() => setLibraryWide((w) => !w)}
              selected={selected}
              onToggle={(id) =>
                setSelected((s) => {
                  const n = new Set(s)
                  n.has(id) ? n.delete(id) : n.add(id)
                  return n
                })
              }
              onChanged={refresh}
              onError={onError}
              focus={libFocus}
              jobs={jobs}
              onAddPaths={addToLibrary}
              onCancelJob={cancelJob}
              onDismissJob={(id) => setJobs((js) => js.filter((j) => j.id !== id))}
              onFindDuplicates={() => setDupFilesOpen(true)}
            />
          </div>

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
                    onAddSources={() => openLibrary()}
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
              onCiteMarkClick={(cid) => {
                setCiteFocus(cid)
                showTab('cite')
              }}
              onCiteMarks={setCiteMarks}
              getScope={() => (selected.size ? [...selected] : null)}
              onError={onError}
            />
          </main>

          <aside className={`drawer drawer-right panel sidebar${drawerOpen ? ' show' : ''}`} aria-hidden={!drawerOpen}>
            <header className="panel-bar">
              <span className="panel-ico"><Icon name={tool.icon} size={18} /></span>
              <div className="panel-bar-text">
                <h2>{tool.tab === 'references' ? 'References' : tool.label}</h2>
                <span>{tool.hint}</span>
              </div>
              <button
                className={`icon-button${pinned ? ' on' : ''}`}
                onClick={() => setPinned((p) => !p)}
                title={pinned ? 'Unpin: slide the panel over the page' : 'Pin beside the page'}
                aria-pressed={pinned}
              >
                <Icon name="pin" size={16} />
              </button>
              <button className="icon-button" onClick={() => setDrawerOpen(false)} aria-label="Close panel">
                ×
              </button>
            </header>
            <div className="tab-body">
              <div hidden={tab !== 'assistant'}>
                <AssistantPanel
                  scope={[...selected]}
                  sourceCount={docs.length}
                  onChooseSources={() => openLibrary()}
                  getContext={() => editor.current?.getText() ?? ''}
                  onInsert={(s) => editor.current?.insertDraft(s)}
                  onVerified={onVerified}
                  onOpenCitation={openCitation}
                  onError={onError}
                />
              </div>
              {tab === 'source' && <SourceViewer target={source} doc={docs.find((d) => d.id === source?.docId)} />}
              {/* Kept mounted (hidden) so results survive a look at the Source tab. */}
              <div hidden={tab !== 'cite'}>
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
                  onOpenSource={openCitation}
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
                  onError={onError}
                />
              )}
            </div>
          </aside>

          {networkOpen && (
            <Suspense fallback={null}>
              <NetworkView
                onClose={() => setNetworkOpen(false)}
                onOpenPaper={showPaper}
                onError={onError}
              />
            </Suspense>
          )}

          <CitationWire cid={source?.cid} status={source?.status ?? 'pending'} active={drawerOpen && tab === 'source'} />
        </div>

        <nav className="rail rail-right" aria-label="Writing tools">
          {TOOLS.map((g) => (
            <div key={g.group} className="rail-group">
              <span className="rail-group-label">{g.group}</span>
              {g.tools.map((t) => {
                const badge = badgeFor(t.tab)
                return (
                  <button
                    key={t.tab}
                    className={`rail-btn${drawerOpen && tab === t.tab ? ' on' : ''}`}
                    onClick={() => toggleTool(t.tab)}
                    title={t.hint}
                  >
                    <Icon name={t.icon} />
                    <span>{t.label}</span>
                    {badge && (
                      <em
                        className="rail-badge"
                        style={t.tab === 'review' && dupPct != null ? { background: toneOf(dupPct, 'risk') } : undefined}
                      >
                        {badge}
                      </em>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
      </div>

      <footer className="dock">
        <div className="dock-stats">
          <span className="stat" title="Words in the draft">
            <b>{stats.words.toLocaleString()}</b> <span className="lbl">words</span>
          </span>
          <button
            className="stat"
            onClick={() => {
              if (!stats.unconfirmed) return showTab('references')
              setCiteFocus(null)
              showTab('cite')
            }}
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
        <div className="grow">
          {folders.slice(0, 3).map((f) => (
            <span key={f.id} className="pill" title={`${f.doc_count} docs`}>
              {f.name}
            </span>
          ))}
        </div>
        {health && health.api !== API_VERSION && !offline && (
          <span className="offline status" title="The backend was started before the app was updated">
            Restart the app to finish updating
          </span>
        )}
        {importingNow && (
          <button className="stat dock-import" onClick={() => openLibrary()} title="Adding files to your library: open it to see each file">
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

      {showSettings && (
        <SettingsDialog settings={settings} onChange={changeSettings} onClose={() => setShowSettings(false)} />
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
