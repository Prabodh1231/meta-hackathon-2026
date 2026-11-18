import { api } from './api'
import { loadPdfjs } from './pdf'

// Paper covers in the Library: the first page of each PDF, drawn small. They are drawn here rather
// than through pdf.ts's cache, which keeps only the few PDFs the reader has open; a screen of covers
// would push those out. Each file is opened, its first page drawn, and the file let go again.

const MAX_AT_ONCE = 2 // a PDF parse is heavy; more at once makes scrolling stutter
const WIDTH = 480 // pixels across: sharp at the largest cover size on a high-density screen

/** A document's cover as an image URL, or null when it can't be drawn (a missing or broken file). */
const drawn = new Map<number, string | null>()
const waiting = new Map<number, Set<(url: string | null) => void>>() // asked for, by whom
const queue: number[] = [] // asked for and not started, in order
let running = 0

/** The cover already drawn for a document: a URL, null for none possible, undefined if not tried. */
export function coverDrawn(docId: number): string | null | undefined {
  return drawn.get(docId)
}

/** Ask for a document's cover; `done` gets it once drawn. Returns a function that withdraws the ask,
 * for a card scrolled away before its turn came. */
export function requestCover(docId: number, done: (url: string | null) => void): () => void {
  const have = drawn.get(docId)
  if (have !== undefined) {
    done(have)
    return () => {}
  }
  const asks = waiting.get(docId) ?? new Set()
  if (!waiting.has(docId)) {
    waiting.set(docId, asks)
    queue.push(docId)
  }
  asks.add(done)
  next()
  return () => {
    asks.delete(done)
    if (asks.size) return
    const at = queue.indexOf(docId)
    if (at >= 0) {
      queue.splice(at, 1)
      waiting.delete(docId)
    }
  }
}

function next() {
  while (running < MAX_AT_ONCE && queue.length) {
    const id = queue.shift()!
    running++
    draw(id)
      .catch(() => null)
      .then((url) => {
        drawn.set(id, url)
        for (const done of waiting.get(id) ?? []) done(url)
        waiting.delete(id)
        running--
        next()
      })
  }
}

async function draw(docId: number): Promise<string | null> {
  const [lib, bytes] = await Promise.all([loadPdfjs(), api.documentFile(docId)])
  const task = lib.getDocument({ data: new Uint8Array(bytes) })
  try {
    const pdf = await task.promise
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: WIDTH / page.getViewport({ scale: 1 }).width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport }).promise
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.82))
    return blob ? URL.createObjectURL(blob) : null
  } finally {
    void task.destroy() // the file and its worker memory go; only the small image is kept
  }
}
