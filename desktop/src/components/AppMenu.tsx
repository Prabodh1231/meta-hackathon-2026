import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from './Icon'

interface Props {
  onNewDraft: () => void
  onImportWord: () => void
  onFocus: () => void
  onTools: () => void
  onSettings: () => void
  onShortcuts: () => void
}

/** ☰: the app's own menu, where the window's File / Edit / View bar was (main.cjs removes that bar). It
 * holds what has no button anywhere else (zoom with its size, the data folder, the version), and a few
 * things that do, each with its key, so the keys are easy to find. */
export function AppMenu({ onNewDraft, onImportWord, onFocus, onTools, onSettings, onShortcuts }: Props) {
  const [open, setOpen] = useState(false)
  const [zoom, setZoom] = useState<number | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.rc
      ?.config()
      .then((c) => setVersion(c.version ?? null))
      .catch(() => {})
  }, [])

  // Open: the zoom as it is now, the first item focused; a click anywhere else closes it.
  useEffect(() => {
    if (!open) return
    setZoom(window.rc?.zoomPercent?.() ?? null)
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }
  const run = (fn: () => void) => () => {
    close(false)
    fn()
  }
  // ↑ ↓ move through the items, Home and End to the ends, Esc closes and goes back to ☰, Tab leaves.
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const to = ({ ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 } as Record<string, number>)[e.key]
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') {
      close(false)
    } else if (to !== undefined && items.length) {
      e.preventDefault()
      items[(to + items.length) % items.length].focus()
    }
  }
  const zoomTo = (step: 'in' | 'out' | 'reset') => setZoom(window.rc?.zoom?.(step) ?? null)

  return (
    <div className="app-menu-box" ref={box}>
      <button
        ref={button}
        className="bar-nav-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu"
        title="Menu"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <Icon name="menu" size={18} />
      </button>
      {open && (
        <div className="app-menu" role="menu" aria-label="Groundwork" ref={menu} onKeyDown={keys}>
          <Item onClick={run(onNewDraft)} keys="Ctrl+N">New draft</Item>
          <Item onClick={run(onImportWord)} keys="Ctrl+O">Open a Word file…</Item>
          <div role="separator" />
          {zoom !== null && (
            <div className="app-menu-zoom" role="group" aria-label="Zoom">
              <span>Zoom</span>
              <button role="menuitem" onClick={() => zoomTo('out')} aria-label="Zoom out" title="Zoom out (Ctrl −)">
                −
              </button>
              <button role="menuitem" className="app-menu-pct" onClick={() => zoomTo('reset')} aria-label={`${zoom}%, back to 100%`} title="Back to 100% (Ctrl 0)">
                {zoom}%
              </button>
              <button role="menuitem" onClick={() => zoomTo('in')} aria-label="Zoom in" title="Zoom in (Ctrl +)">
                +
              </button>
            </div>
          )}
          <Item onClick={run(onFocus)} keys="Ctrl+Shift+F">Focus mode</Item>
          <Item onClick={run(onTools)} keys="Ctrl+\">Writing tools</Item>
          <div role="separator" />
          <Item onClick={run(onSettings)}>Settings</Item>
          <Item onClick={run(onShortcuts)} keys="Ctrl+/">Keyboard shortcuts</Item>
          {window.rc?.showDataFolder && (
            <Item onClick={run(() => void window.rc?.showDataFolder?.())} hint="Your library, its backups and the logs">
              Show the data folder
            </Item>
          )}
          {version && <p className="app-menu-foot">Groundwork {version}</p>}
        </div>
      )}
    </div>
  )
}

function Item({ children, keys, hint, onClick }: { children: ReactNode; keys?: string; hint?: string; onClick: () => void }) {
  return (
    <button role="menuitem" className="app-menu-item" onClick={onClick} title={hint}>
      <span>{children}</span>
      {keys && <kbd>{keys}</kbd>}
    </button>
  )
}
