import { useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { api } from '../api'
import type { DocxStyle } from '../types'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

interface Props {
  getJSON: () => JSONContent | null
  getTitle: () => string
  onError: (msg: string) => void
}

function fileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return `${safe || 'Draft'}.docx`
}

/** Word export: citations rendered in the chosen style, a reference list, and Word
 * comments on citations that didn't pass verification. */
export function ExportControl({ getJSON, getTitle, onError }: Props) {
  const [style, setStyle] = useState<DocxStyle>('apa')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)

  async function exportDocx() {
    const content = getJSON()
    if (!content) return
    setBusy(true)
    setSaved(null)
    try {
      const title = getTitle()
      const data = await api.exportDocx(content, style, title)
      if (window.rc) {
        const path = await window.rc.saveFile(fileName(title), data)
        if (path) setSaved(path)
      } else {
        // Plain browser (dev without Electron): let the browser download it.
        const url = URL.createObjectURL(new Blob([data], { type: DOCX_MIME }))
        const a = document.createElement('a')
        a.href = url
        a.download = fileName(title)
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 5000)
        setSaved(a.download)
      }
    } catch (e) {
      onError(`Export failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="export">
      {saved && (
        <span className="muted saved" title={saved}>
          Saved {saved.split(/[\\/]/).pop()}
        </span>
      )}
      <select value={style} onChange={(e) => setStyle(e.target.value as DocxStyle)} title="Citation style">
        <option value="apa">APA 7</option>
        <option value="mla">MLA 9</option>
        <option value="ieee">IEEE</option>
      </select>
      <button onClick={exportDocx} disabled={busy}>
        {busy ? 'Exporting…' : 'Export .docx'}
      </button>
    </div>
  )
}
