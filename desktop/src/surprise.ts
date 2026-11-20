import type { Doc } from './types'

/** Surprise me: a paper from `docs` the reader hasn't opened yet, at random. PDFs first, since they
 *  open in the app's reader; any other paper when there are no PDFs. The reader's own notes aren't
 *  papers to discover, and a paper whose file is missing can't be opened, so both are left out. When everything has been read, any of them, and
 *  `allRead` says so. `unread` is how many unread papers there were to pick from. */
export function pickSurprise(docs: Doc[], random = Math.random): { doc: Doc; allRead: boolean; unread: number } | null {
  const papers = docs.filter((d) => d.kind !== 'text' && !d.file_missing) // a missing file can't be opened
  const pdfs = papers.filter((d) => d.kind === 'pdf')
  const pool = pdfs.length ? pdfs : papers
  if (!pool.length) return null
  const unread = pool.filter((d) => d.unread)
  const from = unread.length ? unread : pool
  return { doc: from[Math.floor(random() * from.length)], allRead: !unread.length, unread: unread.length }
}

const short = (t: string) => (t.length > 80 ? `${t.slice(0, 78)}…` : t)

/** What to say once it's open. */
export function surpriseText(pick: { doc: Doc; allRead: boolean; unread: number }, where: string): string {
  return pick.allRead
    ? `Everything in ${where} has been read, so here's one at random: “${short(pick.doc.title)}”.`
    : `Opened “${short(pick.doc.title)}”, ${pick.unread === 1 ? `the one unread paper in ${where}` : `one of ${pick.unread} unread in ${where}`}.`
}
