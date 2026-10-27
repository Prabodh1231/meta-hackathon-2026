import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { AssistantPanel } from './components/AssistantPanel'
import { CitePanel, type CiteRequest } from './components/CitePanel'
import { ExportControl } from './components/ExportControl'
import { LibraryPanel } from './components/LibraryPanel'
import { ReferencesPanel } from './components/ReferencesPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { applyTheme, cacheTheme, cachedTheme, watchSystemTheme } from './theme'
import { SourceViewer, type SourceTarget } from './components/SourceViewer'
import { WritingEditor, type ChipAttrs, type WritingEditorHandle } from './components/WritingEditor'
import type { Citation, Doc, Health, Settings, Topic } from './types'

type Tab = 'assistant' | 'cite' | 'source' | 'references'
const TAB_LABELS: Record<Tab, string> = { assistant: 'Assistant', cite: 'Cite', source: 'Source', references: 'References' }

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [docs, setDocs] = useState<Doc[]>([])
  const [topics, setTopics] = useState<Topic[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [tab, setTab] = useState<Tab>('assistant')
  const [source, setSource] = useState<(SourceTarget & { cid?: string }) | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [settings, setSettings] = useState<Settings>({ theme: cachedTheme(), citation_style: 'apa' })
  const [showSettings, setShowSettings] = useState(false)
  const [citeRequest, setCiteRequest] = useState<CiteRequest | null>(null)
  const editor = useRef<WritingEditorHandle>(null)

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
    const [d, t] = await Promise.all([api.documents(), api.topics()])
    setDocs(d)
    setTopics(t)
    setSelected((s) => new Set([...s].filter((id) => d.some((doc) => doc.id === id))))
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
    setTab('source')
  }

  async function openChip(a: ChipAttrs) {
    setSource({ ...a })
    setTab('source')
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

  return (
    <div className="app">
      <LibraryPanel
        docs={docs}
        topics={topics}
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
      />

      <main className="writing">
        <header className="panel-head">
          <div>
            <h2>Draft</h2>
            <span className="muted">
              {health ? `model: ${health.provider} · embeddings: ${health.embedder}` : 'Starting backend…'}
            </span>
          </div>
          <div className="head-actions">
            <ExportControl
              style={settings.citation_style}
              getJSON={() => editor.current?.getJSON() ?? null}
              getTitle={() => editor.current?.getTitle() ?? 'Untitled'}
              onError={onError}
            />
            <button className="icon-button" onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M19.14 12.94a7.14 7.14 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.14 7.14 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"
                />
              </svg>
            </button>
          </div>
        </header>
        <WritingEditor
          ref={editor}
          onCitationClick={openChip}
          onCiteRequest={(claim) => {
            setCiteRequest({ id: Date.now(), claim })
            setTab('cite')
          }}
          onError={onError}
        />
      </main>

      <aside className="panel sidebar">
        <nav className="tabs">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
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
        </div>
      </aside>

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
