import { useEffect, useState } from 'react'
import type { DuplicateReport, RepeatPair, SourceMatch } from '../types'
import { Meter, Ring, Segmented, ago } from './Meters'
import { WaitStatus } from './WaitStatus'

type Level = 'document' | 'paragraphs' | 'sentences'
const LEVELS: { value: Level; label: string }[] = [
  { value: 'document', label: 'Document' },
  { value: 'paragraphs', label: 'Paragraphs' },
  { value: 'sentences', label: 'Sentences' },
]

interface Props {
  report: DuplicateReport | null
  checkedAt: number | null
  busy: boolean
  stale: boolean // the draft changed since the last check
  error: string | null // the last check failed; it isn't retried until onRun
  onRun: () => void
  onReveal: (block: number, text?: string) => void
  onOpenSource: (m: SourceMatch) => void
}

function Pair({ p, onReveal }: { p: RepeatPair; onReveal: Props['onReveal'] }) {
  return (
    <li className="dup-item">
      <div className="dup-top">
        <span className="chg chg-repeat">repeated</span>
        <span className="dup-pct">{p.similarity}% alike</span>
      </div>
      <button className="dup-quote" onClick={() => onReveal(p.first_block, p.first)} title="Show the first one in the draft">
        <span className="dup-n">1</span> {p.first}
      </button>
      <button className="link dup-show" onClick={() => onReveal(p.first_block, p.first)}>
        Show in draft
      </button>
      <button className="dup-quote" onClick={() => onReveal(p.second_block, p.second)} title="Show the repeat in the draft">
        <span className="dup-n">2</span> {p.second}
      </button>
      <button className="link dup-show" onClick={() => onReveal(p.second_block, p.second)}>
        Show in draft
      </button>
    </li>
  )
}

/** Duplication check: how much of the draft repeats itself or matches library text, at
 * document, paragraph and sentence level, each with its percentage. */
export function ReviewPanel({ report, checkedAt, busy, stale, error, onRun, onReveal, onOpenSource }: Props) {
  const [level, setLevel] = useState<Level>('document')
  // Since when the check has been running, for the wait line.
  const [since, setSince] = useState<number | null>(null)
  useEffect(() => setSince(busy ? Date.now() : null), [busy])

  const run = (
    <button className="primary" onClick={onRun} disabled={busy}>
      {busy ? 'Checking…' : report ? 'Check again' : 'Check for duplication'}
    </button>
  )

  const failed = error && (
    <div className="review-error" role="alert">
      <b>The check didn't run.</b> {error}
    </div>
  )

  if (!report) {
    return (
      <div className="review">
        {failed}
        <div className="review-intro">
          <p>
            Looks for passages your draft repeats, and for sentences that match text in your library closely
            (copied or lightly reworded), and shows what share of the draft each covers.
          </p>
          {busy && since ? (
            <>
              <WaitStatus
                label="Comparing each sentence with the rest of the draft and with your library…"
                startedAt={since}
                usual="A few seconds for a short draft, up to a minute for a long one. Keep writing."
              />
              {/* Where the results will appear: the share, then repeats and matches */}
              <div className="review-skeleton" aria-hidden="true">
                <span className="sk sk-ring" />
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
                <span className="sk sk-line" />
              </div>
            </>
          ) : (
            run
          )}
        </div>
      </div>
    )
  }

  const uncited = report.source_matches.filter((m) => !m.cited)
  const cited = report.source_matches.filter((m) => m.cited)
  const repeats = report.repeated_sentences.length + report.repeated_paragraphs.length

  return (
    <div className="review">
      <div className="review-head">
        <span className={`muted${stale ? ' stale' : ''}`}>
          {stale ? 'Draft changed since the check' : `Checked ${checkedAt ? ago(checkedAt) : ''}`} · {report.words.toLocaleString()} words
        </span>
        {run}
      </div>
      {failed}
      <Segmented label="Duplication level" value={level} options={LEVELS} onChange={setLevel} />

      {level === 'document' && (
        <>
          <section className="review-doc">
            <Ring pct={report.overall} tone="risk" caption="of the draft" size={92} />
            <div className="review-bars">
              <Meter label="Matches sources" pct={report.sources} tone="risk" title="Words in sentences that closely match a library passage" />
              <Meter label="…not cited" pct={report.uncited} tone="risk" title="Of those, sentences that don't cite the matching source" />
              <Meter label="Repeats itself" pct={report.internal} tone="risk" title="Words in sentences the draft already said earlier" />
            </div>
          </section>
          <ul className="review-summary">
            <li className={uncited.length ? 'bad' : 'good'}>
              <b>{uncited.length}</b> sentence{uncited.length === 1 ? ' matches' : 's match'} a source without citing it
            </li>
            <li className={cited.length ? 'note' : 'good'}>
              <b>{cited.length}</b> cited sentence{cited.length === 1 ? ' follows' : 's follow'} the source closely
            </li>
            <li className={repeats ? 'warn' : 'good'}>
              <b>{repeats}</b> repeated passage{repeats === 1 ? '' : 's'} inside the draft
            </li>
          </ul>
          <p className="muted legend">
            <span className="review-source">uncited match</span> <span className="review-cited">cited match</span>{' '}
            <span className="review-repeat">repeat</span> are underlined in the draft.
          </p>
        </>
      )}

      {level === 'paragraphs' && (
        <>
          {!report.paragraphs.length && !report.repeated_paragraphs.length && (
            <p className="empty">No paragraph has duplicated text.</p>
          )}
          {!!report.paragraphs.length && <h4 className="review-h">Share of each paragraph that is duplicated</h4>}
          <ul className="dup-list">
            {[...report.paragraphs].sort((a, b) => b.flagged - a.flagged).map((p) => (
              <li key={p.block} className="dup-item">
                <button className="dup-quote" onClick={() => onReveal(p.block)}>{p.text}{p.text.length >= 200 ? '…' : ''}</button>
                <button className="link dup-show" onClick={() => onReveal(p.block)}>
                  Show in draft
                </button>
                <Meter pct={p.flagged} tone="risk" title={`${p.flagged}% of this paragraph's ${p.words} words`} />
              </li>
            ))}
          </ul>
          {!!report.repeated_paragraphs.length && <h4 className="review-h">Paragraphs that say the same thing</h4>}
          <ul className="dup-list">
            {report.repeated_paragraphs.map((p, i) => <Pair key={i} p={p} onReveal={onReveal} />)}
          </ul>
        </>
      )}

      {level === 'sentences' && (
        <>
          {!report.source_matches.length && !report.repeated_sentences.length && (
            <p className="empty">No sentence repeats another or matches a source closely.</p>
          )}
          {!!report.source_matches.length && <h4 className="review-h">Close to a source</h4>}
          <ul className="dup-list">
            {report.source_matches.map((m, i) => (
              <li key={i} className="dup-item">
                <div className="dup-top">
                  <span className={`chg ${m.cited ? 'chg-cited' : 'chg-source'}`}>
                    {m.level === 'copied' ? 'Copied' : 'Close match'} · {m.cited ? 'cited' : 'not cited — needs attention'}
                  </span>
                  <span className="dup-pct">{m.similarity}% match</span>
                </div>
                <button className="dup-quote" onClick={() => onReveal(m.block, m.sentence)} title="Show in the draft">
                  {m.sentence}
                </button>
                <button className="dup-src" onClick={() => onOpenSource(m)} title="Open the matching passage">
                  <span className="dup-src-label">{m.label}</span>
                  <span className="dup-src-quote">“{m.quote}”</span>
                </button>
                <div className="dup-actions">
                  <button className="link" onClick={() => onReveal(m.block, m.sentence)}>
                    Show in draft
                  </button>
                  {!m.cited && (
                    <button className="link" onClick={() => onOpenSource(m)} title="Open the matching source to cite it for this sentence">
                      Cite this source
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {!!report.repeated_sentences.length && <h4 className="review-h">Repeated in your draft</h4>}
          <ul className="dup-list">
            {report.repeated_sentences.map((p, i) => <Pair key={i} p={p} onReveal={onReveal} />)}
          </ul>
        </>
      )}
    </div>
  )
}
