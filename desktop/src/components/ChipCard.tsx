import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { CITATION_WORD, isFlagged } from '../editor/citeStatus'
import type { ChipAttrs } from './WritingEditor'

/** Pointing at a citation in the draft shows what backs it: the verdict, the quote and its page,
 * and why Muse judged it so. Clicking still opens the quote on its page. */
export function ChipCard({ editor }: { editor: Editor | null }) {
  const [card, setCard] = useState<{ a: ChipAttrs; x: number; y: number } | null>(null)

  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    let timer: number | undefined
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('span[data-citation]')
      if (!el) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        let attrs: ChipAttrs | null = null
        editor.state.doc.descendants((node) => {
          if (attrs) return false
          if (node.type.name === 'citation' && node.attrs.cid === el.dataset.cid) attrs = node.attrs as ChipAttrs
        })
        if (!attrs) return
        const r = el.getBoundingClientRect()
        setCard({ a: attrs, x: Math.min(r.left, window.innerWidth - 380), y: r.bottom + 8 })
      }, 250) // a pause, so passing over chips while moving the mouse doesn't flash cards
    }
    const out = (e: MouseEvent) => {
      const from = (e.target as HTMLElement).closest('span[data-citation]')
      const to = (e.relatedTarget as HTMLElement | null)?.closest?.('span[data-citation]')
      if (from && from !== to) {
        window.clearTimeout(timer)
        setCard(null)
      }
    }
    const hide = () => setCard(null)
    dom.addEventListener('mouseover', over)
    dom.addEventListener('mouseout', out)
    dom.addEventListener('keydown', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.clearTimeout(timer)
      dom.removeEventListener('mouseover', over)
      dom.removeEventListener('mouseout', out)
      dom.removeEventListener('keydown', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [editor])

  if (!card) return null
  const { a } = card
  return (
    <div className={`chip-card chip-card-${a.status}`} style={{ left: card.x, top: card.y }} role="tooltip">
      <div className="chip-card-head">
        <span className={`cite cite-${a.status}${a.finding != null ? ' cite-matrix' : ''}`} aria-hidden="true">
          {a.label}
        </span>
        <b className="chip-card-verdict">{CITATION_WORD[a.status]}</b>
      </div>
      {a.quote ? (
        <blockquote>“{a.quote}”</blockquote>
      ) : (
        a.finding != null && <p className="muted">Written from your review matrix, and checked against it.</p>
      )}
      {a.reason && (isFlagged(a.status) || a.status === 'verified') && <p className="chip-card-reason">{a.reason}</p>}
      <p className="chip-card-foot">Click to see it on its page</p>
    </div>
  )
}
