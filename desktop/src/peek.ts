import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react'

/** A side panel that stays out of sight until it's wanted (the sidebar, the writing tools): pointing at
 * the window's edge brings it out over the page, and it goes again a moment after the pointer leaves it,
 * unless the keyboard is inside it (typing in Ask Muse, say). Tabbing into it brings it out too.
 * `edge` goes on the thin strip along the window's edge, `panel` on the panel itself. */
export function usePeek() {
  const [shown, setShown] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const inside = useRef({ pointer: false, focus: false })

  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(fn, ms)
  }
  // Out a moment after the pointer and the keyboard have both left, so a pointer that overshoots the
  // panel's edge and comes back doesn't make it flicker.
  const settle = () => later(() => !inside.current.pointer && !inside.current.focus && setShown(false), 350)

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    inside.current = { pointer: false, focus: false }
    setShown(false)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  return {
    shown,
    hide,
    edge: {
      // A short pause first, so a pointer just passing the edge doesn't pull the panel out
      onPointerEnter: () => later(() => setShown(true), 90),
      onPointerLeave: settle,
    },
    panel: {
      onPointerEnter: () => {
        inside.current.pointer = true
        window.clearTimeout(timer.current)
      },
      onPointerLeave: () => {
        inside.current.pointer = false
        settle()
      },
      // Only the keyboard's focus, or a field being typed in, holds the panel out: a button clicked in it
      // (a draft, a place) also takes focus, and the panel stayed over the page after the pointer left.
      onFocus: (e: FocusEvent<HTMLElement>) => {
        if (!(e.target as HTMLElement).matches(':focus-visible')) return
        inside.current.focus = true
        window.clearTimeout(timer.current)
        setShown(true)
      },
      onBlur: (e: FocusEvent<HTMLElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        inside.current.focus = false
        settle()
      },
    },
  }
}
