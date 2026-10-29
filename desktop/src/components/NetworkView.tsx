import cytoscape, { type Core } from 'cytoscape'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { CitationGraph, GraphNode } from '../types'

interface Props {
  onClose: () => void
  onOpenPaper: (docId: number) => void
  onError: (message: string) => void
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

function byline(n: GraphNode): string {
  return [n.authors[0], n.year].filter(Boolean).join(' ')
}

/** The library as a network: papers, who cites whom, who shares references, and the works
 *  several papers cite that the library lacks. */
export function NetworkView({ onClose, onOpenPaper, onError }: Props) {
  const [graph, setGraph] = useState<CitationGraph | null>(null)
  const [showShared, setShowShared] = useState(true)
  const [showMissing, setShowMissing] = useState(true)
  const [picked, setPicked] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const cy = useRef<Core | null>(null)

  useEffect(() => {
    api.graph().then(setGraph).catch((e) => onError(`Could not build the network: ${e instanceof Error ? e.message : e}`))
  }, [onError])

  const nodes = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph])

  useEffect(() => {
    if (!graph || !box.current) return
    const accent = css('--accent'), muted = css('--muted'), border = css('--border'), text = css('--text'), panel = css('--panel')
    const shown = graph.nodes.filter((n) => n.kind === 'paper' || showMissing)
    const ids = new Set(shown.map((n) => n.id))
    const elements: cytoscape.ElementDefinition[] = [
      ...shown.map((n) => ({
        data: { id: n.id, label: n.authors[0] ? `${n.authors[0].split(' ').pop()} ${n.year ?? ''}`.trim() : n.title.slice(0, 18), kind: n.kind, size: 14 + 5 * Math.sqrt(n.cites + n.cited_by), isolated: n.kind === 'paper' && n.doc_id !== undefined && graph.isolated.includes(n.doc_id) }
      })),
      ...graph.citations
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e, i) => ({ data: { id: `c${i}`, source: e.source, target: e.target, kind: 'cites' } })),
      ...(showShared
        ? graph.coupling.filter((e) => e.weight >= 2).map((e, i) => ({ data: { id: `s${i}`, source: e.source, target: e.target, kind: 'coupled', weight: e.weight } }))
        : []),
    ]
    cy.current?.destroy()
    const c = cytoscape({
      container: box.current,
      elements,
      minZoom: 0.2,
      maxZoom: 3,
      style: [
        { selector: 'node', style: { width: 'data(size)', height: 'data(size)', 'background-color': accent, label: 'data(label)', color: text, 'font-size': 10, 'text-valign': 'bottom', 'text-margin-y': 4, 'text-outline-color': panel, 'text-outline-width': 2 } },
        { selector: 'node[kind = "missing"]', style: { 'background-color': css('--pending-bg'), 'border-width': 2, 'border-color': text, 'border-style': 'dashed', color: muted, 'font-style': 'italic' } },
        { selector: 'node[?isolated]', style: { 'background-color': border, 'border-width': 1, 'border-color': muted } },
        { selector: 'edge[kind = "cites"]', style: { width: 1.4, 'line-color': accent, 'target-arrow-color': accent, 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', opacity: 0.85 } },
        { selector: 'edge[kind = "coupled"]', style: { width: 'mapData(weight, 2, 20, 0.6, 3)', 'line-color': muted, 'curve-style': 'haystack', opacity: 0.35 } },
        { selector: '.faded', style: { opacity: 0.08 } },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': css('--warn'), 'border-style': 'solid' } },
      ],
      layout: { name: 'cose', animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 70, gravity: 0.4, numIter: 1200 } as cytoscape.LayoutOptions,
    })
    c.on('tap', 'node', (ev) => setPicked(ev.target.id()))
    c.on('tap', (ev) => { if (ev.target === c) setPicked(null) })
    cy.current = c
    return () => { c.destroy(); cy.current = null }
  }, [graph, showShared, showMissing])

  useEffect(() => {
    const c = cy.current
    if (!c) return
    c.elements().removeClass('faded')
    c.nodes().unselect()
    if (!picked) return
    const node = c.getElementById(picked)
    if (node.empty()) return
    node.select()
    c.elements().not(node.closedNeighborhood()).addClass('faded')
  }, [picked, graph, showShared, showMissing])

  const node = picked ? nodes.get(picked) : undefined
  const links = useMemo(() => {
    if (!graph || !node) return { cites: [] as GraphNode[], citedBy: [] as GraphNode[], coupled: [] as { node: GraphNode; weight: number }[] }
    const pick = (ids: string[]) => ids.map((i) => nodes.get(i)).filter((n): n is GraphNode => !!n)
    return {
      cites: pick(graph.citations.filter((e) => e.source === node.id).map((e) => e.target)),
      citedBy: pick(graph.citations.filter((e) => e.target === node.id).map((e) => e.source)),
      coupled: graph.coupling
        .filter((e) => e.source === node.id || e.target === node.id)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 6)
        .flatMap((e) => { const other = nodes.get(e.source === node.id ? e.target : e.source); return other ? [{ node: other, weight: e.weight }] : [] }),
    }
  }, [graph, node, nodes])

  const papers = graph?.nodes.filter((n) => n.kind === 'paper').length ?? 0
  const noList = graph?.nodes.filter((n) => n.kind === 'paper' && !n.parsed).length ?? 0

  return (
    <div className="network" role="dialog" aria-label="Citation network">
      <header className="network-head">
        <h2>Citation network</h2>
        {graph && (
          <span className="network-count">
            {papers} papers · {graph.citations.filter((e) => e.target.startsWith('doc:')).length} citations in the library · {graph.coupling.length} pairs share references
          </span>
        )}
        <div className="spacer" />
        <label><input type="checkbox" checked={showShared} onChange={(e) => setShowShared(e.target.checked)} /> Shared references</label>
        <label><input type="checkbox" checked={showMissing} onChange={(e) => setShowMissing(e.target.checked)} /> Missing works</label>
        <button className="drawer-close static" onClick={onClose} aria-label="Close network">×</button>
      </header>
      <div className="network-body">
        <div className="network-canvas" ref={box}>
          {!graph && <p className="network-note">Reading reference lists…</p>}
        </div>
        <aside className="network-side">
          {node ? (
            <>
              <h3>{node.title}</h3>
              <p className="muted">{byline(node)}{node.kind === 'missing' ? ' · not in your library' : ''}</p>
              <p className="muted">{node.kind === 'paper' ? `Cites ${node.cites} shown here · ` : ''}cited by {node.cited_by} paper{node.cited_by === 1 ? '' : 's'} in your library</p>
              {node.kind === 'paper' && node.doc_id !== undefined && (
                <button onClick={() => onOpenPaper(node.doc_id!)}>Open in library</button>
              )}
              <NodeList title="Cites" items={links.cites.map((n) => ({ node: n }))} onPick={setPicked} />
              <NodeList title="Cited by" items={links.citedBy.map((n) => ({ node: n }))} onPick={setPicked} />
              <NodeList title="Shares references with" items={links.coupled} onPick={setPicked} />
            </>
          ) : (
            <>
              <h3>Works you cite but don't have</h3>
              {graph && graph.missing.length === 0 && <p className="muted">No work is cited by two or more papers yet.</p>}
              <NodeList title="" items={(graph?.missing ?? []).slice(0, 25).map((n) => ({ node: n }))} onPick={setPicked} badge={(n) => `${n.cited_by} papers`} />
              {noList > 0 && <p className="muted network-foot">{noList} paper{noList === 1 ? '' : 's'} had no reference list to read.</p>}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

function NodeList({ title, items, onPick, badge }: { title: string; items: { node: GraphNode; weight?: number }[]; onPick: (id: string) => void; badge?: (n: GraphNode) => string }) {
  if (items.length === 0) return null
  return (
    <section className="node-list">
      {title && <h4>{title}</h4>}
      <ul>
        {items.map(({ node, weight }) => (
          <li key={node.id}>
            <button onClick={() => onPick(node.id)}>
              <span className="node-title">{node.title}</span>
              <span className="muted">{[byline(node), badge ? badge(node) : weight ? `${weight} shared` : ''].filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
