import { useEffect, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { api } from '../api'
import type { DocxStyle } from '../types'
import type { PageSetup } from '../editor/docFormat'
import { Icon } from './Icon'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

interface Props {
  style: DocxStyle // from Settings
  getJSON: () => JSONContent | null
  getTitle: () => string
  getPageSetup: () => PageSetup | null
  onPageSetup: () => void
  onError: (msg: string) => void
  onExported?: () => void // a file was saved (the demo checklist ticks it off)
}

function fileName(title: string, ext: string): string {
  const safe = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return `${safe || 'Draft'}.${ext}`
}

const PAPER = { a4: 'A4', letter: 'Letter' }
const MARGIN = { narrow: 'narrow margins', normal: 'normal margins', wide: 'wide margins' }

/** Export: Word (citations in the Settings style, a reference list, comments on citations that didn't
 * pass verification), PDF and printing (the same document, from the backend's HTML page), and the
 * draft's page setup. */
export function ExportControl({ style, getJSON, getTitle, getPageSetup, onPageSetup, onError, onExported }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  async function run(kind: 'docx' | 'pdf' | 'print') {
    setOpen(false)
    const content = getJSON()
    if (!content) return
    setBusy(kind)
    setSaved(null)
    try {
      const title = getTitle()
      if (kind === 'docx') {
        const data = await api.exportDocx(content, style, title)
        if (window.rc) {
          const path = await window.rc.saveFile(fileName(title, 'docx'), data)
          if (path) {
            setSaved(path)
            onExported?.()
          }
        } else {
          // Plain browser (dev without Electron): let the browser download it.
          const url = URL.createObjectURL(new Blob([data], { type: DOCX_MIME }))
          const a = document.createElement('a')
          a.href = url
          a.download = fileName(title, 'docx')
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 5000)
          setSaved(a.download)
          onExported?.()
        }
        return
      }
      const html = await api.exportHtml(content, style, title)
      if (window.rc?.printHtml) {
        const page = getPageSetup()
        const path = await window.rc.printHtml(html, { pdf: kind === 'pdf', fileName: fileName(title, 'pdf'), pageNumbers: page?.pageNumbers ?? true })
        if (path && kind === 'pdf') {
          setSaved(path)
          onExported?.()
        }
      } else {
        // Plain browser: the page in a new window, printed from there ("Save as PDF" is one of its printers).
        const w = window.open('', '_blank')
        if (!w) throw new Error('The browser blocked the print window')
        w.document.write(html)
        w.document.close()
        w.focus()
        w.print()
      }
    } catch (e) {
      onError(`${kind === 'docx' ? 'Export' : kind === 'pdf' ? 'Saving the PDF' : 'Printing'} failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(null)
    }
  }

  const page = open ? getPageSetup() : null
  return (
    <div className="export" ref={box}>
      {saved && (
        <span className="muted saved" title={saved}>
          Saved {saved.split(/[\\/]/).pop()}
        </span>
      )}
      <button className="bar-btn" onClick={() => setOpen((o) => !o)} disabled={!!busy} aria-haspopup="menu" aria-expanded={open} title="Save as Word or PDF, print, page setup">
        <Icon name="download" size={16} />
        <span>{busy === 'docx' ? 'Exporting…' : busy === 'pdf' ? 'Making the PDF…' : busy === 'print' ? 'Printing…' : 'Export'}</span>
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="export-menu" role="menu">
          <button role="menuitem" onClick={() => run('docx')}>
            <b>Word (.docx)</b>
            <small>{style.toUpperCase()} citations, a reference list, comments on citations that need checking</small>
          </button>
          <button role="menuitem" onClick={() => run('pdf')}>
            <b>PDF</b>
            <small>The same document, ready to send; footnotes become notes at the end</small>
          </button>
          <button role="menuitem" onClick={() => run('print')}>
            <b>Print…</b>
          </button>
          <hr />
          <button role="menuitem" onClick={() => (setOpen(false), onPageSetup())}>
            <b>Page setup…</b>
            {page && (
              <small>
                {PAPER[page.size]}
                {page.orientation === 'landscape' ? ' landscape' : ''} · {MARGIN[page.margins]}
                {page.pageNumbers ? ' · page numbers' : ''}
              </small>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
