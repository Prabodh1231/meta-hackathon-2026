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

  // The list is built when the tab opens, and again when the style changes in Settings.
  useEffect(() => {
    build()
  }, [style]) // eslint-disable-line react-hooks/exhaustive-deps

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
        <span className="muted">
          {label}
          {entries && entries.length > 0 && ` · ${entries.length} source${entries.length === 1 ? '' : 's'} cited (a source cited twice is listed once)`} · style in Settings
        </span>
        <button onClick={build} title="Build the list again from the sources the draft cites now">
          Rebuild
        </button>
      </div>
      {!entries && <p className="muted">Building the list from the sources your draft cites…</p>}
      {entries && entries.length === 0 && (
        <p className="empty">
          Nothing cited yet. Cite a sentence with <b>Cite</b> (Ctrl+Shift+C), or draft from your sources in <b>Compose</b>, and every source
          you cite is listed here in your citation style, ready to copy or export with the draft.
        </p>
      )}
      {entries && entries.length > 0 && (
        <>
          <ul className="ref-list" aria-label="Reference list">
            {entries.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <div className="row">
            <button onClick={copyBibtex}>{copied === 'bibtex' ? 'Copied BibTeX' : 'Copy as BibTeX'}</button>
            <button onClick={() => copy(entries.join('\n'), 'list')}>{copied === 'list' ? 'Copied' : 'Copy'}</button>
          </div>
        </>
      )}
    </div>
  )
}
