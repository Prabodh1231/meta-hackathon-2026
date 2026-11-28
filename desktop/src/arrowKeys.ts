import type { KeyboardEvent } from 'react'

/** Arrow keys for a row of tabs or of radio buttons, as the platform's own controls work: ← and →
 * (and ↑ ↓ in a radio group) step to the neighbouring choice and pick it, Home and End jump to the
 * first and last. Put it on the element with role="tablist" or role="radiogroup", and give only the
 * picked choice tabIndex 0 (`stop`), so the row is one stop for Tab and the arrows move inside it. */
export function arrowKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const radio = e.currentTarget.getAttribute('role') === 'radiogroup'
  const steps: Record<string, number | 'first' | 'last'> = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' }
  if (radio) Object.assign(steps, { ArrowDown: 1, ArrowUp: -1 })
  const step = steps[e.key]
  if (step === undefined) return
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"], [role="radio"]')].filter((b) => !b.disabled)
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  if (at < 0) return
  const n = items.length
  const next = items[step === 'first' ? 0 : step === 'last' ? n - 1 : (at + step + n) % n]
  e.preventDefault()
  e.stopPropagation()
  next.focus()
  if (next.getAttribute('aria-selected') !== 'true' && next.getAttribute('aria-checked') !== 'true') next.click()
}

/** tabIndex for choice `i` of a row: 0 for the picked one (or the first, when none is), else -1. */
export function stop(picked: boolean, i: number, anyPicked: boolean): 0 | -1 {
  return picked || (!anyPicked && i === 0) ? 0 : -1
}
