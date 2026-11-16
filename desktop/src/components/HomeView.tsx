import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { DEMO_STEPS, type DemoState } from '../demo'
import type { Tally } from '../editor/citeStatus'
import { CITATION_WORD } from '../editor/citeStatus'
import { readViews, type SavedView } from '../libraryFilters'
import type { Doc, DraftSummary, Folder, MatrixSummary } from '../types'
import { type Step, StepPreview } from './GettingStarted'
import { Icon } from './Icon'
import { ago } from './Meters'
import { Ribbons } from './Ribbons'
import type { ChipAttrs } from './WritingEditor'

interface Props {
  visible: boolean
  docs: Doc[]
  folders: Folder[]
  drafts: DraftSummary[]
  draftId: number
  /** The open draft: its title, its first lines, and how its citations stand. */
  docTitle: string
  excerpt: string
  words: number
  cites: Tally
  chips: ChipAttrs[]
  demo: DemoState | null
  /** The sample library ships with the desktop app only. */
  canTrySamples: boolean
  /** Getting started's steps, while it hasn't been hidden and there is still something to set up. */
  guide: Step[] | null
  onHideGuide: () => void
  onWrite: () => void
  onCheck: () => void
  onAddSources: () => void
  onOpenDraft: (id: number) => void
  onOpenPaper: (id: number) => void
  onOpenTopic: (id: number) => void
  onOpenView: (id: string) => void
  onGo: (place: 'library' | 'network' | 'matrix') => void
  onTrySamples: () => void
  onOpenDemo: () => void
  onShowDrafts: () => void
  /** The foot of the page: what each link does, in the app's own words. */
  links: { head: string; items: { label: string; keys?: string; run: () => void }[] }[]
}

const utc = (when: string) => Date.parse(when.replace(' ', 'T') + 'Z')
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

/** How many of a saved draft's citations are supported, read from its stored document. */
function countCitations(content: string): { supported: number; total: number } {
  const out = { supported: 0, total: 0 }
  const walk = (n: { type?: string; attrs?: { status?: string }; content?: unknown[] }) => {
    if (n.type === 'citation') {
      out.total++
      if (n.attrs?.status === 'verified') out.supported++
    }
    for (const c of n.content ?? []) walk(c as never)
  }
  try {
    walk(JSON.parse(content))
  } catch {
    /* an empty or unreadable draft has no citations to count */
  }
  return out
}

const VIEWS_KEY = 'gw.library.views' // where the Library keeps the reader's saved views
function savedViews(): SavedView[] {
  try {
    return readViews(JSON.parse(localStorage.getItem(VIEWS_KEY) ?? '[]'))
  } catch {
    return []
  }
}

/** What a saved view asks for, in a line: its search and how many filter chips it holds. */
function viewLine(v: SavedView): string {
  const f = v.filters
  const chips = f.kinds.length + f.topics.length + f.authors.length + f.venues.length + (f.year ? 1 : 0) + (f.highlighted ? 1 : 0)
  const parts = [v.query.trim() && `Search: “${v.query.trim()}”`, chips > 0 && plural(chips, 'filter')].filter(Boolean)
  return parts.join(' · ') || 'Every paper in this view'
}

/** A tool on Home: its name top left, an arrow top right, a live preview below. The whole card opens it. */
function ToolCard({ title, text, wide, onOpen, children }: { title: string; text: string; wide?: boolean; onOpen: () => void; children: ReactNode }) {
  return (
    <button className={`tool-card${wide ? ' wide' : ''}`} onClick={onOpen}>
      <span className="tool-card-head">
        <b>{title}</b>
        <span className="sq-btn" aria-hidden="true">
          <Icon name="open" size={15} />
        </span>
      </span>
      <span className="tool-card-text">{text}</span>
      <span className="tool-card-prev">{children}</span>
    </button>
  )
}

/** Home: where the app opens. One scrolling page, a centred column between two hairlines: what you were
 * doing, the five tools with what's in each right now, the library in numbers, and where to pick up. */
export function HomeView(p: Props) {
  const { docs, folders, drafts, cites } = p
  const [tab, setTab] = useState<'drafts' | 'added' | 'views'>('drafts')
  const [matrices, setMatrices] = useState<MatrixSummary[]>([])
  const [views, setViews] = useState<SavedView[]>([])
  const [counts, setCounts] = useState<Record<number, { supported: number; total: number; at: string | null }>>({})
  const reel = useRef<HTMLDivElement>(null)
  const [ends, setEnds] = useState({ start: true, end: false })

  const byRecent = useMemo(() => [...drafts].sort((a, b) => (b.updated_at ? utc(b.updated_at) : 0) - (a.updated_at ? utc(a.updated_at) : 0)), [drafts])
  const newest = useMemo(() => [...docs].sort((a, b) => utc(b.added_at) - utc(a.added_at)), [docs])
  const topics = useMemo(() => folders.filter((f) => f.doc_count > 0).sort((a, b) => b.doc_count - a.doc_count), [folders])
  const marked = useMemo(() => docs.filter((d) => d.highlights > 0).sort((a, b) => b.highlights - a.highlights), [docs])
  const highlights = marked.reduce((n, d) => n + d.highlights, 0)
  const unread = docs.filter((d) => d.unread).length
  const shownDrafts = byRecent.slice(0, 3)

  // What only Home shows is fetched when Home is: the matrices, the saved views, and the citation
  // counts of the drafts that aren't open (the open one's are live, from the editor).
  useEffect(() => {
    if (!p.visible) return
    setViews(savedViews())
    api.matrices().then(setMatrices).catch(() => {})
  }, [p.visible])
  const wanted = shownDrafts.filter((d) => d.id !== p.draftId && counts[d.id]?.at !== d.updated_at).map((d) => `${d.id}@${d.updated_at}`).join(',')
  useEffect(() => {
    if (!p.visible || !wanted) return
    let live = true
    for (const d of shownDrafts.filter((x) => x.id !== p.draftId)) {
      api
        .getDraft(d.id)
        .then((r) => live && setCounts((c) => ({ ...c, [d.id]: { ...countCitations(r.content), at: d.updated_at } })))
        .catch(() => {})
    }
    return () => {
      live = false
    }
  }, [p.visible, wanted]) // eslint-disable-line react-hooks/exhaustive-deps

  const measure = () => {
    const r = reel.current
    if (r) setEnds({ start: r.scrollLeft < 4, end: r.scrollLeft + r.clientWidth > r.scrollWidth - 4 })
  }
  useEffect(() => {
    if (!p.visible) return
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [p.visible, topics.length])

  const pct = cites.total ? Math.round((100 * cites.supported) / cites.total) : null
  const bar = (n: number) => `${cites.total ? Math.max(n ? 4 : 0, (100 * n) / cites.total) : 0}%`
  const quoted = p.chips.find((c) => c.status === 'verified' && c.quote) ?? p.chips.find((c) => c.quote)
  const editedThisWeek = drafts.filter((d) => d.updated_at && Date.now() - utc(d.updated_at) < 7 * 86400e3).length
  const recent: { key: string; kind: string; name: string; run: () => void }[] = [
    ...byRecent.slice(0, 2).map((d) => ({ key: `d${d.id}`, kind: `Draft · ${d.updated_at ? ago(d.updated_at) : 'new'}`, name: d.title || 'Untitled', run: () => p.onOpenDraft(d.id) })),
    ...newest.slice(0, 5).map((d) => ({ key: `p${d.id}`, kind: `Paper · added ${ago(d.added_at)}`, name: d.label || d.title, run: () => p.onOpenPaper(d.id) })),
  ].slice(0, 5)
  const demoDone = p.demo ? DEMO_STEPS.filter((s) => p.demo!.done.includes(s.step)).length : 0

  return (
    <div className="home" aria-label="Home">
      <section className="home-hero">
        <Ribbons className="home-art" />
        <div className="home-col">
          <p className="live-line">
            {pct != null ? (
              <>
                Citations in this draft backed by a source: <b>{pct}%</b>
              </>
            ) : docs.length ? (
              <>
                In your library: <b>{plural(docs.length, 'source')}</b>
              </>
            ) : (
              'Your papers, drafts and highlights stay on this computer.'
            )}
          </p>
          <h1 className="say say-xl">
            <b>Write only what your sources say.</b> Draft from your own papers, see the passage behind every citation, and know what still needs checking.
          </h1>
          <div className="home-cta">
            <button className="btn-go" onClick={p.onWrite}>
              {p.words ? 'Continue writing' : 'Start writing'} <span className="ar">›</span>
            </button>
            <button className="btn-go quiet" onClick={p.onAddSources}>
              {docs.length ? 'Open the library' : 'Add sources'}
            </button>
          </div>
          {recent.length > 0 && (
            <div className="strip" aria-label="Recent">
              {recent.map((r) => (
                <button key={r.key} onClick={r.run} title={r.name}>
                  <small>{r.kind}</small>
                  <span>{r.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {p.guide && (
        <section className="home-band">
          <div className="home-col">
            <div className="split-head">
              <h2 className="say">
                <b>Four steps to a cited draft.</b> Each one ticks itself off as you do it.
              </h2>
              <button className="link" onClick={p.onHideGuide}>
                Hide getting started
              </button>
            </div>
            <ol className="guide-steps">
              {p.guide.map((s, i) => (
                <li key={s.title} className={s.done ? 'done' : ''}>
                  <StepPreview scene={s.scene} done={s.done} />
                  <div className="guide-step-text">
                    <span className="gs-num" aria-hidden="true">
                      {s.done ? '✓' : i + 1}
                    </span>
                    <div>
                      <b>{s.title}</b>
                      {s.done && <span className="sr-only"> (done)</span>}
                      <p>{s.text}</p>
                      {s.actions && <div className="gs-actions">{s.actions}</div>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}

      <section className={p.guide ? '' : 'home-band'}>
        <div className="home-col">
          <h2 className="say">
            <b>Everything a literature review needs.</b> Five tools that share one library, made to work on their own or together.
          </h2>
          <div className="bento">
            <ToolCard wide title="Write with your sources beside the page" text="Muse drafts from your library, and every sentence it cites links to the exact passage." onOpen={p.onWrite}>
              <Ribbons className="tool-card-art" />
              <span className="mini-paper">
                <b>{p.docTitle}</b>
                {p.excerpt || 'A blank page. Type on it, or ask Muse to draft from your sources.'}
              </span>
              {quoted && (
                <span className="mini-quote">
                  <small>{quoted.label}</small>
                  <q>{quoted.quote.length > 150 ? `${quoted.quote.slice(0, 150).trim()}…` : quoted.quote}</q>
                  <span className={`cite cite-${quoted.status} legend-chip`}>{CITATION_WORD[quoted.status]}</span>
                </span>
              )}
            </ToolCard>
            <ToolCard title="Check every citation" text="What needs you comes first, worst at the top." onOpen={p.onCheck}>
              <span className="mini-tally">
                <span className="mini-big">
                  {cites.total}
                  <small>{cites.total === 1 ? 'citation in this draft' : 'citations in this draft'}</small>
                </span>
                {cites.total > 0 ? (
                  <>
                    <span className="tally-bar" style={{ '--w': bar(cites.supported), '--c': 'var(--ok)' } as React.CSSProperties}><span>Supported</span><i /><b>{cites.supported}</b></span>
                    <span className="tally-bar" style={{ '--w': bar(cites.toConfirm), '--c': 'var(--warn)' } as React.CSSProperties}><span>To confirm</span><i /><b>{cites.toConfirm}</b></span>
                    <span className="tally-bar" style={{ '--w': bar(cites.attention - cites.toConfirm), '--c': 'var(--bad)' } as React.CSSProperties}><span>Needs attention</span><i /><b>{Math.max(0, cites.attention - cites.toConfirm)}</b></span>
                    <span className="tally-bar" style={{ '--w': bar(cites.checking), '--c': 'var(--pending)' } as React.CSSProperties}><span>Checking</span><i /><b>{cites.checking}</b></span>
                  </>
                ) : (
                  <span className="mini-note">Press Cite in a sentence and keep writing. Its marker turns green when a source supports it.</span>
                )}
              </span>
            </ToolCard>
            <ToolCard title="Read and highlight" text="Highlights come back when you write about them." onOpen={() => p.onGo('library')}>
              <span className="mini-list">
                {marked.length ? (
                  marked.slice(0, 3).map((d) => (
                    <span key={d.id}>
                      <b>{d.highlights}</b>
                      <span>{d.label || d.title}</span>
                    </span>
                  ))
                ) : (
                  <span className="mini-note">Open a paper and select a passage to highlight it or add a note.</span>
                )}
              </span>
            </ToolCard>
            <ToolCard title="See how your papers connect" text="Who cites whom, and what your library is missing." onOpen={() => p.onGo('network')}>
              <svg className="mini-net" viewBox="0 0 320 170" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                <path d="M160 82 70 40M160 82 250 34M160 82 96 140M160 82 236 136M70 40 96 140M250 34 236 136M250 34 296 86M70 40 30 94" />
                <circle cx="70" cy="40" r="9" /><circle cx="250" cy="34" r="11" /><circle cx="96" cy="140" r="8" /><circle cx="236" cy="136" r="9" /><circle cx="296" cy="86" r="6" /><circle cx="30" cy="94" r="6" />
                <circle className="hot" cx="160" cy="82" r="15" />
              </svg>
            </ToolCard>
            <ToolCard title="Find the gaps with a review matrix" text="Papers against questions, with the empty cells named." onOpen={() => p.onGo('matrix')}>
              <span className="mini-list">
                {matrices.length ? (
                  matrices.slice(0, 3).map((m) => (
                    <span key={m.id}>
                      <b>{m.papers}</b>
                      <span>{m.name}</span>
                    </span>
                  ))
                ) : (
                  <span className="mini-note">No matrix yet. Pick a topic and Muse reads each paper for sample, method and findings.</span>
                )}
              </span>
            </ToolCard>
          </div>
        </div>
      </section>

      {(p.canTrySamples || p.demo) && (
        <section>
          <div className="home-col">
            <div className="banner">
              <Ribbons className="banner-art" />
              <h2>{p.demo ? 'Pick the demo back up.' : 'New here? Walk through a finished review.'}</h2>
              <p>
                {p.demo
                  ? `The demo draft and its checklist are where you left them: ${demoDone} of ${DEMO_STEPS.length} steps done.`
                  : 'The sample library opens a demo draft with four citations to check. One is wrong on purpose.'}
              </p>
              <button className="btn-go white" onClick={p.demo ? p.onOpenDemo : p.onTrySamples}>
                {p.demo ? 'Open the demo draft' : 'Try the sample library'} <span className="ar">›</span>
              </button>
              <ol className="banner-steps" aria-hidden="true">
                {DEMO_STEPS.map((s, i) => {
                  const done = !!p.demo?.done.includes(s.step)
                  return (
                    <li key={s.step} className={done ? 'done' : ''}>
                      <i>{done ? '✓' : i + 1}</i>
                      {s.title}
                    </li>
                  )
                })}
              </ol>
            </div>
          </div>
        </section>
      )}

      <section className="home-band home-stats">
        <div className="home-col">
          <h2 className="say-center">Your library at a glance</h2>
          <div className="big-stats">
            <button onClick={() => p.onGo('library')} title="Open the Library">
              <strong>{docs.length.toLocaleString()}</strong>
              <span>{docs.length === 1 ? 'source' : 'sources'}{unread ? `, ${unread} unread` : ''}</span>
            </button>
            <button onClick={() => p.onGo('library')} title="Open the Library">
              <strong>{highlights.toLocaleString()}</strong>
              <span>{highlights === 1 ? 'highlight' : 'highlights and notes'}{marked.length ? ` across ${plural(marked.length, 'paper')}` : ''}</span>
            </button>
            <button onClick={p.onCheck} title="Open Check for this draft">
              <strong>{pct == null ? '–' : `${pct}%`}</strong>
              <span>{pct == null ? 'no citations in this draft yet' : `of this draft's ${plural(cites.total, 'citation')} supported`}</span>
            </button>
            <button onClick={p.onShowDrafts} title="Show your drafts">
              <strong>{drafts.length.toLocaleString()}</strong>
              <span>{drafts.length === 1 ? 'draft' : 'drafts'}{editedThisWeek ? `, ${editedThisWeek} edited this week` : ''}</span>
            </button>
          </div>
          <div className="home-glow">
            <p>
              {[topics.length && plural(topics.length, 'topic'), newest[0] && `newest source added ${ago(newest[0].added_at)}`, matrices.length && `${matrices.length} review ${matrices.length === 1 ? 'matrix' : 'matrices'}`]
                .filter(Boolean)
                .join(' · ') || 'Add your first sources to see them counted here.'}
            </p>
          </div>
        </div>
      </section>

      {topics.length > 0 && (
        <section>
          <div className="home-col">
            <div className="split-head">
              <h2>Your topics, at a glance</h2>
              <p>
                {plural(topics.length, 'topic')} hold your {plural(docs.length, 'source')}. The largest are first.
              </p>
              <span className="sq-pair">
                <button className="sq-btn" disabled={ends.start} onClick={() => reel.current?.scrollBy({ left: -404, behavior: 'smooth' })} aria-label="Earlier topics">
                  <Icon name="back" size={15} />
                </button>
                <button className="sq-btn" disabled={ends.end} onClick={() => reel.current?.scrollBy({ left: 404, behavior: 'smooth' })} aria-label="More topics">
                  <Icon name="forward" size={15} />
                </button>
              </span>
            </div>
            <div className="reel" ref={reel} onScroll={measure}>
              {topics.map((f, i) => {
                const fresh = docs.filter((d) => d.unread && d.folders.some((x) => x.id === f.id)).length
                return (
                  <button key={f.id} className={`topic-card tone-${i % 4}`} onClick={() => p.onOpenTopic(f.id)} title={`Open “${f.name}” in the Library`}>
                    <i>{f.doc_count}</i>
                    <b>{f.name}</b>
                    <small>{fresh ? `${fresh} unread` : 'All read'}</small>
                  </button>
                )
              })}
            </div>
          </div>
        </section>
      )}

      <section className={topics.length > 0 ? 'home-band' : ''}>
        <div className="home-col">
          <h2 className="say">
            <b>Pick up where you left off.</b> Your drafts, what you added last and the views you saved.
          </h2>
          <div className="utabs" role="tablist" aria-label="Pick up where you left off">
            <button role="tab" aria-selected={tab === 'drafts'} onClick={() => setTab('drafts')}>Drafts</button>
            <button role="tab" aria-selected={tab === 'added'} onClick={() => setTab('added')}>Recently added</button>
            <button role="tab" aria-selected={tab === 'views'} onClick={() => setTab('views')}>Saved views</button>
          </div>
          {tab === 'drafts' && (
            <div className="stories">
              {shownDrafts.map((d) => {
                const c = d.id === p.draftId ? { supported: cites.supported, total: cites.total } : counts[d.id]
                return (
                  <button key={d.id} className="story-card" onClick={() => p.onOpenDraft(d.id)}>
                    <small>{d.updated_at ? `Edited ${ago(d.updated_at)}` : 'New'}{d.id === p.draftId ? ' · open now' : ''}</small>
                    <b>{d.title || 'Untitled'}</b>
                    <span className="story-figs">
                      <span><i>{(d.id === p.draftId ? p.words : d.words).toLocaleString()}</i>words</span>
                      {c && <span><i>{c.total ? `${c.supported} of ${c.total}` : '0'}</i>{c.total ? 'citations supported' : 'citations yet'}</span>}
                    </span>
                    <span className="link-go">Open draft ›</span>
                  </button>
                )
              })}
              {shownDrafts.length === 0 && <p className="home-none">Your first draft is saved as you type.</p>}
            </div>
          )}
          {tab === 'added' && (
            <div className="stories">
              {newest.slice(0, 3).map((d) => (
                <button key={d.id} className="story-card" onClick={() => p.onOpenPaper(d.id)}>
                  <small>{[d.venue, d.year].filter(Boolean).join(' · ') || `Added ${ago(d.added_at)}`}</small>
                  <b>{d.title}</b>
                  <span className="story-figs">
                    <span><i>{d.page_count || '–'}</i>{d.page_count === 1 ? 'page' : 'pages'}</span>
                    <span><i>{d.highlights}</i>{d.highlights === 1 ? 'highlight' : 'highlights'}</span>
                  </span>
                  <span className="link-go">Open in the Library ›</span>
                </button>
              ))}
              {newest.length === 0 && <p className="home-none">Nothing in your library yet. Papers, notes, slides, scans and web pages all go in.</p>}
            </div>
          )}
          {tab === 'views' && (
            <div className="stories">
              {views.slice(0, 6).map((v) => (
                <button key={v.id} className="story-card" onClick={() => p.onOpenView(v.id)}>
                  <small>Saved view · Library</small>
                  <b>{v.name}</b>
                  <span className="story-line">{viewLine(v)}</span>
                  <span className="link-go">Open view ›</span>
                </button>
              ))}
              {views.length === 0 && <p className="home-none">No saved views yet. In the Library, search or filter, then choose Save as view to keep it here.</p>}
            </div>
          )}
        </div>
      </section>

      <section className={topics.length > 0 ? '' : 'home-band'}>
        <div className="home-col link-cols">
          <div>
            <b className="link-cols-brand">Groundwork</b>
            <p>Your papers, drafts and highlights stay on this computer, in the Groundwork data folder.</p>
          </div>
          {p.links.map((g) => (
            <div key={g.head}>
              <h3>{g.head}</h3>
              {g.items.map((it) => (
                <button key={it.label} onClick={it.run}>
                  {it.label}
                  {it.keys && <kbd>{it.keys}</kbd>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
