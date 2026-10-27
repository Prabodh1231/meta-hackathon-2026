import { useEffect, useState } from 'react'
import { api } from '../api'
import type { DocxStyle, RefStyle } from '../types'
import { CITATION_STYLES } from './SettingsDialog'

interface Props {
  style: DocxStyle // from Settings
  citedDocIds: () => number[]
  onError: (msg: string) => void
}

export function ReferencesPanel({ style, citedDocIds, onError }: Props) {
  const [entries, setEntries] = useState<string[] | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  async function fetchEntries(s: RefStyle): Promise<string[]> {
    const ids = citedDocIds()
    return ids.length ? (await api.references(ids, s)).entries : []
  }

  async function build() {
    try {
      setEntries(await fetchEntries(style))
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  // Rebuild when the style changes in Settings, if a list is already showing.
  useEffect(() => {
    if (entries) build()
  }, [style])

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  async function copyBibtex() {
    try {
      const bib = await fetchEntries('bibtex')
      if (bib.length) await copy(bib.join('\n\n'), 'bibtex')
      else setEntries([])
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const label = CITATION_STYLES.find((s) => s.value === style)?.label ?? style
  return (
    <div className="references">
      <div className="row">
        <span className="muted">{label} · change in Settings</span>
        <button className="primary" onClick={build}>Build from cited sources</button>
      </div>
      {entries && entries.length === 0 && <p className="empty">Your document has no citations yet.</p>}
      {entries && entries.length > 0 && (
        <>
          <pre className="ref-list">{entries.join('\n')}</pre>
          <div className="row">
            <button onClick={copyBibtex}>{copied === 'bibtex' ? 'Copied BibTeX' : 'Copy as BibTeX'}</button>
            <button onClick={() => copy(entries.join('\n'), 'list')}>{copied === 'list' ? 'Copied' : 'Copy'}</button>
          </div>
        </>
      )}
    </div>
  )
}
