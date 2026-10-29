import { useCallback, useEffect, useRef, useState } from 'react'
import { api, backendLogPath } from './api'
import { AssistantPanel } from './components/AssistantPanel'
import { CitationWire } from './components/CitationWire'
import { CitePanel, type CiteRequest } from './components/CitePanel'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import { DuplicateFilesDialog } from './components/DuplicateFilesDialog'
import { ExportControl } from './components/ExportControl'
import { HistoryPanel } from './components/HistoryPanel'
import { Icon, type IconName } from './components/Icon'
import { LibraryPanel } from './components/LibraryPanel'
import { ago, toneOf } from './components/Meters'
import { NetworkView } from './components/NetworkView'
import { ReferencesPanel } from './components/ReferencesPanel'
import { ReviewPanel } from './components/ReviewPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { applyTheme, cacheTheme, cachedTheme, watchSystemTheme } from './theme'
import { SourceViewer, type SourceTarget } from './components/SourceViewer'
import {
  DRAFT_ID,
  WritingEditor,
  type ChipAttrs,
  type DraftStats,
  type SaveState,
  type WritingEditorHandle,
} from './components/WritingEditor'
import type { Citation, Doc, DuplicateReport, Folder, Health, Settings, SourceMatch, VersionList } from './types'

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
      { tab: 'cite', label: 'Cite', icon: 'cite', hint: 'Sources for the sentence at the cursor' },
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
  const [settings, setSettings] = useState<Settings>({ theme: cachedTheme(), citation_style: 'apa' })
  const [showSettings, setShowSettings] = useState(false)
  const [dupFilesOpen, setDupFilesOpen] = useState(false)
  const [citeRequest, setCiteRequest] = useState<CiteRequest | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryWide, setLibraryWide] = useState(false) // library as a file manager
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [pinned, setPinned] = useState(initialPinned)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [networkOpen, setNetworkOpen] = useState(false)
  const [stats, setStats] = useState<DraftStats>({ words: 0, citations: 0, verified: 0, flagged: 0 })
  const [title, setTitle] = useState('Untitled')
  const [saveState, setSaveState] = useState<SaveState>({ state: 'idle' })
  const [versions, setVersions] = useState<VersionList | null>(null)
  const [dup, setDup] = useState<{ report: DuplicateReport | null; at: number | null; busy: boolean; stale: boolean }>({
    report: null,
    at: null,
    busy: false,
    stale: false,
  })
  const [, setTick] = useState(0) // re-renders "Saved 3 min ago"
  const editor = useRef<WritingEditorHandle>(null)

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

  // The library drawer and the network view cover the same area, so only one is open at a time.
  const openLibrary = useCallback((open = true) => {
    setLibraryOpen(open)
    if (open) setNetworkOpen(false)
  }, [])
  const openNetwork = useCallback((open = true) => {
    setNetworkOpen(open)
    if (open) setLibraryOpen(false)
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (e.key === 'Escape' && !paletteOpen) {
        setLibraryOpen(false)
        setDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen])

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
    setVersions(await api.versions(DRAFT_ID))
  }, [])

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
    setDup((d) => ({ ...d, busy: true }))
    try {
      const report = await api.checkDuplicates(content)
      setDup({ report, at: Date.now(), busy: false, stale: false })
    } catch (e) {
      setDup((d) => ({ ...d, busy: false }))
      onError(`Duplication check failed: ${e instanceof Error ? e.message : e}`)
    }
  }, [onError])

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
    if (!reviewing || dup.busy) return
    if (!dup.report) {
      runCheck()
      return
    }
    if (!dup.stale) return
    const t = window.setTimeout(runCheck, 4000)
    return () => window.clearTimeout(t)
  }, [reviewing, dup.stale, dup.report, dup.busy, runCheck])

  function onStats(s: DraftStats) {
    setStats(s)
    setTitle(editor.current?.getTitle() ?? 'Untitled')
    setDup((d) => (d.report && !d.stale ? { ...d, stale: true } : d))
  }

  function onSaveState(s: SaveState) {
    setSaveState(s)
    if (s.state === 'saved') refreshVersions().catch(() => {})
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
    { group: 'DO', name: 'Find a citation', hint: 'for the selected sentence', run: () => showTab('cite') },
    { group: 'DO', name: 'Show references', hint: settings.citation_style.toUpperCase(), run: () => showTab('references') },
    { group: 'DO', name: 'Check for duplication', hint: 'repeats and text matching sources', run: () => showTab('review') },
    { group: 'DO', name: 'Version history', hint: 'save, compare and restore versions', run: () => showTab('history') },
    { group: 'DO', name: 'Find duplicate files', hint: 'suggests cleanup, removes nothing', run: () => setDupFilesOpen(true) },
    { group: 'DO', name: 'Settings', hint: 'theme, citation style', run: () => setShowSettings(true) },
  ]

  const latest = versions?.versions[0]
  const change = versions?.current_change ?? null
  const dupPct = dup.report?.overall ?? null
  const tool = TOOL[tab]

  function badgeFor(t: Tab): string | null {
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
            <div className="doc-name" title={title}>{title}</div>
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
          <ExportControl
            style={settings.citation_style}
            getJSON={() => editor.current?.getJSON() ?? null}
            getTitle={() => editor.current?.getTitle() ?? 'Untitled'}
            onError={onError}
          />
          <button className="icon-button" onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings">
            <Icon name="settings" size={18} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <nav className="rail rail-left" aria-label="Library">
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
              onFindDuplicates={() => setDupFilesOpen(true)}
            />
          </div>

          <main className="writing">
            <WritingEditor
              ref={editor}
              onStats={onStats}
              onSaveState={onSaveState}
              onCitationClick={openChip}
              onCiteRequest={(claim) => {
                setCiteRequest({ id: Date.now(), claim })
                showTab('cite')
              }}
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
                  request={citeRequest}
                  scope={[...selected]}
                  onInsert={(c, claim) => editor.current?.insertCitation(c, claim) ?? false}
                  onOpenSource={openCitation}
                  onError={onError}
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
                  onRun={runCheck}
                  onReveal={(block, text) => editor.current?.reveal(block, text)}
                  onOpenSource={openMatch}
                />
              )}
              {tab === 'history' && (
                <HistoryPanel
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
            <NetworkView
              onClose={() => setNetworkOpen(false)}
              onOpenPaper={showPaper}
              onError={onError}
            />
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
            <b>{stats.words.toLocaleString()}</b> words
          </span>
          <button className="stat" onClick={() => showTab('references')} title="Citations verified against their source">
            <span className="mini-bar">
              <span style={{ width: `${stats.citations ? (100 * stats.verified) / stats.citations : 0}%` }} />
            </span>
            <b>{stats.verified}</b>/{stats.citations} citations verified
            {stats.flagged > 0 && <em className="flag">{stats.flagged} flagged</em>}
          </button>
          <button className="stat" onClick={() => showTab('review')} title="Share of the draft that repeats itself or matches a source">
            <span className="dot" style={{ background: dupPct == null ? 'var(--pending)' : toneOf(dupPct, 'risk') }} />
            {dupPct == null ? 'Duplication not checked' : <><b>{dupPct}%</b> duplication{dup.stale ? ' (outdated)' : ''}</>}
          </button>
          <button className="stat" onClick={() => showTab('history')} title="How much the draft changed since the newest version">
            <Icon name="history" size={14} />
            {change == null ? 'No versions yet' : <><b>{change}%</b> changed since v{latest?.number}</>}
          </button>
        </div>
        <div className="grow">
          {folders.slice(0, 3).map((f) => (
            <span key={f.id} className="pill" title={`${f.doc_count} docs`}>
              {f.name}
            </span>
          ))}
        </div>
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

      {errors.length > 0 && (
        <div className="toasts">
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
