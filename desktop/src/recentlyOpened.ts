// The papers and folders last opened in the Library, newest first, for the strip above the folders.
// Kept in localStorage beside the Library's other remembered choices. A folder is kept by its key
// ('t:12' a topic, 'v:needs' a ready-made view, 's:…' a saved view).

export type Recent = { kind: 'doc'; id: number } | { kind: 'folder'; key: string }

const KEY = 'gw.library.recent'
const KEEP = 12 // more than are shown, so entries for things deleted since still leave enough

export function readRecent(): Recent[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(v)) return []
    return v.filter(
      (r): r is Recent =>
        !!r && ((r.kind === 'doc' && typeof r.id === 'number') || (r.kind === 'folder' && typeof r.key === 'string')),
    )
  } catch {
    return []
  }
}

const same = (a: Recent, b: Recent) => (a.kind === 'doc' && b.kind === 'doc' ? a.id === b.id : a.kind === 'folder' && b.kind === 'folder' && a.key === b.key)

/** `list` with `entry` moved to the front, saved. */
export function noteRecent(list: Recent[], entry: Recent): Recent[] {
  const next = [entry, ...list.filter((r) => !same(r, entry))].slice(0, KEEP)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // no storage (a private window): the strip lasts until the app closes
  }
  return next
}
