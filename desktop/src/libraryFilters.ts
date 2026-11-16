import type { Doc } from './types'

/** The Year chip's choices: the last few years (counted from this year, so a saved view stays
 * current), one decade, everything before a year, or papers with no year in their record. */
export type YearFilter = { last: number } | { decade: number } | { before: number } | 'none'

/** The filter chips above the library's list. Within one chip the choices add up (PDFs or slides);
 * across chips they narrow (PDFs, and from 2020 on, and by Suri). */
export interface Filters {
  kinds: Doc['kind'][]
  year: YearFilter | null
  topics: number[] // topic (folder) ids
  authors: string[] // authorKey values
  venues: string[] // venueKey values
  highlighted: boolean // only papers the reader has highlighted in
}

export const NO_FILTERS: Filters = { kinds: [], year: null, topics: [], authors: [], venues: [], highlighted: false }

/** A search and filters kept in the sidebar. It stores the question, not the answer: the papers
 * that match are worked out each time, so it stays current as papers arrive. */
export interface SavedView {
  id: string
  name: string
  scope: string | number // the ready-made view or topic it was saved in
  query: string
  filters: Filters
}

/** What a filter needs to know of a source: a paper in the library, or a removed one's record. */
export interface Filterable {
  kind: Doc['kind']
  authors: string[]
  year: number | null
  venue: string
  folderIds?: number[] // unknown for a removed source: a topic filter leaves it out
  highlights?: number
}

export const filterable = (d: Doc): Filterable => ({
  kind: d.kind, authors: d.authors, year: d.year, venue: d.venue, folderIds: d.folders.map((f) => f.id), highlights: d.highlights,
})

/** One person however the paper prints the name: "Tavneet Suri", "Suri, Tavneet" and "T. Suri"
 * are all "suri t". */
export function authorKey(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ')
  const [surname, given] = n.includes(',') ? n.split(',').map((p) => p.trim()) : [n.split(' ').pop() ?? n, n.split(' ').slice(0, -1).join(' ')]
  return `${surname.toLowerCase()} ${(given[0] ?? '').toLowerCase()}`.trim()
}
export const venueKey = (venue: string) => venue.trim().toLowerCase()

export const filtersActive = (f: Filters) =>
  f.kinds.length > 0 || f.year !== null || f.topics.length > 0 || f.authors.length > 0 || f.venues.length > 0 || f.highlighted

export function yearMatches(year: number | null, f: YearFilter, thisYear: number): boolean {
  const y = year && year > 0 ? year : null
  if (f === 'none') return y === null
  if (y === null) return false
  if ('last' in f) return y > thisYear - f.last
  if ('decade' in f) return y >= f.decade && y < f.decade + 10
  return y < f.before
}

export function yearLabel(f: YearFilter): string {
  if (f === 'none') return 'No year'
  if ('last' in f) return `Last ${f.last} years`
  if ('decade' in f) return `${f.decade}s`
  return `Before ${f.before}`
}

export function matches(s: Filterable, f: Filters, thisYear: number): boolean {
  if (f.kinds.length && !f.kinds.includes(s.kind)) return false
  if (f.year !== null && !yearMatches(s.year, f.year, thisYear)) return false
  if (f.topics.length && !f.topics.some((id) => s.folderIds?.includes(id))) return false
  if (f.authors.length && !s.authors.some((a) => f.authors.includes(authorKey(a)))) return false
  if (f.venues.length && !f.venues.includes(venueKey(s.venue))) return false
  if (f.highlighted && !s.highlights) return false
  return true
}

export interface Choice<T> {
  value: T
  label: string
  count: number
}

const byCount = <T,>(a: Choice<T>, b: Choice<T>) => b.count - a.count || a.label.localeCompare(b.label)

/** Every author in the library, the one with the most papers first, under the fullest form of the name. */
export function authorChoices(docs: Doc[]): Choice<string>[] {
  const found = new Map<string, Choice<string>>()
  for (const d of docs) {
    for (const key of new Set(d.authors.map(authorKey))) {
      if (!key) continue
      const name = d.authors.find((a) => authorKey(a) === key)!.trim()
      const c = found.get(key) ?? found.set(key, { value: key, label: name, count: 0 }).get(key)!
      c.count++
      if (name.length > c.label.length) c.label = name
    }
  }
  return [...found.values()].sort(byCount)
}

/** Every journal (or other venue) in the library, the one with the most papers first. */
export function venueChoices(docs: Doc[]): Choice<string>[] {
  const found = new Map<string, Choice<string>>()
  for (const d of docs) {
    const key = venueKey(d.venue)
    if (!key) continue
    const c = found.get(key) ?? found.set(key, { value: key, label: d.venue.trim(), count: 0 }).get(key)!
    c.count++
  }
  return [...found.values()].sort(byCount)
}

/** The Year chip's choices that have papers: recent spans first, then each decade, newest first. */
export function yearChoices(docs: Doc[], thisYear: number): Choice<YearFilter>[] {
  const count = (f: YearFilter) => docs.filter((d) => yearMatches(d.year, f, thisYear)).length
  const years = docs.map((d) => d.year ?? 0).filter((y) => y > 0)
  const decades = [...new Set(years.map((y) => Math.floor(y / 10) * 10))].sort((a, b) => b - a)
  // Decades from 2000 on are listed one by one; everything older is one choice.
  const all: YearFilter[] = [{ last: 5 }, { last: 10 }, ...decades.filter((d) => d >= 2000).map((decade) => ({ decade })), { before: 2000 }, 'none']
  return all.map((value) => ({ value, label: yearLabel(value), count: count(value) })).filter((c) => c.count > 0)
}

export const sameYear = (a: YearFilter | null, b: YearFilter | null) => JSON.stringify(a) === JSON.stringify(b)

const sorted = <T,>(xs: T[]) => [...xs].sort()
/** The same search and filters, whatever order the choices were ticked in. */
export function sameFilters(a: Filters, b: Filters): boolean {
  const key = (f: Filters) => JSON.stringify([sorted(f.kinds), f.year, sorted(f.topics), sorted(f.authors), sorted(f.venues), f.highlighted])
  return key(a) === key(b)
}

/** Stored views read back from disk: anything that isn't one (an older build's, a hand edit) is dropped. */
export function readViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return []
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
  return raw.filter((v): v is SavedView => {
    const f = (v as SavedView | null)?.filters
    return (
      !!v && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.query === 'string' &&
      (typeof v.scope === 'string' || typeof v.scope === 'number') &&
      !!f && strings(f.kinds) && strings(f.authors) && strings(f.venues) &&
      Array.isArray(f.topics) && f.topics.every((t) => typeof t === 'number') && typeof f.highlighted === 'boolean' &&
      (f.year === null || f.year === 'none' || (typeof f.year === 'object' && ['last', 'decade', 'before'].some((k) => typeof (f.year as Record<string, unknown>)[k] === 'number')))
    )
  })
}
