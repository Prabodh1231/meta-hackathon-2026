import type { PDFDocumentProxy } from 'pdfjs-dist'
import { api } from './api'

// A few recently opened PDFs, by document: the full viewer and the cited page share one download.
const KEEP = 6
const files = new Map<number, Promise<ArrayBuffer>>()
const parsed = new Map<number, Promise<PDFDocumentProxy>>()

function remember<T>(cache: Map<number, Promise<T>>, docId: number, load: () => Promise<T>): Promise<T> {
  let p = cache.get(docId)
  if (!p) {
    p = load()
    p.catch(() => cache.delete(docId)) // a failed load (file moved, backend restarting) is tried again next time
    cache.set(docId, p)
    if (cache.size > KEEP) cache.delete(cache.keys().next().value!)
  }
  return p
}

/** The PDF file of a library document. */
export function pdfBytes(docId: number): Promise<ArrayBuffer> {
  return remember(files, docId, () => api.documentFile(docId))
}

// pdf.js is large and only cited PDF pages need it, so it loads on first use.
let pdfjs: Promise<typeof import('pdfjs-dist')> | null = null
export function loadPdfjs() {
  pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default
    return lib
  })
  return pdfjs
}

/** A library PDF opened with pdf.js, to draw its pages. */
export function pdfDocument(docId: number): Promise<PDFDocumentProxy> {
  return remember(parsed, docId, async () => {
    const [lib, bytes] = await Promise.all([loadPdfjs(), pdfBytes(docId)])
    // pdf.js hands its buffer to a worker, which empties it: give it a copy, keep ours for the viewer.
    return lib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise
  })
}

/** pdf.js's matrix product, without importing pdf.js where it's already loaded. */
export function transform(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Characters compared when placing a quote on the page: case, spacing, ligatures and curly
 * quotes differ between the text the backend extracted and what pdf.js reads. */
function fold(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, '')
}

/** Where `needle` sits among the page's text items: one box per item it covers. */
export function placeQuote(
  items: { str: string; transform: number[]; width: number }[],
  needle: string,
  viewport: { transform: number[]; scale: number },
): Box[] {
  // The page's text without spaces, and for each character the item and offset it came from.
  let flat = ''
  const owner: [number, number][] = []
  items.forEach((it, i) => {
    for (let c = 0; c < it.str.length; c++) {
      const f = fold(it.str[c])
      for (const ch of f) {
        flat += ch
        owner.push([i, c])
      }
    }
  })
  const want = fold(needle)
  if (!want) return []
  let from = flat.indexOf(want)
  let to = from + want.length
  if (from < 0) {
    // Not word for word (a hyphenated line break, an OCR slip): its first and last words, in order.
    const head = want.slice(0, 40)
    const tail = want.slice(-40)
    from = flat.indexOf(head)
    const end = from < 0 ? -1 : flat.indexOf(tail, from)
    if (end < 0 || end - from > want.length * 1.5) return []
    to = end + tail.length
  }
  const spans = new Map<number, [number, number]>()
  for (const [i, c] of owner.slice(from, to)) {
    const s = spans.get(i)
    spans.set(i, s ? [Math.min(s[0], c), Math.max(s[1], c + 1)] : [c, c + 1])
  }
  return [...spans].map(([i, [a, b]]) => {
    const it = items[i]
    const m = transform(viewport.transform, it.transform)
    const size = Math.hypot(m[2], m[3])
    const w = it.width * viewport.scale
    const n = Math.max(1, it.str.length)
    return { left: m[4] + (w * a) / n, top: m[5] - size, width: Math.max(2, (w * (b - a)) / n), height: size * 1.2 }
  })
}
