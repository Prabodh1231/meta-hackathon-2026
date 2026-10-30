import { useEffect, useState } from 'react'
import type { CitationStatus } from '../types'

interface Line {
  x1: number
  y1: number
  x2: number
  y2: number
}

const COLORS: Record<CitationStatus, string> = {
  pending: 'var(--pending)',
  verified: 'var(--accent)',
  weak: 'var(--warn)',
  unsupported: 'var(--bad)',
  quote_not_found: 'var(--bad)',
}

/** Draws a dashed wire from the cited chip in the draft to its highlighted quote in the side panel. */
export function CitationWire({ cid, status, active }: { cid: string | undefined; status: CitationStatus; active: boolean }) {
  const [line, setLine] = useState<Line | null>(null)

  useEffect(() => {
    if (!active || !cid) {
      setLine(null)
      return
    }
    let raf = 0
    let lastKey = ''
    let lit: HTMLElement | null = null
    const tick = () => {
      const chip = document.querySelector<HTMLElement>(`.cite[data-cid="${CSS.escape(cid)}"]`)
      const mark = document.querySelector<HTMLElement>('.side-panel .page-text mark, .side-panel .pdf-hit')
      const pane = document.querySelector<HTMLElement>('.side-panel .tab-body')
      if (chip !== lit) {
        lit?.classList.remove('cite-active')
        lit = chip
      }
      chip?.classList.add('cite-active')
      let next: Line | null = null
      if (chip && mark && pane) {
        const a = chip.getBoundingClientRect()
        const b = mark.getBoundingClientRect()
        const p = pane.getBoundingClientRect()
        if (b.width > 0 && b.top >= p.top && b.bottom <= p.bottom && a.bottom > 50 && a.top < window.innerHeight - 40) {
          next = { x1: a.right, y1: a.top + a.height / 2, x2: b.left - 4, y2: b.top + b.height / 2 }
        }
      }
      const key = next ? `${next.x1 | 0},${next.y1 | 0},${next.x2 | 0},${next.y2 | 0}` : ''
      if (key !== lastKey) {
        lastKey = key
        setLine(next)
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      lit?.classList.remove('cite-active')
    }
  }, [cid, active])

  if (!line) return null
  const mx = (line.x1 + line.x2) / 2
  const color = COLORS[status]
  return (
    <svg className="wire" aria-hidden="true">
      <path stroke={color} d={`M${line.x1} ${line.y1} C ${mx} ${line.y1}, ${mx} ${line.y2}, ${line.x2} ${line.y2}`} />
      <circle cx={line.x1} cy={line.y1} r="3.5" fill={color} />
      <circle cx={line.x2} cy={line.y2} r="3.5" fill={color} />
    </svg>
  )
}
