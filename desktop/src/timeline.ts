import type { Doc, RemovedDoc } from './types'

/** The library's date slider: which date it goes by, and a range or a single "as of" date. */
export type TimeField = 'added' | 'published'
export type TimeMode = 'range' | 'asof'
/** `lo` and `hi` are positions on the axis (see Axis); "as of" uses `hi` only. */
export interface TimeWindow {
  field: TimeField
  mode: TimeMode
  lo: number
  hi: number
}

/** Positions are months (year * 12 + month - 1), or whole years when the dates span decades. */
export interface Axis {
  unit: 'month' | 'year'
  start: number
  end: number
}

/** Inclusive range of months: one month, or a whole year when only the year is known. */
export type Span = { from: number; to: number }

const MAX_MONTH_YEARS = 15 // a wider spread of dates is shown year by year
const MIN_MONTH_BINS = 12 // a library added in one month still gets a slider worth moving

/** "YYYY-MM-DD HH:MM:SS" in UTC, as the backend stores dates. */
export function toLocal(utc: string): Date {
  return new Date(utc.replace(' ', 'T') + 'Z')
}

const monthOf = (utc: string) => {
  const d = toLocal(utc)
  return d.getFullYear() * 12 + d.getMonth()
}

/** When the user got it: the file's date on this computer when that's earlier than adding it here. */
export function gotAt(d: { file_date: string | null; added_at: string }): string {
  return d.file_date && d.file_date < d.added_at ? d.file_date : d.added_at
}

export function publishedSpan(d: { published: string; year: number | null }): Span | null {
  const m = /^(\d{4})-(\d{2})/.exec(d.published)
  if (m) {
    const i = Number(m[1]) * 12 + Number(m[2]) - 1
    return { from: i, to: i }
  }
  return d.year ? { from: d.year * 12, to: d.year * 12 + 11 } : null
}

export function docSpan(field: TimeField, d: Doc): Span | null {
  if (field === 'published') return publishedSpan(d)
  const m = monthOf(gotAt(d))
  return { from: m, to: m }
}

export const toUnit = (axis: Axis, month: number) => (axis.unit === 'month' ? month : Math.floor(month / 12))

/** The slider's extent: from the earliest date to the latest (today, for dates added). */
export function buildAxis(field: TimeField, docs: Doc[], removed: RemovedDoc[]): Axis | null {
  const months: number[] = []
  if (field === 'added') {
    for (const d of docs) months.push(monthOf(gotAt(d)))
    for (const r of removed) months.push(monthOf(gotAt(r)), monthOf(r.removed_at))
    if (months.length) {
      const now = new Date()
      months.push(now.getFullYear() * 12 + now.getMonth())
    }
  } else {
    for (const d of docs) {
      const s = publishedSpan(d)
      if (s) months.push(s.from, s.to)
    }
  }
  if (!months.length) return null
  const lo = Math.min(...months)
  const hi = Math.max(...months)
  if (hi - lo > MAX_MONTH_YEARS * 12) return { unit: 'year', start: Math.floor(lo / 12), end: Math.floor(hi / 12) }
  return { unit: 'month', start: Math.min(lo, hi - MIN_MONTH_BINS + 1), end: hi }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Mar 2024", or "2024" on a yearly axis. */
export function posLabel(axis: Axis, i: number): string {
  return axis.unit === 'year' ? String(i) : `${MONTHS[i % 12]} ${Math.floor(i / 12)}`
}

/** Sources per position: dated to the month, and spread evenly over the year for publication
 * dates known only by year (drawn lighter). */
export function histogram(axis: Axis, field: TimeField, docs: Doc[]): { exact: number[]; spread: number[] } {
  const n = axis.end - axis.start + 1
  const exact = new Array<number>(n).fill(0)
  const spread = new Array<number>(n).fill(0)
  for (const d of docs) {
    const s = docSpan(field, d)
    if (!s) continue
    const from = toUnit(axis, s.from) - axis.start
    const to = toUnit(axis, s.to) - axis.start
    if (from === to) exact[from] += 1
    else for (let i = from; i <= to; i++) if (i >= 0 && i < n) spread[i] += 1 / (to - from + 1)
  }
  return { exact, spread }
}

/** In the window: overlaps the range, or was there by the end of the "as of" date. */
export function inWindow(axis: Axis, w: TimeWindow, s: Span): boolean {
  if (w.mode === 'asof') return toUnit(axis, s.from) <= w.hi
  return toUnit(axis, s.to) >= w.lo && toUnit(axis, s.from) <= w.hi
}

/** In the library at the end of the "as of" date, but removed since. */
export function removedSince(axis: Axis, w: TimeWindow, r: RemovedDoc): boolean {
  return toUnit(axis, monthOf(gotAt(r))) <= w.hi && toUnit(axis, monthOf(r.removed_at)) > w.hi
}

/** "3 Oct 2026", in local time. */
export function fmtDay(utc: string): string {
  return toLocal(utc).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "2 Mar 2024" or "Mar 2024" from a publication date. */
export function fmtPublished(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!m) return String(y)
  return new Date(y, m - 1, d || 1).toLocaleDateString(undefined, d ? { day: 'numeric', month: 'short', year: 'numeric' } : { month: 'short', year: 'numeric' })
}
