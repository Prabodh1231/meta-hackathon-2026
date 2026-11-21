import cytoscape, { type Core } from 'cytoscape'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { WaitStatus } from './WaitStatus'
import { TrustBadges } from './TrustBadges'
import type { CitationGraph, GraphNode } from '../types'

interface Props {
  /** The topic typed in the app bar's search box. */
  query: string
  /** Put a topic in the app bar's search box (a topic picked on the start page), or clear it. */
  onSearch: (topic: string) => void
  /** The library's largest topics, offered on the start page. */
  topics: { name: string; count: number }[]
  /** Whether the start page is showing: the app bar's search box is then the place to type. */
  onStartPage?: (showing: boolean) => void
  /** Papers ticked in the Library: one thing the network can show. */
  ticked: Set<number>
  librarySize: number
  onOpenPaper: (docId: number) => void
  onCitedPapers: (docId: number) => void
  onFindMissing: (topic: string) => void
  onError: (message: string) => void
}

/** What the network shows. Nothing is drawn until one is chosen: laying out a whole library at
 *  once can keep the window busy for a long time. */
type Scope = { kind: 'topic'; topic: string } | { kind: 'ticked'; ids: number[] } | { kind: 'all' }
const LARGE = 60 // a whole library bigger than this gets a warning before it's drawn
const HUBS = 10 // papers named on the graph without pointing at them: the most connected


function byline(n: GraphNode): string {
  return [n.authors[0], n.year].filter(Boolean).join(' ')
}

/** The library as a network: papers, who cites whom, who shares references, and the works
 *  several papers cite that the library lacks. */
export function NetworkView({ query, onSearch, topics, onStartPage, ticked, librarySize, onOpenPaper, onCitedPapers, onFindMissing, onError }: Props) {
  const [graph, setGraph] = useState<CitationGraph | null>(null)
  const [showShared, setShowShared] = useState(false) // citation links only, until the reader asks for more
  const [showMissing, setShowMissing] = useState(false) // listed beside the graph; drawn on request
  const [showKeywords, setShowKeywords] = useState(false)
  const [view, setView] = useState<'graph' | 'list'>('graph') // the list: the same papers as a table, for keyboard and screen readers
  const [since, setSince] = useState(0) // when the map was asked for, for the wait line
  const [drawing, setDrawing] = useState(false) // laying the graph out (it holds the window while it runs)
  const [scope, setScope] = useState<Scope | null>(query.trim() ? { kind: 'topic', topic: query.trim() } : null)
  const [picked, setPicked] = useState<string | null>(null)
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)
  const [link, setLink] = useState<{ source: string; target: string; kind: 'cites' | 'coupled' | 'keyword' } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const cy = useRef<Core | null>(null)
  // Where each node was, so turning a layer on or off doesn't scatter the map you were reading.
  const placed = useRef(new Map<string, { x: number; y: number }>())
  const topic = scope?.kind === 'topic' ? scope.topic : ''

  useEffect(() => {
    setGraph(null)
    setPicked(null)
    setLink(null)
    placed.current = new Map() // a new map is laid out afresh
    if (!scope) return
    setSince(Date.now())
    let current = true
    api.graph(topic, scope.kind === 'ticked' ? scope.ids : undefined)
      .then((g) => current && setGraph(g))
      .catch((e) => onError(`Could not build the network: ${e instanceof Error ? e.message : e}`))
    return () => { current = false }
  }, [scope, onError]) // eslint-disable-line react-hooks/exhaustive-deps

  // The start page has no search box of its own: it points at the app bar's, which App highlights.
  useEffect(() => {
    onStartPage?.(!scope)
  }, [scope]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onStartPage?.(false), []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Back to the start page: the topic leaves the app bar's search box too. */
  function clearScope() {
    setScope(null)
    if (query) onSearch('')
  }

  // The app bar's search box maps a topic; clearing it goes back to choosing.
  useEffect(() => {
    const t = setTimeout(() => {
      const q = query.trim()
      if (q) setScope((s) => (s?.kind === 'topic' && s.topic === q ? s : { kind: 'topic', topic: q }))
      else setScope((s) => (s?.kind === 'topic' ? null : s))
    }, 350) // wait for the typing to pause
    return () => clearTimeout(t)
  }, [query])

  const nodes = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph])

  useEffect(() => {
    if (!graph || !box.current) return
    // The canvas is a night panel in both themes (design.css), so the colours are read from it, not the page.
    const css = (name: string) => getComputedStyle(box.current ?? document.documentElement).getPropertyValue(name).trim()
    const accent = css('--accent'), muted = css('--muted'), border = css('--border'), text = css('--text'), panel = css('--panel')
    const shown = graph.nodes.filter((n) => n.kind === 'paper' || showMissing)
    const ids = new Set(shown.map((n) => n.id))
    // Names are author and year. Papers by the same author in the same year are told apart as a reference
    // list does (Jariyapan 2022a, 2022b): the start of the title made names long enough to cover each other.
    const baseLabel = (n: GraphNode) => (n.authors[0] ? `${n.authors[0].split(' ').pop()} ${n.year ?? ''}`.trim() : n.title.slice(0, 18))
    const sameName = new Map<string, string[]>()
    for (const n of shown) sameName.set(baseLabel(n), [...(sameName.get(baseLabel(n)) ?? []), n.id])
    const labelFor = (n: GraphNode) => {
      const base = baseLabel(n)
      const same = sameName.get(base) ?? []
      if (same.length < 2) return base
      if (n.year) return `${base}${String.fromCharCode(97 + Math.min(25, same.indexOf(n.id)))}`
      const title = n.title.replace(/\s+/g, ' ').trim()
      return title ? `${base} · ${title.slice(0, 20)}${title.length > 20 ? '…' : ''}` : base
    }
    const hubs = new Set(
      [...shown].filter((n) => n.cites + n.cited_by > 0).sort((a, b) => b.cites + b.cited_by - (a.cites + a.cited_by)).slice(0, HUBS).map((n) => n.id),
    )
    const elements: cytoscape.ElementDefinition[] = [
      ...shown.map((n) => ({
        position: placed.current.get(n.id),
        data: { id: n.id, label: labelFor(n), kind: n.kind, hub: hubs.has(n.id), links: n.cites + n.cited_by, size: Math.min(54, 14 + 4.5 * Math.sqrt(n.cites + n.cited_by)) /* capped: one hub can't cover its neighbours */, isolated: n.kind === 'paper' && n.doc_id !== undefined && graph.isolated.includes(n.doc_id) }
      })),
      ...graph.citations
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e, i) => ({ data: { id: `c${i}`, source: e.source, target: e.target, kind: 'cites' } })),
      ...(showKeywords
        ? (graph.keyword ?? []).map((e, i) => ({ data: { id: `k${i}`, source: e.source, target: e.target, kind: 'keyword', weight: e.weight } }))
        : []),
      ...(showShared
        ? graph.coupling.filter((e) => e.weight >= 2).map((e, i) => ({ data: { id: `s${i}`, source: e.source, target: e.target, kind: 'coupled', weight: e.weight } }))
        : []),
    ]
    if (cy.current) cy.current.nodes().forEach((n) => void placed.current.set(n.id(), { ...n.position() }))
    const keep = shown.length > 0 && shown.every((n) => placed.current.has(n.id))
    const some = shown.some((n) => placed.current.has(n.id))
    const viewport = cy.current ? { zoom: cy.current.zoom(), pan: { ...cy.current.pan() } } : null // kept with the positions
    cy.current?.destroy()
    cy.current = null
    const iterations = shown.length > 150 ? 500 : shown.length > 80 ? 900 : 1500
    if (!keep) setDrawing(true)
    let c: Core | null = null
    // Laying out runs in one go and holds the window; give the "Laying out…" note a frame to show first.
    const timer = window.setTimeout(() => {
    c = cytoscape({
      container: box.current,
      elements,
      minZoom: 0.2,
      maxZoom: 3,
      style: [
        { selector: 'node', style: { width: 'data(size)', height: 'data(size)', 'background-color': accent, label: '', color: text, 'font-size': 11, 'text-valign': 'bottom', 'text-margin-y': 4, 'text-outline-color': panel, 'text-outline-width': 2.5 } },
        // Names on a pale plate, drawn above other nodes, so a neighbour never hides them.
        { selector: 'node[?hub]', style: { 'background-color': css('--ember') } },
        { selector: 'node[?hub], node.named', style: { label: 'data(label)', 'z-index': 10, 'text-background-color': panel, 'text-background-opacity': 0.85, 'text-background-padding': '2px', 'text-background-shape': 'roundrectangle', 'text-outline-width': 0 } },
        { selector: 'node[?hub]', style: { 'font-weight': 600, 'font-size': 12 } },
        // A most-linked paper whose name would cover another's waits for the pointer (see quietLabels);
        // pointing at it, or picking it or a neighbour, names it again.
        { selector: 'node.quiet', style: { label: '' } },
        { selector: 'node.named', style: { label: 'data(label)' } },
        { selector: 'node[kind = "missing"]', style: { 'background-color': css('--pending-bg'), 'border-width': 2, 'border-color': text, 'border-style': 'dashed', color: muted, 'font-style': 'italic' } },
        { selector: 'node[?isolated]', style: { 'background-color': border, 'border-width': 1, 'border-color': muted } },
        { selector: 'edge[kind = "cites"]', style: { width: 1.6, 'line-color': accent, 'target-arrow-color': accent, 'target-arrow-shape': 'triangle', 'arrow-scale': 1.7, 'target-distance-from-node': 2, 'curve-style': 'bezier', opacity: 0.9 } },
        { selector: 'edge[kind = "coupled"]', style: { width: 'mapData(weight, 2, 20, 0.6, 3)', 'line-color': muted, 'curve-style': 'haystack', opacity: 0.35 } },
        { selector: 'edge:selected', style: { opacity: 1, 'line-color': css('--warn'), 'target-arrow-color': css('--warn'), width: 3 } },
        { selector: 'edge[kind = "keyword"]', style: { width: 'mapData(weight, 1, 6, 1, 3.5)', 'line-color': css('--warn'), 'line-style': 'dashed', 'curve-style': 'haystack', opacity: 0.6 } },
        { selector: '.faded', style: { opacity: 0.08 } },
        { selector: 'node.faded', style: { label: '' } },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': css('--warn'), 'border-style': 'solid' } },
      ],
      // More room between nodes than before, so the named ones' labels rarely run into each other.
      layout: (keep
        ? { name: 'preset', fit: false } // every node has its place: just redraw the lines
        : { name: 'cose', animate: false, randomize: !some, nodeRepulsion: () => 16000, idealEdgeLength: () => 95, nodeOverlap: 24, componentSpacing: 80, gravity: 0.3, numIter: some ? 400 : iterations, padding: 40 }) as cytoscape.LayoutOptions,
    })
    if (keep && viewport) c.viewport(viewport)
    if (!c) return
    quietLabels(c)
    c.on('dragfree', 'node', () => c && quietLabels(c))
    c.on('tap', 'node', (ev) => (setLink(null), setPicked(ev.target.id())))
    c.on('tap', (ev) => { if (ev.target === c) (setPicked(null), setLink(null)) })
    // A line says why its two papers are linked, in the side panel.
    c.on('tap', 'edge', (ev) => {
      setPicked(null)
      setLink({ source: ev.target.data('source'), target: ev.target.data('target'), kind: ev.target.data('kind') })
    })
    c.on('mouseover', 'edge', () => (box.current!.style.cursor = 'pointer'))
    c.on('mouseout', 'edge', () => (box.current!.style.cursor = ''))
    // Pointing at a paper names it and shows its title in a card beside the pointer.
    c.on('mouseover', 'node', (ev) => {
      ev.target.addClass('named')
      const at = ev.target.renderedPosition()
      setHover({ id: ev.target.id(), x: at.x, y: at.y + ev.target.renderedHeight() / 2 })
    })
    c.on('mouseout', 'node', (ev) => {
      if (!ev.target.selected()) ev.target.removeClass('named')
      setHover(null)
    })
    c.on('pan zoom', () => setHover(null))
    cy.current = c
    setDrawing(false)
    }, keep ? 0 : 40)
    return () => { window.clearTimeout(timer); c?.destroy(); cy.current = null }
  }, [graph, showShared, showMissing, showKeywords])

  // The graph's box was hidden while the list showed: let cytoscape measure it again.
  useEffect(() => {
    if (view === 'graph') cy.current?.resize()
  }, [view])

  useEffect(() => {
    const c = cy.current
    if (!c) return
    c.elements().removeClass('faded')
    c.nodes().removeClass('named')
    c.nodes().unselect()
    if (!picked) return
    const node = c.getElementById(picked)
    if (node.empty()) return
    node.select()
    node.closedNeighborhood().nodes().addClass('named') // the picked paper and its neighbours, by name
    c.elements().not(node.closedNeighborhood()).addClass('faded')
  }, [picked, graph, showShared, showMissing, showKeywords])

  const node = picked ? nodes.get(picked) : undefined
  const links = useMemo(() => {
    if (!graph || !node) return { cites: [] as GraphNode[], citedBy: [] as GraphNode[], coupled: [] as { node: GraphNode; weight: number }[], keyword: [] as { node: GraphNode; note: string }[] }
    const pick = (ids: string[]) => ids.map((i) => nodes.get(i)).filter((n): n is GraphNode => !!n)
    return {
      cites: pick(graph.citations.filter((e) => e.source === node.id).map((e) => e.target)),
      citedBy: pick(graph.citations.filter((e) => e.target === node.id).map((e) => e.source)),
      coupled: graph.coupling
        .filter((e) => e.source === node.id || e.target === node.id)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 6)
        .flatMap((e) => { const other = nodes.get(e.source === node.id ? e.target : e.source); return other ? [{ node: other, weight: e.weight }] : [] }),
      keyword: (graph.keyword ?? [])
        .filter((e) => e.source === node.id || e.target === node.id)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 8)
        .flatMap((e) => { const other = nodes.get(e.source === node.id ? e.target : e.source); return other ? [{ node: other, note: e.shared.slice(0, 3).join(', ') }] : [] }),
    }
  }, [graph, node, nodes])

  const papers = graph?.nodes.filter((n) => n.kind === 'paper').length ?? 0
  const noList = graph?.nodes.filter((n) => n.kind === 'paper' && !n.parsed).length ?? 0
  /** Arrow keys on the graph move between papers, as clicking a node does. */
  const cyclePaper = (dir: 1 | -1) => {
    const ids = (graph?.nodes ?? []).filter((n) => n.kind === 'paper').map((n) => n.id)
    if (!ids.length) return
    const at = ids.indexOf(picked ?? '')
    setPicked(ids[at < 0 ? (dir === 1 ? 0 : ids.length - 1) : (at + dir + ids.length) % ids.length])
  }

  const what = !scope ? '' : scope.kind === 'topic' ? `about “${topic}”` : scope.kind === 'ticked' ? 'you are drafting from' : 'in your library'

  if (!scope) {
    return (
      <div className="network" aria-label="Citation network">
        <header className="network-head">
          <h2>Citation network</h2>
        </header>
        <div className="network-start">
          <h3>What should the network show?</h3>
          <p className="muted">
            Who cites whom, which papers share references, and the works several of them cite that you don't have. Start from a
            topic or from papers you picked: drawing a whole library at once can take a long time.
          </p>
          {/* One search box: the app bar's (highlighted while this page shows), not a second one here. */}
          <p className="network-pointer">
            <span aria-hidden="true">↑</span> Type a topic in the search box above to map the papers about it, e.g. “bitcoin” or “financial inclusion”.
          </p>
          {topics.length > 0 && (
            <div className="network-topics-wrap">
              <p className="muted">Or start from one of your topics:</p>
              <div className="network-topics">
                {topics.slice(0, 9).map((t) => (
                  <button key={t.name} onClick={() => onSearch(t.name)} title={`Map the papers about ${t.name}`}>
                    {t.name} <span>{t.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="network-start-row">
            <button disabled={ticked.size === 0} onClick={() => setScope({ kind: 'ticked', ids: [...ticked] })}>
              Map the {ticked.size || ''} paper{ticked.size === 1 ? '' : 's'} you're drafting from
            </button>
            {ticked.size === 0 && <span className="muted">In the Library, select papers and choose Use for drafting to map just those.</span>}
          </div>
          <div className="network-start-row">
            <button className="network-all" onClick={() => setScope({ kind: 'all' })} disabled={librarySize === 0} aria-describedby="network-all-note">
              Map the whole library ({librarySize} paper{librarySize === 1 ? '' : 's'})
            </button>
            <span id="network-all-note" className="muted">
              Draws every paper at once.{librarySize > LARGE ? ` With ${librarySize} papers, laying it out may take a while; a busy note shows while it draws.` : ''}
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="network" aria-label="Citation network">
      {/* One row: what's mapped as a chip (× maps something else), short counts, and short layer toggles. */}
      <header className="network-head">
        <h2>Citation network</h2>
        <span className="network-scope">
          {scope.kind === 'topic' ? topic : scope.kind === 'ticked' ? 'Papers you’re drafting from' : 'Whole library'}
          <button className="icon" onClick={clearScope} aria-label="Map something else" title="Map a topic, the papers you're drafting from, or the whole library instead">
            ×
          </button>
        </span>
        {graph && (() => {
          const cites = graph.citations.filter((e) => e.target.startsWith('doc:')).length
          const pairs = graph.coupling.filter((e) => e.weight >= 2).length
          return (
            <span className="network-count" title={`${papers} paper${papers === 1 ? '' : 's'} ${what} · ${cites} citations among them · ${pairs} pairs share 2+ references`}>
              {papers} paper{papers === 1 ? '' : 's'} · {cites} citation{cites === 1 ? '' : 's'}
            </span>
          )
        })()}
        <div className="spacer" />
        <div className="network-view-switch" role="group" aria-label="Show the papers as">
          <button aria-pressed={view === 'graph'} className={view === 'graph' ? 'on' : ''} onClick={() => setView('graph')}>
            Graph
          </button>
          <button aria-pressed={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="The same papers as a table you can sort and use with the keyboard">
            List
          </button>
        </div>
        {view === 'graph' && (
          <div className="network-layers" role="group" aria-label="Also draw">
            <button aria-pressed={showKeywords} className={showKeywords ? 'on' : ''} onClick={() => setShowKeywords((v) => !v)} title="Dashed lines between papers that share keywords">
              Keywords
            </button>
            <button aria-pressed={showShared} className={showShared ? 'on' : ''} onClick={() => setShowShared((v) => !v)} title="Lines between papers that share two or more references">
              References
            </button>
            <button aria-pressed={showMissing} className={showMissing ? 'on' : ''} onClick={() => setShowMissing((v) => !v)} title="Works several of these papers cite that aren't in your library">
              Missing works
            </button>
          </div>
        )}
      </header>
      <div className="network-body">
        {view === 'list' && graph && <NetworkTable graph={graph} picked={picked} onPick={(id) => (setLink(null), setPicked(id))} />}
        <div className="network-canvas" hidden={view === 'list' && !!graph}>
          <div
            className="network-cy"
            ref={box}
            tabIndex={0}
            role="application"
            aria-roledescription="citation graph"
            aria-label="Citation graph. Use the arrow keys to move between papers; each one is shown beside the graph. The List view is the accessible equivalent, with the same papers in a sortable table."
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                cyclePaper(1)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                cyclePaper(-1)
              } else if (e.key === 'Enter' && node?.kind === 'paper' && node.doc_id !== undefined) {
                e.preventDefault()
                onOpenPaper(node.doc_id)
              }
            }}
          />
          {!graph && (
            <div className="network-wait">
              <WaitStatus
                label={`Reading the reference lists of the papers ${what}…`}
                startedAt={since}
                usual="A few seconds for a topic; longer for the whole library."
                onCancel={clearScope}
                cancelTitle="Stop and choose something else to map"
              />
            </div>
          )}
          {graph && drawing && (
            <div className="network-note network-drawing" role="status" aria-live="polite">
              <span className="wait-spin" aria-hidden="true" />
              <span>Drawing the graph: laying out {papers} papers… Citation links are drawn first; List shows the same papers as a table.</span>
            </div>
          )}
          {graph && (
            <div className="network-zoom" role="group" aria-label="Zoom the graph">
              <button className="icon" onClick={() => cy.current?.zoom({ level: cy.current.zoom() * 1.25, renderedPosition: center(cy.current) })} aria-label="Zoom in" title="Zoom in (or scroll)">
                +
              </button>
              <button className="icon" onClick={() => cy.current?.zoom({ level: cy.current.zoom() / 1.25, renderedPosition: center(cy.current) })} aria-label="Zoom out" title="Zoom out (or scroll)">
                −
              </button>
              <button className="network-fit" onClick={() => cy.current?.fit(undefined, 30)} title="Show the whole graph">
                Fit
              </button>
            </div>
          )}
          {hover && nodes.get(hover.id) && (
            <div className="network-hover" style={{ left: hover.x, top: hover.y + 6 }} role="tooltip">
              <b>{nodes.get(hover.id)!.title}</b>
              <span>
                {byline(nodes.get(hover.id)!)}
                {nodes.get(hover.id)!.kind === 'missing' ? ' · not in your library' : ''} · cited by {nodes.get(hover.id)!.cited_by}
              </span>
            </div>
          )}
          <div className="network-legend" aria-label="How to read the lines">
            <span><svg width="38" height="12" aria-hidden="true"><line x1="1" y1="6" x2="27" y2="6" stroke="currentColor" strokeWidth="1.6" /><polygon points="26,1.5 36,6 26,10.5" fill="currentColor" /></svg> A → B: A cites B</span>
            {showShared && <span><svg width="38" height="12" aria-hidden="true"><line x1="1" y1="6" x2="37" y2="6" stroke="var(--muted)" strokeWidth="2" opacity="0.6" /></svg> share references</span>}
            {showKeywords && <span><svg width="38" height="12" aria-hidden="true"><line x1="1" y1="6" x2="37" y2="6" stroke="var(--warn)" strokeWidth="2" strokeDasharray="4 3" /></svg> share keywords</span>}
            <span><svg width="38" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="currentColor" /><circle cx="26" cy="7" r="4" fill="currentColor" /></svg> your papers; bigger = more links</span>
            {showMissing && <span><svg width="38" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="var(--pending-bg)" stroke="var(--text)" strokeDasharray="2 1.5" /></svg> cited, but not in your library</span>}
            <span className="network-legend-tip">The {HUBS} most-linked papers are orange and named, unless a name would cover another; point at any paper to see its name.</span>
            <span className="network-legend-tip">Keyboard: Tab to the graph, then arrow keys move between papers and Enter opens one. List is the accessible equivalent: the same papers in a sortable table.</span>
          </div>
        </div>
        <aside className="network-side">
          {link && graph ? (
            <LinkWhy link={link} graph={graph} nodes={nodes} onPick={(id) => (setLink(null), setPicked(id))} onClose={() => setLink(null)} />
          ) : node ? (
            <>
              <h3>{node.title}</h3>
              <p className="muted">{byline(node)}{node.kind === 'missing' ? ' · not in your library' : ''}</p>
              <TrustBadges doc={node} />
              <p className="muted">{node.kind === 'paper' ? `Cites ${node.cites} shown here · ` : ''}cited by {node.cited_by} paper{node.cited_by === 1 ? '' : 's'} in your library</p>
              {node.match && <p className="muted">Matches “{topic}” through its {node.match.why.join(', ')}{node.match.hits ? ` (${node.match.hits} passages)` : ''}</p>}
              {node.kind === 'paper' && node.doc_id !== undefined && (
                <div className="network-actions">
                  <button onClick={() => onOpenPaper(node.doc_id!)}>Open in library</button>
                  {node.parsed && <button onClick={() => onCitedPapers(node.doc_id!)}>Get cited papers…</button>}
                </div>
              )}
              <NodeList title="Cites" items={links.cites.map((n) => ({ node: n }))} onPick={setPicked} />
              <NodeList title="Cited by" items={links.citedBy.map((n) => ({ node: n }))} onPick={setPicked} />
              <NodeList title="Shares references with" items={links.coupled} onPick={setPicked} />
              <NodeList title="Shares keywords with" items={links.keyword} onPick={setPicked} />
            </>
          ) : (
            <>
              {topic && graph && graph.nodes.length === 0 && <p className="muted">No paper in your library is about “{topic}”.</p>}
              <h3>{scope.kind === 'all' ? `Works you cite but don't have` : `Works these papers cite but you don't have`}</h3>
              <div className="network-actions">
                <button
                  onClick={() => onFindMissing(topic)}
                  disabled={!graph || graph.missing.length === 0}
                  title={!graph ? 'Wait for the map to finish' : graph.missing.length ? 'Every missing work ranked by how many papers cite it, with free copies to download' : 'Nothing to rank: no work is cited by two or more of these papers'}
                >
                  Rank and download…
                </button>
              </div>
              {graph && graph.missing.length === 0 && <p className="muted">No work is cited by two or more papers yet.</p>}
              <NodeList
                title=""
                items={sameWorks(graph?.missing ?? []).slice(0, 25).map(({ node, also }) => ({ node, note: also.length ? `also cited as ${also.join(', ')}` : undefined }))}
                onPick={setPicked}
                badge={(n) => `${n.cited_by} papers`}
              />
              {noList > 0 && <p className="muted network-foot">{noList} paper{noList === 1 ? '' : 's'} had no reference list to read.</p>}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

/** One entry per work: reference lists cite the same work under different years or authors ("Nakamoto
 * 2008", "Nakamoto 2019", "Squarepants 2022" for the Bitcoin paper), so works with the same title are
 * listed once, under the most-cited version, naming the others. */
function sameWorks(missing: GraphNode[]): { node: GraphNode; also: string[] }[] {
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const groups = new Map<string, GraphNode[]>()
  for (const n of missing) {
    const k = key(n.title)
    groups.set(k, [...(groups.get(k) ?? []), n])
  }
  return [...groups.values()]
    .map((g) => {
      const [top, ...rest] = [...g].sort((a, b) => b.cited_by - a.cited_by)
      return { node: top, also: rest.map((n) => byline(n)).filter(Boolean) }
    })
    .sort((a, b) => b.node.cited_by - a.node.cited_by)
}

function NodeList({ title, items, onPick, badge }: { title: string; items: { node: GraphNode; weight?: number; note?: string }[]; onPick: (id: string) => void; badge?: (n: GraphNode) => string }) {
  if (items.length === 0) return null
  return (
    <section className="node-list">
      {title && <h4>{title}</h4>}
      <ul>
        {items.map(({ node, weight, note }) => (
          <li key={node.id}>
            <button onClick={() => onPick(node.id)}>
              <span className="node-title">{node.title}</span>
              <span className="muted">{[byline(node), badge?.(node), note, weight ? `${weight} shared` : ''].filter(Boolean).join(' · ')}</span>
              <TrustBadges doc={node} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Of the named (most-linked) papers, the most linked keep their names; one whose name would land on a
 * name already kept is left for the pointer. Label boxes are in the graph's own units, so zooming
 * doesn't change which overlap: this runs after each layout and after a paper is dragged. */
function quietLabels(c: cytoscape.Core) {
  c.nodes().removeClass('quiet')
  const kept: cytoscape.BoundingBox12[] = []
  const hubs = c.nodes('[?hub]').toArray().sort((a, b) => (b.data('links') ?? 0) - (a.data('links') ?? 0))
  for (const n of hubs) {
    const b = n.boundingBox({ includeNodes: false, includeEdges: false, includeLabels: true, includeOverlays: false })
    if (!(b.w > 0)) continue
    if (kept.some((k) => k.x1 < b.x2 && b.x1 < k.x2 && k.y1 < b.y2 && b.y1 < k.y2)) n.addClass('quiet')
    else kept.push(b)
  }
}

/** The middle of the graph's box, for the zoom buttons. */
function center(c: cytoscape.Core) {
  return { x: c.width() / 2, y: c.height() / 2 }
}

/** Why two papers are joined: what one cites of the other, the works both cite (as far as this map
 * shows them: works cited by two or more of the mapped papers), or the keywords they share. */
function LinkWhy({ link, graph, nodes, onPick, onClose }: {
  link: { source: string; target: string; kind: 'cites' | 'coupled' | 'keyword' }
  graph: CitationGraph
  nodes: Map<string, GraphNode>
  onPick: (id: string) => void
  onClose: () => void
}) {
  const a = nodes.get(link.source)
  const b = nodes.get(link.target)
  if (!a || !b) return null
  const citedBy = (id: string) => new Set(graph.citations.filter((e) => e.source === id).map((e) => e.target))
  const both = [...citedBy(a.id)].filter((t) => citedBy(b.id).has(t)).map((t) => nodes.get(t)).filter((n): n is GraphNode => !!n)
  const pair = (graph.coupling ?? []).find((e) => (e.source === a.id && e.target === b.id) || (e.source === b.id && e.target === a.id))
  const words = (graph.keyword ?? []).find((e) => (e.source === a.id && e.target === b.id) || (e.source === b.id && e.target === a.id))?.shared ?? []
  return (
    <div className="network-why">
      <div className="row">
        <h3>Why these two are linked</h3>
        <span className="spacer" />
        <button className="icon" onClick={onClose} aria-label="Close" title="Close">×</button>
      </div>
      <button className="link" onClick={() => onPick(a.id)}>{a.title}</button>
      <p className="muted">{byline(a)}</p>
      <button className="link" onClick={() => onPick(b.id)}>{b.title}</button>
      <p className="muted">{byline(b)}</p>
      {link.kind === 'cites' && <p>The first cites the second.</p>}
      {link.kind === 'coupled' && (
        <>
          <p>
            They share {pair?.weight ?? both.length} reference{(pair?.weight ?? both.length) === 1 ? '' : 's'}: they build on the same work.
            {both.length > 0 && ` ${both.length === (pair?.weight ?? 0) ? 'All' : 'Those'} in this map:`}
          </p>
          <NodeList title="" items={both.map((n) => ({ node: n }))} onPick={onPick} />
        </>
      )}
      {link.kind === 'keyword' && <p>They share the keywords {words.join(', ')}: they write about the same things, cited or not.</p>}
    </div>
  )
}

type SortKey = 'title' | 'year' | 'cites' | 'cited_by' | 'shares'

/** The mapped papers as a table: what the graph shows, readable with a keyboard or screen reader and
 * sortable. Picking a row opens the paper in the side panel, as clicking its node does. */
function NetworkTable({ graph, picked, onPick }: { graph: CitationGraph; picked: string | null; onPick: (id: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cited_by', desc: true })
  const shares = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of graph.coupling) {
      if (e.weight < 2) continue
      m.set(e.source, (m.get(e.source) ?? 0) + 1)
      m.set(e.target, (m.get(e.target) ?? 0) + 1)
    }
    return m
  }, [graph])
  const inMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of graph.citations) if (e.target.startsWith('doc:')) m.set(e.target, (m.get(e.target) ?? 0) + 1)
    return m
  }, [graph])
  const rows = graph.nodes
    .filter((n) => n.kind === 'paper')
    .map((n) => ({ n, shares: shares.get(n.id) ?? 0, citedHere: inMap.get(n.id) ?? 0 }))
  const value = (r: (typeof rows)[number]) =>
    sort.key === 'title' ? r.n.title.toLowerCase() : sort.key === 'year' ? r.n.year ?? 0 : sort.key === 'cites' ? r.n.cites : sort.key === 'cited_by' ? r.citedHere : r.shares
  rows.sort((a, b) => {
    const x = value(a), y = value(b)
    const c = x < y ? -1 : x > y ? 1 : 0
    return sort.desc ? -c : c
  })
  const head = (key: SortKey, label: string, title: string) => (
    <th aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'title' }))} title={title}>
        {label}
        {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  )
  return (
    <div className="network-table-wrap">
      <table className="network-table" aria-label={`${rows.length} mapped papers`}>
        <caption className="sr-only">The accessible equivalent of the graph: the same mapped papers, sortable and usable with a keyboard or screen reader.</caption>
        <thead>
          <tr>
            {head('title', 'Paper', 'Sort by title')}
            {head('year', 'Year', 'Sort by year')}
            {head('cited_by', 'Cited here', 'How many of the mapped papers cite it')}
            {head('cites', 'Cites', 'How many works in the map it cites')}
            {head('shares', 'Shares refs with', 'How many mapped papers share two or more references with it')}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ n, shares: s, citedHere }) => (
            <tr key={n.id} className={picked === n.id ? 'on' : ''} aria-selected={picked === n.id}>
              <td>
                <button className="network-table-title" onClick={() => onPick(n.id)}>
                  {n.title}
                </button>
                <span className="muted">{byline(n)}</span>
                <TrustBadges doc={n} />
              </td>
              <td>{n.year ?? ''}</td>
              <td>{citedHere}</td>
              <td>{n.cites}</td>
              <td>{s}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
