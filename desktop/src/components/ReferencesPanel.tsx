import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Doc, DocxStyle, RefStyle } from '../types'
import { CITATION_STYLES } from './SettingsDialog'
import { TrustBadges } from './TrustBadges'

interface Props {
  style: DocxStyle // from Settings
  citedDocIds: () => number[]
  docs?: Doc[]
  onError: (msg: string) => void
}

export function ReferencesPanel({ style, citedDocIds, docs, onError }: Props) {
  const [entries, setEntries] = useState<string[] | null>(null)
  const [ids, setIds] = useState<number[]>([])
  const [copied, setCopied] = useState<string | null>(null)

  async function fetchEntries(s: RefStyle): Promise<string[]> {
    const entryIds = citedDocIds()
    setIds(entryIds)
    return entryIds.length ? (await api.references(entryIds, s)).entries : []
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

  /** Save the list as a file, so it can go into another app without selecting the text first. */
  async function exportList(asBibtex = false) {
    try {
      const list = asBibtex ? await fetchEntries('bibtex') : entries
      if (!list?.length) return
      const text = list.join(asBibtex ? '\n\n' : '\n')
      const name = asBibtex ? 'references.bib' : 'reference-list.txt'
      const data = new TextEncoder().encode(text)
      if (window.rc?.saveFile) await window.rc.saveFile(name, data.buffer as ArrayBuffer)
      else {
        const url = URL.createObjectURL(new Blob([data], { type: 'text/plain;charset=utf-8' }))
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 5000)
      }
      setCopied(asBibtex ? 'exported-bibtex' : 'exported-list')
      setTimeout(() => setCopied(null), 2000)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const renderedEntries = (entries ?? []).map((e, i) => ({ e, i, doc: docs?.find((d) => d.id === ids[i]) }))
  const paperEntries = renderedEntries.filter((x) => x.doc?.kind !== 'text')
  const noteEntries = renderedEntries.filter((x) => x.doc?.kind === 'text')
  const renderEntry = ({ e, i, doc }: (typeof renderedEntries)[number]) => (
    <li key={i}>
      <span>{e}</span>
      <TrustBadges doc={doc} showNote />
    </li>
  )
  const label = CITATION_STYLES.find((s) => s.value === style)?.label ?? style
  return (
    <div className="references">
      <div className="row">
        <span className="muted">
          {label}
          {entries && entries.length > 0 && ` · ${entries.length} source${entries.length === 1 ? '' : 's'} cited (a source cited twice is listed once)`} · style in Settings
        </span>
        <button onClick={build} title="Refresh: rebuild this list from the sources the draft cites now, in the style above. Then copy or export it below.">
          Refresh list
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
          {paperEntries.length > 0 && (
            <ul className="ref-list" aria-label="Reference list">
              {paperEntries.map(renderEntry)}
            </ul>
          )}
          {noteEntries.length > 0 && (
            <>
              <h3 className="src-section-head">
                Your notes <span>Your own reading notes, not published papers</span>
              </h3>
              <ul className="ref-list">{noteEntries.map(renderEntry)}</ul>
            </>
          )}
          <div className="row ref-actions" aria-label="Copy or export the reference list">
            <button className="primary" onClick={() => copy(entries.join('\n'), 'list')}>
              {copied === 'list' ? 'Copied list' : 'Copy list'}
            </button>
            <button onClick={copyBibtex}>{copied === 'bibtex' ? 'Copied BibTeX' : 'Copy as BibTeX'}</button>
            <button onClick={() => exportList(false)}>{copied === 'exported-list' ? 'Exported' : 'Export list (.txt)'}</button>
            <button onClick={() => exportList(true)}>{copied === 'exported-bibtex' ? 'Exported' : 'Export BibTeX (.bib)'}</button>
          </div>
        </>
      )}
    </div>
  )
}
