import { useState } from 'react'
import { api } from '../api'
import type { RefStyle } from '../types'

interface Props {
  citedDocIds: () => number[]
  onError: (msg: string) => void
}

export function ReferencesPanel({ citedDocIds, onError }: Props) {
  const [style, setStyle] = useState<RefStyle>('apa')
  const [entries, setEntries] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)

  async function build(s: RefStyle = style) {
    const ids = citedDocIds()
    if (!ids.length) {
      setEntries([])
      return
    }
    try {
      setEntries((await api.references(ids, s)).entries)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const joined = entries?.join(style === 'bibtex' ? '\n\n' : '\n') ?? ''

  return (
    <div className="references">
      <div className="row">
        <select
          value={style}
          onChange={(e) => {
            const s = e.target.value as RefStyle
            setStyle(s)
            if (entries) build(s)
          }}
        >
          <option value="apa">APA 7</option>
          <option value="mla">MLA 9</option>
          <option value="ieee">IEEE</option>
          <option value="bibtex">BibTeX</option>
        </select>
        <button className="primary" onClick={() => build()}>Build from cited sources</button>
      </div>
      {entries && entries.length === 0 && <p className="empty">Your document has no citations yet.</p>}
      {entries && entries.length > 0 && (
        <>
          <pre className="ref-list">{joined}</pre>
          <button
            onClick={() => {
              navigator.clipboard.writeText(joined)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </>
      )}
    </div>
  )
}
