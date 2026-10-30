import { useEffect, useState } from 'react'
import { pdfBytes } from '../pdf'
import type { Doc } from '../types'

/** A library PDF in Chromium's own viewer (search, zoom, print), opened at a page. The file is
 * fetched with the app's token and shown from a blob, so the token never goes in an address. */
export function PdfViewerDialog({ doc, page, onClose }: { doc: Doc; page: number; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let blobUrl: string | null = null
    let stale = false
    pdfBytes(doc.id)
      .then((bytes) => {
        if (stale) return
        blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
        setUrl(blobUrl)
      })
      .catch((e) => !stale && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      stale = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [doc.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal pdf-view" role="dialog" aria-modal="true" aria-label={`PDF: ${doc.title}`}>
        <header className="pdf-view-head">
          <span className="kind kind-pdf">PDF</span>
          <h2 title={doc.title}>{doc.title}</h2>
          <span className="spacer" />
          {window.rc?.showFile && (
            <button className="link" onClick={() => window.rc!.showFile!(doc.source).catch(() => {})}>
              Show in folder
            </button>
          )}
          <button className="icon" onClick={onClose} aria-label="Close the PDF" title="Close (Esc)">
            ×
          </button>
        </header>
        {error ? (
          <p className="error-text pdf-view-note">{error}</p>
        ) : url ? (
          <iframe className="pdf-view-frame" src={`${url}#page=${page}`} title={doc.title} />
        ) : (
          <p className="muted pdf-view-note">Opening…</p>
        )}
      </div>
    </div>
  )
}
