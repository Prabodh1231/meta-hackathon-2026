import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { AssistantPanel } from './components/AssistantPanel'
import { LibraryPanel } from './components/LibraryPanel'
import { ReferencesPanel } from './components/ReferencesPanel'
import { SourceViewer, type SourceTarget } from './components/SourceViewer'
import { WritingEditor, type ChipAttrs, type WritingEditorHandle } from './components/WritingEditor'
import type { Citation, Doc, Health, Topic } from './types'

type Tab = 'assistant' | 'source' | 'references'

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [docs, setDocs] = useState<Doc[]>([])
  const [topics, setTopics] = useState<Topic[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [tab, setTab] = useState<Tab>('assistant')
  const [source, setSource] = useState<(SourceTarget & { cid?: string }) | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const editor = useRef<WritingEditorHandle>(null)

  const onError = useCallback((msg: string) => setErrors((e) => [...e.slice(-2), msg]), [])

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
          <h2>Draft</h2>
          <span className="muted">
            {health ? `model: ${health.provider} · embeddings: ${health.embedder}` : 'Starting backend…'}
          </span>
        </header>
        <WritingEditor ref={editor} onCitationClick={openChip} onError={onError} />
      </main>

      <aside className="panel sidebar">
        <nav className="tabs">
          {(['assistant', 'source', 'references'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'assistant' ? 'Assistant' : t === 'source' ? 'Source' : 'References'}
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
          {tab === 'references' && (
            <ReferencesPanel citedDocIds={() => editor.current?.citedDocIds() ?? []} onError={onError} />
          )}
        </div>
      </aside>

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
