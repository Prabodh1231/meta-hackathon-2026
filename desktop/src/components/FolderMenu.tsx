import { useLayoutEffect, useRef, useState } from 'react'
import { FOLDER_COLORS, type FolderColor } from '../types'
import type { FrontItem } from './FolderTile'
import { useDismiss } from './libraryParts'

const COLOR_NAME: Record<FolderColor, string> = { rose: 'Rose', gold: 'Gold', violet: 'Violet', sky: 'Sky', slate: 'Slate' }

/** Right-click on a folder of the front page. A topic can be given a colour, renamed or merged into
 * another; a saved view renamed or deleted; every folder opened or peeked into. */
export function FolderMenu({ item, x, y, onClose, onOpen, onPeek, onColor, onRename, onMerge, onDelete, onReadingList }: {
  item: FrontItem
  x: number
  y: number
  onClose: () => void
  onOpen: () => void
  onPeek: () => void
  onColor: (c: FolderColor | '') => void
  onRename: () => void
  onMerge: (x: number, y: number) => void
  onDelete: () => void // a saved view
  onReadingList?: () => void // a topic's papers as a Word reading list
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)), top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)) })
  }, [x, y])
  useLayoutEffect(() => {
    if (pos) ref.current?.querySelector<HTMLElement>('button')?.focus()
  }, [pos !== null]) // eslint-disable-line react-hooks/exhaustive-deps
  useDismiss(true, onClose, ref)
  const act = (fn: () => void) => () => {
    onClose()
    fn()
  }
  const color = item.folder?.color ?? ''
  const move = (dir: 1 | -1) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])]
    const at = all.indexOf(document.activeElement as HTMLElement)
    all[(at + dir + all.length) % all.length]?.focus()
  }
  return (
    <div
      ref={ref}
      className="lib-pop fmenu"
      role="menu"
      style={pos ?? { left: x, top: y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation() // the front page's own keys (Space, arrows) stay out of the menu
        if (e.key === 'Escape') onClose()
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') (e.preventDefault(), move(e.key === 'ArrowDown' ? 1 : -1))
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          if ((document.activeElement as HTMLElement | null)?.closest('.fmenu-swatches')) (e.preventDefault(), move(e.key === 'ArrowRight' ? 1 : -1))
        }
      }}
    >
      <button role="menuitem" onClick={act(onOpen)}>
        <span className="lib-pop-label">Open</span>
        <kbd>Enter</kbd>
      </button>
      <button role="menuitem" onClick={act(onPeek)}>
        <span className="lib-pop-label">Peek inside</span>
        <kbd>Space</kbd>
      </button>
      {item.kind === 'topic' && (
        <>
          <hr />
          <div className="lib-pop-head">Colour</div>
          <div className="fmenu-swatches" role="group" aria-label="Colour">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                role="menuitemradio"
                aria-checked={color === c}
                className={`fmenu-swatch c-${c}${color === c ? ' on' : ''}`}
                title={COLOR_NAME[c]}
                aria-label={COLOR_NAME[c]}
                onClick={act(() => onColor(c))}
              />
            ))}
            <button
              role="menuitemradio"
              aria-checked={color === ''}
              className={`fmenu-swatch none${color === '' ? ' on' : ''}`}
              title="No colour"
              aria-label="No colour"
              onClick={act(() => onColor(''))}
            />
          </div>
        </>
      )}
      {(item.kind === 'topic' || item.saved) && (
        <>
          <hr />
          <button role="menuitem" onClick={act(onRename)}>
            <span className="lib-pop-label">Rename…</span>
          </button>
        </>
      )}
      {item.kind === 'topic' && (
        <button
          role="menuitem"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            onClose()
            onMerge(r.right - 40, r.top)
          }}
        >
          <span className="lib-pop-label">Merge into another topic…</span>
        </button>
      )}
      {item.kind === 'topic' && onReadingList && item.docs.length > 0 && (
        <button role="menuitem" onClick={act(onReadingList)}>
          <span className="lib-pop-label">Export reading list…</span>
        </button>
      )}
      {item.saved && (
        <button role="menuitem" className="danger" onClick={act(onDelete)}>
          <span className="lib-pop-label">Delete view</span>
        </button>
      )}
    </div>
  )
}
