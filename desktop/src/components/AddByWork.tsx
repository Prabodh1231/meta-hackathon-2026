import { useEffect, useState } from 'react'
import { api } from '../api'
import type { FetchResult, FoundWork } from '../types'

// A DOI as people paste it: bare, "doi:10.…", or a doi.org link (typed_doi in backend/app/openaccess.py).
const DOI = /^\s*(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+?)[\s.]*$/i

/** What was typed into Add sources' box: a web page, a DOI, a file or folder on this computer, or
 *  else a paper's title. A path has a drive letter, starts with / \\ or ~, holds a backslash, or is a
 *  bare file name with an extension ("notes.pdf"); a title has none of those. */
export function typedKind(value: string): 'doi' | 'url' | 'path' | 'title' {
  if (DOI.test(value)) return 'doi'
  if (/^https?:\/\//i.test(value)) return 'url'
  if (/^[a-z]:[\\/]/i.test(value) || /^(\/|\\\\|~)/.test(value) || value.includes('\\') || /^[^\s\\/]+\.[a-z0-9]{2,5}$/i.test(value)) return 'path'
  return 'title'
}

type Step =
  | { at: 'looking' }
  | { at: 'pick'; works: FoundWork[]; more: boolean } // a close, not exact, title match: confirm first
  | { at: 'adding'; work: FoundWork }
  | { at: 'done'; work: FoundWork; res: FetchResult }
  | { at: 'none'; kind: 'doi' | 'title' }
  | { at: 'error'; message: string }

const byline = (w: FoundWork) => [w.authors.length > 2 ? `${w.authors[0]} et al.` : w.authors.join(', '), w.year, w.venue].filter(Boolean).join(' · ')

/** Adding a paper by its DOI or title: find it in OpenAlex, confirm it when the title only came
 *  close, then find a free copy (fetch_work) and add it. Each outcome is said where it happened. */
export function AddByWork({ text, onAdded, onShow }: {
  text: string // a DOI or a title, as typed
  onAdded: (docId: number) => Promise<void> // a copy was added: reload the library and show it
  onShow: (docId: number) => void
}) {
  const [step, setStep] = useState<Step>({ at: 'looking' })
  const [attempt, setAttempt] = useState(0)

  const add = async (work: FoundWork) => {
    if (work.in_library != null) return setStep({ at: 'done', work, res: { status: 'in_library', doc_id: work.in_library } })
    setStep({ at: 'adding', work })
    let res: FetchResult
    try {
      res = await api.fetchWork({ title: work.title, doi: work.doi, year: work.year, first_author: work.first_author })
    } catch (e) {
      res = { status: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
    setStep({ at: 'done', work, res })
    if (res.status === 'downloaded' && res.doc_id != null) await onAdded(res.doc_id).catch(() => {})
  }

  useEffect(() => {
    let current = true
    setStep({ at: 'looking' })
    api
      .findWork(text)
      .then((r) => {
        if (!current) return
        if (!r.works.length) return setStep({ at: 'none', kind: r.kind })
        if (r.works[0].exact) return add(r.works[0])
        setStep({ at: 'pick', works: r.works, more: false })
      })
      .catch((e) => current && setStep({ at: 'error', message: e instanceof Error ? e.message : String(e) }))
    return () => {
      current = false
    }
  }, [text, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  const retry = <button type="button" className="link" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
  if (step.at === 'looking') return <div className="add-found muted" role="status">Looking it up in OpenAlex…</div>
  if (step.at === 'error') {
    return (
      <div className="add-found bad" role="status">
        {/couldn't reach/i.test(step.message) ? "Couldn't reach OpenAlex." : step.message} {retry}
      </div>
    )
  }
  if (step.at === 'none') {
    return (
      <div className="add-found" role="status">
        {step.kind === 'doi' ? 'OpenAlex doesn’t know that DOI.' : 'Nothing in OpenAlex matches that title.'}
        <span className="muted"> {step.kind === 'doi' ? 'Check it, or try the title.' : 'Check the spelling, or try its DOI.'}</span>
      </div>
    )
  }
  if (step.at === 'pick') {
    const shown = step.more ? step.works : step.works.slice(0, 1)
    return (
      <div className="add-found" role="group" aria-label="Is this the one?">
        <div className="add-found-ask">{shown.length > 1 ? 'Which one?' : 'Is this the one?'}</div>
        {shown.map((w) => (
          <div key={w.openalex_id} className="add-found-work">
            <div className="add-found-title">{w.title}</div>
            <div className="muted">{byline(w)}</div>
            <button type="button" className="primary" onClick={() => add(w)}>
              {w.in_library != null ? 'In your library: show it' : 'Add it'}
            </button>
          </div>
        ))}
        {!step.more && step.works.length > 1 && (
          <button type="button" className="link" onClick={() => setStep({ ...step, more: true })}>
            Not it? {step.works.length - 1} more
          </button>
        )}
      </div>
    )
  }
  if (step.at === 'adding') {
    return (
      <div className="add-found muted" role="status">
        Finding a free copy of “{step.work.title}”…
      </div>
    )
  }
  const { res, work } = step
  const show = res.doc_id != null && (
    <button type="button" className="link" onClick={() => onShow(res.doc_id!)}>Show it</button>
  )
  const publisher = work.doi && (
    <a className="link" href={`https://doi.org/${work.doi}`} target="_blank" rel="noreferrer">Publisher's page ↗</a>
  )
  return (
    <div className={`add-found${res.status === 'downloaded' ? ' good' : res.status === 'no_free_copy' ? ' warn' : res.status === 'failed' ? ' bad' : ''}`} role="status">
      <div className="add-found-title">{work.title}</div>
      {res.status === 'downloaded' && <span>Added. Muse is reading it now. {show}</span>}
      {res.status === 'in_library' && <span>Already in your library. {show}</span>}
      {res.status === 'no_free_copy' && <span>Found it, but there's no free copy. {publisher}</span>}
      {res.status === 'link' && (
        <span>
          Free to read online, but no PDF to download.{' '}
          {res.url && <a className="link" href={res.url} target="_blank" rel="noreferrer">Read online ↗</a>}
        </span>
      )}
      {res.status === 'not_found' && <span>No copy could be found anywhere. {publisher}</span>}
      {res.status === 'failed' && <span>{res.reason || "Couldn't add it."} {<button type="button" className="link" onClick={() => add(work)}>Try again</button>}</span>}
    </div>
  )
}
