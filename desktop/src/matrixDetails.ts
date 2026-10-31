import type { MatrixColumn, MatrixRow } from './types'

/** Detail columns: the paper's record (from the scholarly indexes and the library) beside the
 *  questions Muse answers. Shown, sorted and filtered here; the backend only supplies the values. */

export type DetailValue = MatrixRow['details'][string]

export const NUMERIC = new Set(['year', 'cited_by_count'])

export const isDetail = (c: MatrixColumn) => c.kind === 'detail'

export function detailColumn(field: string, label: string): MatrixColumn {
  return { key: `@${field}`, kind: 'detail', field, label, instruction: '' }
}

/** A detail as text: lists joined, counts with thousands separators (years without), nothing as ''. */
export function detailText(value: DetailValue, field = ''): string {
  if (value == null) return ''
  if (Array.isArray(value)) return value.join(value.some((v) => v.includes(',')) ? '; ' : ', ')
  if (typeof value === 'number') return field === 'cited_by_count' ? value.toLocaleString() : String(value)
  return value
}

/** Sort: numbers by size, text alphabetically; a paper without the detail goes last either way. */
export type DetailSort = { field: string; dir: 1 | -1 }

export function sortRows(rows: MatrixRow[], sort: DetailSort | null): MatrixRow[] {
  if (!sort) return rows
  const key = (r: MatrixRow) => r.details[sort.field]
  const empty = (v: DetailValue) => v == null || v === '' || (Array.isArray(v) && v.length === 0)
  return [...rows].sort((a, b) => {
    const va = key(a)
    const vb = key(b)
    if (empty(va) || empty(vb)) return empty(va) === empty(vb) ? 0 : empty(va) ? 1 : -1
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : detailText(va).localeCompare(detailText(vb))
    return cmp * sort.dir
  })
}

/** A row filter on one detail: a range for years and citations, "contains" for the rest. */
export type DetailFilter = { field: string; min?: number; max?: number; text?: string }

export function passes(row: MatrixRow, f: DetailFilter): boolean {
  const v = row.details[f.field]
  if (NUMERIC.has(f.field)) {
    if (typeof v !== 'number') return false
    return (f.min == null || v >= f.min) && (f.max == null || v <= f.max)
  }
  return !f.text || detailText(v).toLowerCase().includes(f.text.toLowerCase())
}

/** "Year 2020–", "Cited ≥ 50", "Journal contains finance". */
export function filterText(f: DetailFilter, label: string): string {
  if (NUMERIC.has(f.field)) {
    if (f.field === 'year') return `${label} ${f.min ?? ''}–${f.max ?? ''}`
    if (f.min != null && f.max != null) return `${label} ${f.min}–${f.max}`
    return f.min != null ? `${label} ≥ ${f.min}` : `${label} ≤ ${f.max}`
  }
  return `${label} contains “${f.text}”`
}
