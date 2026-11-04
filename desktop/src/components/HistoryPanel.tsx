import { useEffect, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { api } from '../api'
import type { ChangeStatus, Comparison, DiffOp, DraftVersion, VersionList } from '../types'
import { Meter, Ring, Segmented, ago } from './Meters'

type Level = 'document' | 'sections' | 'paragraphs'
const LEVELS: { value: Level; label: string }[] = [
  { value: 'document', label: 'Document' },
  { value: 'sections', label: 'Sections' },
  { value: 'paragraphs', label: 'Paragraphs' },
]
const STATUS_LABEL: Record<ChangeStatus, string> = { added: 'new', removed: 'removed', modified: 'edited', unchanged: 'same' }

interface Props {
  draftId: number
  list: VersionList | null
  onRefresh: () => Promise<void>
  getJSON: () => JSONContent | null
  getTitle: () => string
  onRestore: (content: string) => void
  /** Save pending edits in the editor now. */
  onFlush: () => Promise<void>
  onError: (msg: string) => void
}

function versionName(v: DraftVersion): string {
  return v.label || (v.kind === 'auto' ? 'Autosave' : 'Saved version')
}

function Diff({ ops }: { ops: DiffOp[] }) {
  return (
    <p className="diff">
      {ops.map(([op, text], i) => {
        const t = (i ? ' ' : '') + text
        return op === '+' ? <ins key={i}>{t}</ins> : op === '-' ? <del key={i}>{t}</del> : <span key={i}>{t}</span>
      })}
    </p>
  )
}

/** Version control for the draft: milestones and automatic snapshots, compared with the draft
 * (or each other) at document, section and paragraph level, each with a percentage changed. */
export function HistoryPanel({ draftId, list, onRefresh, getJSON, getTitle, onRestore, onFlush, onError }: Props) {
  const [naming, setNaming] = useState<string | null>(null) // label being typed for a new milestone
  const [filter, setFilter] = useState<'all' | 'milestone'>('all')
  const [selected, setSelected] = useState<DraftVersion | null>(null)
  const [against, setAgainst] = useState<number | 'current'>('current')
  const [level, setLevel] = useState<Level>('document')
  const [cmp, setCmp] = useState<Comparison | null>(null)
  const [showSame, setShowSame] = useState(false)
  const [confirm, setConfirm] = useState<{ id: number; what: 'restore' | 'delete' } | null>(null)
  const [renaming, setRenaming] = useState<{ id: number; label: string } | null>(null)

  const fail = (e: unknown) => onError(e instanceof Error ? e.message : String(e))

  useEffect(() => {
    onRefresh().catch(fail)
  }, [])

  // Re-run the comparison when the choice changes (and when the list refreshes after a save).
  useEffect(() => {
    if (!selected) return setCmp(null)
    let stale = false
    const to = against === 'current' ? { content: getJSON() } : { against }
    api
      .compareVersion(draftId, selected.id, to)
      .then((c) => !stale && setCmp(c))
      .catch(fail)
    return () => {
      stale = true
    }
  }, [selected?.id, against, list])

  async function saveMilestone() {
    const content = getJSON()
    if (!content) return
    try {
      await api.saveVersion(draftId, naming?.trim() || '', getTitle(), JSON.stringify(content))
      setNaming(null)
      await onRefresh()
    } catch (e) {
      fail(e)
    }
  }

  async function restore(v: DraftVersion) {
    try {
      // Save what was just typed first: it goes into the "before restoring" snapshot, and a save
      // still on its way can't land after the restore and overwrite it.
      await onFlush()
      const d = await api.restoreVersion(draftId, v.id)
      onRestore(d.content)
      setConfirm(null)
      setSelected(null)
      await onRefresh()
    } catch (e) {
      fail(e)
    }
  }

  async function remove(v: DraftVersion) {
    try {
      await api.deleteVersion(draftId, v.id)
      setConfirm(null)
      if (selected?.id === v.id) setSelected(null)
      await onRefresh()
    } catch (e) {
      fail(e)
    }
  }

  async function rename() {
    if (!renaming?.label.trim()) return setRenaming(null)
    try {
      await api.renameVersion(draftId, renaming.id, renaming.label.trim())
      setRenaming(null)
      await onRefresh()
    } catch (e) {
      fail(e)
    }
  }

  const versions = (list?.versions ?? []).filter((v) => filter === 'all' || v.kind === 'milestone')
  const latest = list?.versions[0]
  const targetName =
    against === 'current' ? 'current draft' : `v${list?.versions.find((v) => v.id === against)?.number ?? '?'}`

  return (
    <div className="history">
      <section className="hist-now">
        <Ring pct={list?.current_change ?? 0} caption="since last" size={68} />
        <div className="hist-now-text">
          <div className="hist-now-title">Current draft</div>
          <div className="muted">
            {list ? `${list.current_words.toLocaleString()} words` : 'Loading…'}
            {latest && ` · since v${latest.number} (${ago(latest.created_at)})`}
          </div>
          {naming == null ? (
            <button className="primary" onClick={() => setNaming('')}>Save a version</button>
          ) : (
            <form className="hist-name" onSubmit={(e) => (e.preventDefault(), saveMilestone())}>
              <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Name it, e.g. Sent to advisor" />
              <button className="primary">Save</button>
              <button type="button" onClick={() => setNaming(null)}>Cancel</button>
            </form>
          )}
        </div>
      </section>

      {selected && cmp && (
        <section className="hist-compare">
          <div className="hist-compare-head">
            <div>
              <div className="eyebrow">Comparing</div>
              <b>v{selected.number}</b> → {' '}
              <select value={against} onChange={(e) => setAgainst(e.target.value === 'current' ? 'current' : Number(e.target.value))}>
                <option value="current">current draft</option>
                {list?.versions.filter((v) => v.id !== selected.id).map((v) => (
                  <option key={v.id} value={v.id}>v{v.number} · {versionName(v)}</option>
                ))}
              </select>
            </div>
            <button className="icon" onClick={() => setSelected(null)} aria-label="Close comparison">×</button>
          </div>
          <Segmented label="Comparison level" value={level} options={LEVELS} onChange={setLevel} />

          {level === 'document' && (
            <div className="hist-doc">
              <Ring pct={cmp.document.change} caption="changed" />
              <div className="hist-doc-stats">
                <Meter label="Similarity" pct={cmp.document.similarity} tone="ok" />
                <div className="stat-row">
                  <span className="plus">+{cmp.document.added_words.toLocaleString()} words</span>
                  <span className="minus">−{cmp.document.removed_words.toLocaleString()} words</span>
                </div>
                <div className="muted">
                  {cmp.document.old_words.toLocaleString()} → {cmp.document.new_words.toLocaleString()} words
                </div>
                <div className="chip-row">
                  {(['modified', 'added', 'removed', 'unchanged'] as ChangeStatus[]).map((k) => (
                    <span key={k} className={`chg chg-${k}`}>{cmp.paragraph_counts[k]} {STATUS_LABEL[k]}</span>
                  ))}
                </div>
                <span className="muted">paragraphs</span>
              </div>
            </div>
          )}

          {level === 'sections' && (
            <ul className="hist-sections">
              {cmp.sections.map((s, i) => (
                <li key={i} className={`sec-${s.status}`} style={{ paddingLeft: 8 + Math.max(0, s.level - 1) * 12 }}>
                  <div className="sec-top">
                    <span className="sec-title">{s.title || 'Opening (before the first heading)'}</span>
                    <span className={`chg chg-${s.status}`}>{STATUS_LABEL[s.status]}</span>
                  </div>
                  <Meter pct={s.change} title={`${s.change}% of this section changed`} />
                </li>
              ))}
              {!cmp.sections.length && <li className="empty">Both versions are empty.</li>}
            </ul>
          )}

          {level === 'paragraphs' && (
            <div className="hist-paras">
              <label className="muted check">
                <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} /> Show unchanged paragraphs
              </label>
              {cmp.sections.map((s, i) => {
                const paras = s.paragraphs.filter((p) => showSame || p.status !== 'unchanged')
                if (!paras.length) return null
                return (
                  <div key={i}>
                    {s.title && <h4>{s.title}</h4>}
                    {paras.map((p, j) => (
                      <div key={j} className={`para-card para-${p.status}`}>
                        <div className="para-top">
                          <span className={`chg chg-${p.status}`}>{STATUS_LABEL[p.status]}</span>
                          {p.status === 'modified' && <span className="muted">{p.change}% changed</span>}
                        </div>
                        <Diff ops={p.ops} />
                      </div>
                    ))}
                  </div>
                )
              })}
              {cmp.document.change === 0 && <p className="empty">No changes between v{selected.number} and the {targetName}.</p>}
            </div>
          )}

          <div className="hist-compare-foot">
            {confirm?.id === selected.id && confirm.what === 'restore' ? (
              <>
                <span className="muted">Replace the draft with v{selected.number}? The current draft is kept as a version.</span>
                <button className="primary" onClick={() => restore(selected)}>Restore</button>
                <button onClick={() => setConfirm(null)}>Cancel</button>
              </>
            ) : (
              <button onClick={() => setConfirm({ id: selected.id, what: 'restore' })}>Restore v{selected.number}</button>
            )}
          </div>
        </section>
      )}

      <div className="hist-list-head">
        <h3>Versions</h3>
        <Segmented
          label="Show versions"
          value={filter}
          options={[{ value: 'all', label: 'All' }, { value: 'milestone', label: 'Milestones' }]}
          onChange={setFilter}
        />
      </div>
      {list && !versions.length && (
        <p className="empty">
          {filter === 'milestone'
            ? 'No milestones yet. Save a version to mark a point you may want to go back to.'
            : 'Versions appear as you write: one every 10 minutes of editing, one before any large edit, and any you save.'}
        </p>
      )}
      <ol className="timeline">
        {versions.map((v) => (
          <li key={v.id} className={`tl-item tl-${v.kind}${selected?.id === v.id ? ' on' : ''}`}>
            <span className="tl-dot" aria-hidden="true" />
            <div className="tl-body">
              <button className="tl-main" onClick={() => { setSelected(v); setAgainst('current') }} title="Compare with the current draft">
                <span className="tl-name">
                  <b>v{v.number}</b> {renaming?.id === v.id ? null : versionName(v)}
                </span>
                <span className="muted">{ago(v.created_at)} · {v.words.toLocaleString()} words</span>
              </button>
              {renaming?.id === v.id && (
                <form className="hist-name" onSubmit={(e) => (e.preventDefault(), rename())}>
                  <input autoFocus value={renaming.label} onChange={(e) => setRenaming({ ...renaming, label: e.target.value })} />
                  <button className="primary">Keep</button>
                  <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              )}
              {v.number > 1 ? (
                <div className="tl-meter" title={`${v.change}% changed since the version before`}>
                  <Meter pct={v.change} label="vs. previous" />
                </div>
              ) : (
                <div className="muted">First version</div>
              )}
              <div className="tl-actions">
                {confirm?.id === v.id && confirm.what === 'delete' ? (
                  <>
                    <button className="danger" onClick={() => remove(v)}>Delete</button>
                    <button onClick={() => setConfirm(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="link" onClick={() => { setSelected(v); setAgainst('current') }}>Compare</button>
                    {v.kind === 'auto' && (
                      <button className="link" onClick={() => setRenaming({ id: v.id, label: '' })} title="Name it to keep it as a milestone">
                        Keep
                      </button>
                    )}
                    <button className="link danger-link" onClick={() => setConfirm({ id: v.id, what: 'delete' })}>Delete</button>
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
