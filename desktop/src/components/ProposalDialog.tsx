import { useEffect, useState } from 'react'
import { api } from '../api'
import type { FindingSummary, MatrixSummary, ProposalResult, SimilarWork, SuggestedVariable, VariableRole } from '../types'
import { notifyDone } from '../notify'
import { WaitStatus } from './WaitStatus'

interface Props {
  /** The matrix it was opened from, ticked to start with. */
  matrixId: number | null
  onCreate: (result: ProposalResult) => void
  onClose: () => void
  onError: (msg: string) => void
}

type Step = 'gaps' | 'variables' | 'limits' | 'result'
type Role = VariableRole | 'unused'
interface Variable {
  name: string
  role: Role
  measure: string // how this study would measure it
  why: string
  measures: SuggestedVariable['measures'] // how the reviewed studies did
}

const ROLES: { value: Role; label: string }[] = [
  { value: 'independent', label: 'Independent' },
  { value: 'dependent', label: 'Dependent' },
  { value: 'mediator', label: 'Mediator' },
  { value: 'moderator', label: 'Moderator' },
  { value: 'control', label: 'Control' },
  { value: 'unused', label: 'Not used' },
]
const STEPS: { key: Step; label: string }[] = [
  { key: 'gaps', label: 'Gaps' },
  { key: 'variables', label: 'Variables' },
  { key: 'limits', label: 'Limits' },
  { key: 'result', label: 'Proposal' },
]
const LAST_LIMITS = 'rc-proposal-limits' // asked each time, filled in with the last answers

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function lastLimits(): { exclusions: string; resources: string } {
  try {
    return { exclusions: '', resources: '', ...JSON.parse(localStorage.getItem(LAST_LIMITS) || '{}') }
  } catch {
    return { exclusions: '', resources: '' }
  }
}

/** Write a research proposal for a study that addresses gaps from one or more review matrices. */
export function ProposalDialog({ matrixId, onCreate, onClose, onError }: Props) {
  const [step, setStep] = useState<Step>('gaps')
  const [matrices, setMatrices] = useState<MatrixSummary[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set(matrixId != null ? [matrixId] : []))
  const [gapsOf, setGapsOf] = useState<Record<number, FindingSummary[]>>({})
  const [gaps, setGaps] = useState<Set<number>>(new Set())
  const [focus, setFocus] = useState('')
  const [variables, setVariables] = useState<Variable[] | null>(null)
  const [limits, setLimits] = useState(lastLimits)
  const [result, setResult] = useState<ProposalResult | null>(null)
  const [similar, setSimilar] = useState<SimilarWork[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // Since when the current wait runs, and whether it's the write (whose steps the backend reports).
  const [busyAt, setBusyAt] = useState(0)
  const [writing, setWriting] = useState(false)
  const wait = (label: string) => {
    setBusy(label)
    setBusyAt(Date.now())
  }

  useEffect(() => {
    api.matrices().then(setMatrices).catch((e) => onError(message(e)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Each ticked matrix's kept gaps.
  useEffect(() => {
    for (const id of picked) {
      if (gapsOf[id]) continue
      api
        .matrixFindings(id)
        .then((f) => setGapsOf((g) => ({ ...g, [id]: f.filter((x) => x.kind === 'gap') })))
        .catch((e) => onError(message(e)))
    }
  }, [picked]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = <T,>(set: Set<T>, v: T) => (set.has(v) ? new Set([...set].filter((x) => x !== v)) : new Set([...set, v]))
  // A gap is used only while its matrix is ticked.
  const usedGaps = [...gaps].filter((g) => [...picked].some((m) => gapsOf[m]?.some((f) => f.id === g)))
  const sources = { matrix_ids: [...picked], finding_ids: usedGaps, focus: focus.trim() }
  const canGo = picked.size > 0 && (usedGaps.length > 0 || focus.trim() !== '')
  const chosen = (variables ?? []).filter((v) => v.role !== 'unused' && v.name.trim())

  async function suggest() {
    wait('Muse is reading the matrices for variables…')
    try {
      const out = await api.proposalVariables(sources)
      setVariables(out.map((v) => ({ ...v, measure: '' })))
    } catch (e) {
      onError(message(e))
    } finally {
      setBusy(null)
    }
  }

  async function write(avoid = result?.violations ?? []) {
    try {
      localStorage.setItem(LAST_LIMITS, JSON.stringify(limits))
    } catch {
      /* storage unavailable */
    }
    setStep('result')
    wait(avoid.length ? 'Writing it again without what you ruled out…' : 'Muse is writing the proposal and checking it…')
    setWriting(true)
    setSimilar(null)
    try {
      const r = await api.writeProposal({
        ...sources,
        variables: chosen.map((v) => ({ name: v.name.trim(), role: v.role as VariableRole, measure: v.measure.trim() })),
        exclusions: limits.exclusions.trim(),
        resources: limits.resources.trim(),
        avoid,
      })
      setResult(r)
      notifyDone('Your research proposal is ready', r.title)
    } catch (e) {
      onError(message(e))
      if (!result) setStep('limits')
    } finally {
      setBusy(null)
      setWriting(false)
    }
  }

  async function checkNovelty() {
    if (!result) return
    wait('Searching OpenAlex for similar studies…')
    try {
      setSimilar((await api.proposalNovelty(result.research_questions[0] || result.title)).works)
    } catch (e) {
      onError(message(e))
    } finally {
      setBusy(null)
    }
  }

  function next() {
    if (step === 'gaps') {
      setStep('variables')
      if (!variables) suggest()
    } else if (step === 'variables') setStep('limits')
    else if (step === 'limits') write([])
  }
  const back = () => setStep(step === 'result' ? 'limits' : step === 'limits' ? 'variables' : 'gaps')
  const update = (i: number, patch: Partial<Variable>) => setVariables((vs) => vs && vs.map((v, j) => (j === i ? { ...v, ...patch } : v)))

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal mx-dialog proposal-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-title">
        <header className="modal-head">
          <h2 id="proposal-title">Write a research proposal</h2>
          <button className="icon" onClick={onClose} aria-label="Close">×</button>
        </header>
        <ol className="proposal-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.key} className={s.key === step ? 'on' : STEPS.findIndex((x) => x.key === step) > i ? 'done' : ''}>
              {i + 1}. {s.label}
            </li>
          ))}
        </ol>

        {step === 'gaps' && (
          <section>
            <p className="muted">
              Tick the gaps the study should address. Tick more than one matrix to draw on several reviews; a paper in two
              of them counts once. The proposal is for one study: gaps that don't fit it with the others are left out, and
              you'll see which and why.
            </p>
            {matrices === null && <p className="busy">Loading your matrices…</p>}
            {matrices?.length === 0 && <p className="warn">Make a review matrix and run Find gaps first.</p>}
            <ul className="proposal-matrices">
              {matrices?.map((m) => (
                <li key={m.id}>
                  <label>
                    <input type="checkbox" checked={picked.has(m.id)} onChange={() => setPicked((p) => toggle(p, m.id))} />{' '}
                    <b>{m.name}</b> <span className="muted">{m.papers} papers</span>
                  </label>
                  {picked.has(m.id) && (
                    <ul className="proposal-gaps">
                      {!gapsOf[m.id] && <li className="muted">Loading its gaps…</li>}
                      {gapsOf[m.id]?.length === 0 && <li className="muted">No gaps yet: run Find gaps on this matrix, or say below what the study is about.</li>}
                      {gapsOf[m.id]?.map((g) => (
                        <li key={g.id}>
                          <label>
                            <input type="checkbox" checked={gaps.has(g.id)} onChange={() => setGaps((s) => toggle(s, g.id))} />{' '}
                            <b>{g.title}</b> {g.text}
                            {g.matrix_changed && <em className="flag"> (the matrix has changed since)</em>}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            <label className="proposal-field">
              <span>Anything the study should focus on? (optional)</span>
              <textarea rows={2} value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="e.g. women-led small firms; effects that last beyond two years" />
            </label>
          </section>
        )}

        {step === 'variables' && (
          <section>
            <p className="muted">
              Muse suggests the variables from your matrices. Give each a role, or mark it not used, and say how you'd measure
              it if you know.
            </p>
            {busy && <WaitStatus label={busy} startedAt={busyAt} steps={writing} usual={writing ? 'Writing a proposal takes five Muse steps, usually 1 to 3 minutes.' : 'This usually takes 10 to 30 seconds.'} />}
            {variables && variables.length === 0 && !busy && <p className="muted">No variables suggested. Add your own below.</p>}
            {variables && variables.length > 0 && (
              <table className="proposal-vars">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Role</th>
                    <th>In the reviewed studies</th>
                    <th>In this study</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {variables.map((v, i) => (
                    <tr key={i} className={v.role === 'unused' ? 'unused' : ''}>
                      <td>
                        <input value={v.name} onChange={(e) => update(i, { name: e.target.value })} aria-label="Variable" />
                        {v.why && <div className="muted small">{v.why}</div>}
                      </td>
                      <td>
                        <select value={v.role} onChange={(e) => update(i, { role: e.target.value as Role })} aria-label="Role">
                          {ROLES.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="small">
                        {v.measures.length === 0 && <span className="muted">Not measured</span>}
                        {v.measures.map((m, j) => (
                          <div key={j}>
                            <b>{m.label}:</b> {m.how}
                          </div>
                        ))}
                      </td>
                      <td>
                        <input value={v.measure} onChange={(e) => update(i, { measure: e.target.value })} placeholder="Leave to Muse" aria-label="Measure in this study" />
                      </td>
                      <td>
                        <button className="icon" onClick={() => setVariables((vs) => vs && vs.filter((_, j) => j !== i))} aria-label={`Remove ${v.name}`}>
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mx-actions">
              <button onClick={() => setVariables((vs) => [...(vs ?? []), { name: '', role: 'independent', measure: '', why: '', measures: [] }])}>
                + Add a variable
              </button>
              <button className="link" onClick={suggest} disabled={!!busy}>
                Suggest again
              </button>
            </div>
          </section>
        )}

        {step === 'limits' && (
          <section>
            <label className="proposal-field">
              <span>What don't you want?</span>
              <textarea
                rows={3}
                value={limits.exclusions}
                onChange={(e) => setLimits((l) => ({ ...l, exclusions: e.target.value }))}
                placeholder={'One per line, e.g.\nNo randomised trials\nNo primary data collection\nNot Kenya again'}
              />
              <span className="muted small">Treated as strict rules. The proposal is checked against them after it's written.</span>
            </label>
            <label className="proposal-field">
              <span>What do you have to work with?</span>
              <textarea
                rows={3}
                value={limits.resources}
                onChange={(e) => setLimits((l) => ({ ...l, resources: e.target.value }))}
                placeholder="e.g. access to a national household survey; 18 months; Stata; no budget for fieldwork"
              />
            </label>
            <p className="muted small">
              {chosen.length} variable{chosen.length === 1 ? '' : 's'} · {usedGaps.length} gap{usedGaps.length === 1 ? '' : 's'}
              {focus.trim() ? ' · with your focus' : ''}
            </p>
          </section>
        )}

        {step === 'result' && (
          <section>
            {busy && <WaitStatus label={busy} startedAt={busyAt} steps={writing} usual={writing ? 'Writing a proposal takes five Muse steps, usually 1 to 3 minutes.' : 'This usually takes 10 to 30 seconds.'} />}
            {result && !busy && (
              <>
                <h3 className="proposal-result-title">{result.title}</h3>
                {result.core_question && (
                  <p className="proposal-core">
                    <span className="muted">Core question:</span> {result.core_question}
                  </p>
                )}
                {result.research_questions.length > 0 && (
                  <>
                    <h4 className="eyebrow">Research questions</h4>
                    <ol className="proposal-rqs">
                      {result.research_questions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ol>
                  </>
                )}
                {result.question_review.length > 0 && (
                  <div className="proposal-note">
                    <b>Muse reviewed the study's focus:</b>
                    <ul>
                      {result.question_review.map((q, i) => (
                        <li key={i}>
                          {q.verdict === 'core' ? (
                            <>
                              <b>Refocused the core question</b> to “{q.text}”
                              {q.title && q.title !== q.title_before && <> and the title to “{q.title}”</>}
                            </>
                          ) : q.verdict === 'remove' ? (
                            <>
                              <b>Removed</b> “{q.original}”
                            </>
                          ) : (
                            <>
                              <b>Revised</b> “{q.original}” → “{q.text}”
                            </>
                          )}
                          {q.why && <span className="muted">: {q.why}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="muted small">
                  From {result.matrices}. {result.citations.verified} of {result.citations.verified + result.citations.flagged} citations
                  to the reviewed studies are backed by the matrices
                  {result.citations.flagged ? '; the others show amber or red in the draft' : ''}.
                </p>
                {result.left_out.length > 0 && (
                  <div className="proposal-note">
                    <b>Left out, to keep it one study:</b>
                    <ul>
                      {result.left_out.map((g, i) => (
                        <li key={i}>
                          <b>{g.gap}</b>: {g.why}
                        </li>
                      ))}
                    </ul>
                    <span className="muted small">Untick the gaps you don't need, or write a proposal for these separately.</span>
                  </div>
                )}
                {result.repaired.length > 0 && (
                  <details className="proposal-flagged proposal-repaired">
                    <summary>
                      Muse rewrote {result.repaired.filter((r) => r.after).length} and took out{' '}
                      {result.repaired.filter((r) => !r.after).length} paragraph{result.repaired.length === 1 ? '' : 's'} the
                      matrices didn't back
                    </summary>
                    <ul>
                      {result.repaired.map((r, i) => (
                        <li key={i}>
                          <div className="muted small">Was: {r.before}</div>
                          {r.after ? (
                            <div>
                              Now: {r.after}{' '}
                              <span className={`badge badge-${r.status}`}>{r.status === 'verified' ? 'backed' : 'partly'}</span>
                            </div>
                          ) : (
                            <div className="muted small">Taken out: {r.reason}</div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {result.removed.length > 0 && (
                  <details className="proposal-flagged">
                    <summary>
                      Took out {result.removed.length} earlier measure{result.removed.length === 1 ? '' : 's'} the matrices don't state
                    </summary>
                    <ul>
                      {result.removed.map((r, i) => (
                        <li key={i}>
                          {r.claim}
                          {r.reason && <div className="muted small">{r.reason}</div>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {result.flagged.length > 0 && (
                  <details className="proposal-flagged">
                    <summary>
                      {result.flagged.length} claim{result.flagged.length === 1 ? '' : 's'} about the reviewed studies the matrices don't
                      fully back
                    </summary>
                    <ul>
                      {result.flagged.map((f, i) => (
                        <li key={i}>
                          <span className={`badge badge-${f.status}`}>{f.status === 'weak' ? 'partly' : 'not backed'}</span>{' '}
                          <span className="muted">{f.section}:</span> {f.claim}
                          {f.reason && <div className="muted small">{f.reason}</div>}
                        </li>
                      ))}
                    </ul>
                    <span className="muted small">Reword or remove these in the draft; their citations show amber or red there.</span>
                  </details>
                )}
                {result.violations.length > 0 ? (
                  <div className="finding-warn">
                    <p>
                      <b>It breaks what you ruled out:</b>
                    </p>
                    <ul>
                      {result.violations.map((v, i) => (
                        <li key={i}>
                          <b>{v.rule}</b> ({v.section}): {v.why}
                        </li>
                      ))}
                    </ul>
                    <button onClick={() => write(result.violations)}>Write it again without these</button>
                  </div>
                ) : (
                  limits.exclusions.trim() && <p className="ok small">Checked: it keeps to everything you ruled out.</p>
                )}
                <div className="proposal-novelty">
                  <button onClick={checkNovelty} disabled={!!busy}>
                    Has this been done?
                  </button>
                  <span className="muted small">Searches OpenAlex for published studies close to the first research question.</span>
                  {similar && similar.length === 0 && <p className="muted">Nothing close found.</p>}
                  {similar && similar.length > 0 && (
                    <ul>
                      {similar.slice(0, 8).map((w) => (
                        <li key={w.openalex_id}>
                          <b>{w.title}</b>{' '}
                          <span className="muted">
                            {[w.authors[0], w.year, w.venue].filter(Boolean).join(' · ')}
                            {w.cited_by_count != null ? ` · cited ${w.cited_by_count}` : ''}
                          </span>
                          {w.in_library != null && <em className="proposal-inlib"> in your library</em>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </section>
        )}

        <div className="mx-actions proposal-nav">
          {step !== 'gaps' && (
            <button onClick={back} disabled={!!busy}>
              ‹ Back
            </button>
          )}
          {step !== 'result' ? (
            <button className="primary" onClick={next} disabled={!canGo || !!busy || (step === 'variables' && !variables)}>
              {step === 'limits' ? 'Write the proposal' : 'Next ›'}
            </button>
          ) : (
            <>
              <button onClick={() => write([])} disabled={!!busy}>
                Write again
              </button>
              <button className="primary" disabled={!result || !!busy} onClick={() => result && onCreate(result)}>
                Open as a new draft
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
