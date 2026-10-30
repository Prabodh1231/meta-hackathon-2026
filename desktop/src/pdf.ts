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
function loadPdfjs() {
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
