import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { CITATION_WORD, RETRACTED_WORD, isFlagged } from '../editor/citeStatus'
import type { CitationStatus, Doc, DraftSummary, HomeTodo, MissingWork } from '../types'
import { FetchActions, useFetcher } from './fetching'
import { Icon, type IconName } from './Icon'
import { ago } from './Meters'
import type { RetractedWhy } from './TrustBadges'
import type { ChipAttrs } from './WritingEditor'

interface Props {
  visible: boolean
  docs: Doc[]
  drafts: DraftSummary[]
  /** The draft open in Write: its citations are read live from the editor, not from its last save. */
  draftId: number
  chips: ChipAttrs[]
  retracted: Map<number, RetractedWhy>
  /** The sample library ships with the desktop app only. */
  canTrySamples: boolean
  onTrySamples: () => void
  onAddSources: () => void
  onWrite: () => void
  /** Open a draft in Write with Check showing, at one citation when `cid` is given. */
  onCheckDraft: (id: number, cid?: string) => void
  onOpenPaper: (id: number) => void
  onOpenMatrix: (id: number) => void
  /** Put a matrix's gap into the open draft, citing its papers. */
  onInsertGap: (findingId: number) => void
  onLibraryChanged: () => Promise<void>
}

/** One thing that needs the writer: what, why, and the button that does it. */
interface Item {
  id: string // stable while the thing it's about is unchanged, so Later and Not needed stick to it
  group: 'draft' | 'library' | 'idea'
  tone: 'warn' | 'bad' | 'miss' | 'read' | 'matrix' | 'idea'
  icon: IconName
  what: ReactNode
  plain: string // `what` as text, for the set-aside list
  why: ReactNode
  act: ReactNode
  more?: ReactNode
}

const LATER_KEY = 'gw.home.later' // item id -> the day it was set aside (it comes back the next day)
const DROPPED_KEY = 'gw.home.dropped' // item ids the writer said aren't needed
const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD, local

function readStore<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') ?? fallback
  } catch {
    return fallback
  }
}
function writeStore(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full or blocked: setting aside lasts until the app closes */
  }
}

const plural = (n: number, w: string, ws = `${w}s`) => `${n.toLocaleString()} ${n === 1 ? w : ws}`
const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n).trim()}…` : t)
const utc = (when: string) => Date.parse(when.replace(' ', 'T') + 'Z')
const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '')
const titleCase = (t: string) => (t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t)
/** A short stable fingerprint of a list of ids, so an item changes id when what it lists changes. */
const sig = (xs: (string | number)[]) => {
  let h = 0
  for (const ch of xs.join(',')) h = (h * 31 + ch.charCodeAt(0)) | 0
  return (h >>> 0).toString(36)
}

interface Flag {
  cid: string
  doc_id: number
  status: CitationStatus
  label: string
  claim: string
}

/** Home: what needs the writer, ranked, each with the button that does it. Things blocking the draft
 *  being worked on come first, then the rest of the library, then ideas for when there's time. */
export function HomeView(p: Props) {
  const { docs } = p
  const [todo, setTodo] = useState<HomeTodo | null>(null)
  const [picked, setPicked] = useState<number | null>(null) // the draft Home is about, when not the open one
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [later, setLater] = useState<Record<string, string>>(() => readStore(LATER_KEY, {}))
  const [dropped, setDropped] = useState<string[]>(() => readStore(DROPPED_KEY, []))
  const fetcher = useFetcher(p.onLibraryChanged)

  // Drafts that cite something, as saved, with the open one's citations read live from the editor.
  const live: Flag[] = useMemo(
    () =>
      p.chips
        .filter((c) => c.docId && (isFlagged(c.status) || p.retracted.has(c.docId)))
        .map((c) => ({ cid: c.cid, doc_id: c.docId, status: c.status, label: c.label, claim: c.claim })),
    [p.chips, p.retracted],
  )
  const citing = useMemo(() => {
    const saved = (todo?.drafts ?? []).filter((d) => d.id !== p.draftId)
    const openCited = [...new Set(p.chips.map((c) => c.docId).filter(Boolean))]
    const open = p.drafts.find((d) => d.id === p.draftId)
    const openOne = open && openCited.length ? [{ id: open.id, title: open.title, updated_at: open.updated_at ?? '', cited: openCited, flagged: live }] : []
    return [...openOne, ...saved.map((d) => ({ ...d, flagged: d.flagged.filter((f) => isFlagged(f.status)) }))]
  }, [todo, p.drafts, p.draftId, p.chips, live])
  // Retracted papers count against every draft citing them, whatever the quote's verdict.
  const flagsOf = (d: (typeof citing)[number]): Flag[] => {
    if (d.id === p.draftId) return d.flagged
    const seen = new Set(d.flagged.map((f) => f.cid))
    const retractedCites = d.cited.filter((id) => p.retracted.has(id)).map((id) => ({ cid: `retracted-${id}`, doc_id: id, status: 'verified' as CitationStatus, label: docs.find((x) => x.id === id)?.label ?? '', claim: '' }))
    return [...d.flagged, ...retractedCites.filter((f) => !seen.has(f.cid))]
  }

  const focusId = picked ?? (citing.some((d) => d.id === p.draftId) ? p.draftId : citing[0]?.id ?? p.draftId)
  const focus = citing.find((d) => d.id === focusId) ?? null
  const isOpen = focusId === p.draftId

  // Asked again when papers come or go (what's missing changes), not at every refresh of the library
  // list: marking a paper read or starring it gives a new list with the same papers.
  const papersKey = useMemo(() => sig(docs.map((d) => `${d.id}:${d.doi ?? ''}:${d.title}`)), [docs])
  useEffect(() => {
    if (!p.visible) return
    let current = true
    // A moment's wait, so what changes together asks once: at launch the library, the drafts and the
    // open draft's citations arrive one after another, and Home sent four requests in two seconds.
    const wait = window.setTimeout(() => {
      api.homeTodo(focusId).then((t) => current && setTodo(t)).catch(() => {})
    }, 150)
    return () => {
      current = false
      window.clearTimeout(wait)
    }
  }, [p.visible, focusId, papersKey])

  // Settings aside from another day come back.
  useEffect(() => {
    if (!p.visible) return
    const kept = Object.fromEntries(Object.entries(later).filter(([, day]) => day === today()))
    if (Object.keys(kept).length !== Object.keys(later).length) {
      setLater(kept)
      writeStore(LATER_KEY, kept)
    }
  }, [p.visible]) // eslint-disable-line react-hooks/exhaustive-deps

  const docsById = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs])
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))
  const setAside = (id: string) => {
    const next = { ...later, [id]: today() }
    setLater(next)
    writeStore(LATER_KEY, next)
  }
  const drop = (id: string) => {
    const next = [...new Set([...dropped, id])]
    setDropped(next)
    writeStore(DROPPED_KEY, next)
  }
  const bringBack = (id: string) => {
    const l = { ...later }
    delete l[id]
    setLater(l)
    writeStore(LATER_KEY, l)
    const d = dropped.filter((x) => x !== id)
    setDropped(d)
    writeStore(DROPPED_KEY, d)
  }

  const items: Item[] = []
  const go = (label: string, run: () => void) => (
    <button className="btn-go small" onClick={run}>
      {label}
    </button>
  )

  // The topics the focused draft draws on: folders several of its sources are filed in, a folder
  // weighing less the more of the whole library it holds (a catch-all folder says little).
  const topics = useMemo(() => {
    if (!focus) return []
    const size = new Map<number, number>()
    for (const d of docs) for (const f of d.folders) size.set(f.id, (size.get(f.id) ?? 0) + 1)
    const count = new Map<number, { id: number; name: string; n: number }>()
    for (const id of focus.cited)
      for (const f of docsById.get(id)?.folders ?? []) {
        const c = count.get(f.id) ?? { id: f.id, name: f.name, n: 0 }
        c.n++
        count.set(f.id, c)
      }
    const weight = (c: { id: number; n: number }) => c.n * Math.log((docs.length + 1) / (size.get(c.id) ?? 1))
    return [...count.values()].filter((c) => c.n >= 2).sort((a, b) => weight(b) - weight(a)).slice(0, 2)
  }, [focus, docs, docsById])

  if (focus) {
    // 1. Its citations a source doesn't fully back, or that cite a retracted paper
    const flags = flagsOf(focus)
    if (flags.length) {
      const allPartly = flags.every((f) => f.status === 'weak' && !p.retracted.has(f.doc_id))
      items.push({
        id: `cite:${focus.id}:${sig(flags.map((f) => f.cid))}`,
        group: 'draft',
        tone: allPartly ? 'warn' : 'bad',
        icon: 'alert',
        what: `${plural(flags.length, 'citation')} in this draft ${allPartly ? `${flags.length === 1 ? 'is' : 'are'} only partly backed by ${flags.length === 1 ? 'its source' : 'their sources'}` : flags.length === 1 ? 'needs attention' : 'need attention'}`,
        plain: `${plural(flags.length, 'citation')} to check in “${focus.title}”`,
        why: allPartly
          ? 'The source says something close, but not quite what the sentence claims. Reword the sentence or pick a better passage.'
          : 'A source doesn’t back what its sentence says, or the paper was retracted. Fix these before you share the draft.',
        act: go(flags.length === 1 ? 'Check it' : 'Check them', () => p.onCheckDraft(focus.id)),
        more: flags.map((f) => (
          <div className="desk-sub" key={f.cid}>
            <div>
              <span className={`desk-tag ${f.status === 'weak' && !p.retracted.has(f.doc_id) ? 'warn' : 'bad'}`}>
                {p.retracted.has(f.doc_id) ? RETRACTED_WORD : CITATION_WORD[f.status]}
              </span>
              {f.claim && <q>{short(f.claim, 160)}</q>}
              <small>{f.label}</small>
            </div>
            <button className="link" onClick={() => p.onCheckDraft(focus.id, f.cid.startsWith('retracted-') ? undefined : f.cid)}>
              Open in Check ›
            </button>
          </div>
        )),
      })
    }

    // 2. Works several of its sources build on that the library doesn't have
    const seen = new Set<string>()
    const missing = (todo?.missing ?? []).filter((w) => {
      const k = titleKey(w.title)
      return !seen.has(k) && !!seen.add(k)
    })
    for (const w of missing.slice(0, 2)) items.push(missingItem(w, focus))

    // 3. Unread papers in its topics
    if (topics.length) {
      const inTopic = new Set(topics.map((t) => t.id))
      const cited = new Set(focus.cited)
      const unread = docs
        .filter((d) => d.unread && !cited.has(d.id) && d.folders.some((f) => inTopic.has(f.id)))
        .sort((a, b) => utc(b.added_at) - utc(a.added_at))
      if (unread.length) {
        const names = topics.map((t) => t.name).join(' and ')
        items.push({
          id: `read:${focus.id}:${unread[0].id}:${unread.length}`,
          group: 'draft',
          tone: 'read',
          icon: 'unread',
          what: `${plural(unread.length, 'unread paper')} in ${names}`,
          plain: `${plural(unread.length, 'unread paper')} in ${names}`,
          why: `The ${topics.length === 1 ? 'topic' : 'topics'} most of this draft’s sources come from. The newest arrived ${ago(unread[0].added_at)}.`,
          act: go('Read the newest', () => p.onOpenPaper(unread[0].id)),
          more: unread.slice(0, 6).map((d) => (
            <div className="desk-sub" key={d.id}>
              <div>
                {d.title}
                <small>{[d.year, `added ${ago(d.added_at)}`].filter(Boolean).join(' · ')}</small>
              </div>
              <button className="link" onClick={() => p.onOpenPaper(d.id)}>
                Open ›
              </button>
            </div>
          )),
        })
      }
    }
  }

  function missingItem(w: MissingWork, d: { id: number; cited: number[] }): Item {
    const state = fetcher.results[w.id] ?? null
    const who = w.first_author ? ` (${w.first_author}${w.year ? ` ${w.year}` : ''})` : ''
    return {
      id: `miss:${w.id}`,
      group: 'draft',
      tone: 'miss',
      icon: 'source',
      what: (
        <>
          Add <em>{titleCase(short(w.title, 110))}</em>
          {who}
        </>
      ),
      plain: `Add “${short(w.title, 80)}”`,
      why: `${w.cited_by} of the ${d.cited.length} sources this draft cites build on it. It isn’t in your library.`,
      act: (
        <FetchActions
          state={state}
          searchable={!!w.doi || w.title.trim().split(/\s+/).length >= 4}
          searchFor={`${w.title} ${w.first_author}`}
          disabled={state === 'working'}
          fetchLabel="Find a free copy"
          doi={w.doi}
          onFetch={() => fetcher.fetchOne({ key: w.id, docId: w.ref.doc_id, idx: w.ref.idx })}
          onOpenPaper={p.onOpenPaper}
        />
      ),
      more: (
        <div className="desk-sub">
          <div>
            Cited by these sources of this draft:
            {w.citers.map((c) => (
              <small key={c.id}>{c.title}</small>
            ))}
          </div>
        </div>
      ),
    }
  }

  // 4. Other drafts with citations to check
  const others = citing.filter((d) => d.id !== focusId).map((d) => ({ d, flags: flagsOf(d) })).filter((x) => x.flags.length)
  if (others.length) {
    const total = others.reduce((n, x) => n + x.flags.length, 0)
    const id = `other:${focusId}:${sig(others.flatMap((x) => x.flags.map((f) => f.cid)))}`
    items.push({
      id,
      group: 'library',
      tone: 'warn',
      icon: 'alert',
      what: `${plural(total, 'citation')} to check in ${plural(others.length, 'other draft')}`,
      plain: `${plural(total, 'citation')} to check in other drafts`,
      why: 'Citations a source doesn’t fully back, in drafts you aren’t working on right now.',
      act: go(others.length === 1 ? 'Check them' : 'Show them', () => (others.length === 1 ? p.onCheckDraft(others[0].d.id) : toggle(id))),
      more: others.map(({ d, flags }) => (
        <div className="desk-sub" key={d.id}>
          <div>
            {d.title || 'Untitled'}
            <small>
              {plural(flags.length, 'citation')} to check{d.updated_at ? ` · edited ${ago(d.updated_at)}` : ''}
            </small>
          </div>
          <button className="link" onClick={() => p.onCheckDraft(d.id)}>
            Open in Check ›
          </button>
        </div>
      )),
    })
  }

  // 5. Matrix answers whose quote isn't in the paper: the one closest to the draft's topics first
  const near = (name: string) => topics.some((t) => t.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(t.name.toLowerCase()))
  const toVerify = (todo?.matrices ?? []).filter((m) => m.unverified > 0).sort((a, b) => Number(near(b.name)) - Number(near(a.name)) || b.unverified - a.unverified)
  if (toVerify.length) {
    const m = toVerify[0]
    items.push({
      id: `matrix:${m.id}:${m.unverified}`,
      group: 'library',
      tone: 'matrix',
      icon: 'matrix',
      what: `${plural(m.unverified, 'answer')} in the ${m.name} matrix ${m.unverified === 1 ? 'quotes' : 'quote'} words the paper doesn’t contain`,
      plain: `${plural(m.unverified, 'answer')} to check in the ${m.name} matrix`,
      why: 'Muse wrote them, but the quoted words weren’t found in the paper. Confirm or correct each before you cite the matrix.',
      act: go('Review them', () => p.onOpenMatrix(m.id)),
      more:
        toVerify.length > 1
          ? toVerify.slice(1).map((x) => (
              <div className="desk-sub" key={x.id}>
                <div>
                  {x.name} matrix<small>{plural(x.unverified, 'answer')} with a quote not found · {plural(x.papers, 'paper')}</small>
                </div>
                <button className="link" onClick={() => p.onOpenMatrix(x.id)}>
                  Open ›
                </button>
              </div>
            ))
          : undefined,
    })
  }

  // 6. Retracted papers in the library
  for (const d of docs.filter((x) => p.retracted.has(x.id))) {
    const by = citing.filter((x) => x.cited.includes(d.id))
    items.push({
      id: `retracted:${d.id}:${by.length}`,
      group: 'library',
      tone: 'bad',
      icon: 'alert',
      what: (
        <>
          A paper in your library is retracted: <em>{short(d.title.replace(/^RETRACTED:\s*/i, ''), 110)}</em>
        </>
      ),
      plain: `Retracted: “${short(d.title, 80)}”`,
      why: by.length
        ? `${plural(by.length, 'draft cites', 'drafts cite')} it. Check flags those citations; replace them with another source.`
        : 'None of your drafts cite it. If one does, Check flags the citation.',
      act: go('Open it', () => p.onOpenPaper(d.id)),
    })
  }

  // 7. A gap a matrix found, to write about
  const gapMatrix = (todo?.matrices ?? []).filter((m) => m.gaps.length).sort((a, b) => Number(near(b.name)) - Number(near(a.name)))[0]
  if (gapMatrix) {
    const gaps = gapMatrix.gaps.filter((g) => !dropped.includes(`gap:${g.id}`) && !later[`gap:${g.id}`])
    const g = gaps[0]
    if (g)
      items.push({
        id: `gap:${g.id}`,
        group: 'idea',
        tone: 'idea',
        icon: 'idea',
        what: (
          <>
            Write about a gap: <em>{g.title}</em>
          </>
        ),
        plain: `Write about “${g.title}”`,
        why: `The ${gapMatrix.name} matrix found it across ${plural(gapMatrix.papers, 'paper')}. ${isOpen ? 'Adding it puts a sentence in this draft that cites them, checked against the matrix.' : 'Open this draft to add it, or see it in the matrix.'}`,
        act: isOpen ? go('Add to this draft', () => p.onInsertGap(g.id)) : go('Open the matrix', () => p.onOpenMatrix(gapMatrix.id)),
        more:
          gaps.length > 1
            ? gaps.slice(1).map((x) => (
                <div className="desk-sub" key={x.id}>
                  <div>{x.title}</div>
                  {isOpen && (
                    <button className="link" onClick={() => p.onInsertGap(x.id)}>
                      Add to this draft ›
                    </button>
                  )}
                </div>
              ))
            : undefined,
      })
  }

  const shown = items.filter((it) => !later[it.id] && !dropped.includes(it.id))
  const aside = items.filter((it) => later[it.id] || dropped.includes(it.id))
  const groups: [Item['group'], string, string?][] = [
    ['draft', 'For this draft', 'what blocks it, first'],
    ['library', 'Across your library'],
    ['idea', 'When you have time'],
  ]
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const choices = citing.some((d) => d.id === p.draftId) ? citing : [...p.drafts.filter((d) => d.id === p.draftId).map((d) => ({ id: d.id, title: d.title })), ...citing]

  return (
    <div className="home desk" aria-label="Home">
      <div className="desk-col">
        <div className="desk-date">{date}</div>
        <div className="desk-head">
          <h1>
            {!docs.length ? (
              <b>Nothing needs you yet</b>
            ) : shown.length ? (
              <>
                <b>What needs you</b> <span className="desk-n">· {shown.length}</span>
              </>
            ) : (
              <b>All caught up</b>
            )}
          </h1>
          {choices.length > 1 && (
            <label className="desk-working">
              Working on
              <select value={focusId} onChange={(e) => setPicked(Number(e.target.value))}>
                {choices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {short(d.title || 'Untitled', 60)}
                    {d.id === p.draftId ? ' (open)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {!docs.length ? (
          <div className="desk-empty">
            <p>Add your papers, and Home lists what needs you: citations to fix, papers your sources build on that you don’t have, and what to read next.</p>
            <div className="desk-pair">
              <button className="btn-go" onClick={p.onAddSources}>
                Add sources <span className="ar">›</span>
              </button>
              {p.canTrySamples && (
                <button className="btn-go quiet" onClick={p.onTrySamples}>
                  Try the sample library
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {groups.map(([g, title, hint]) => {
              const rows = shown.filter((it) => it.group === g)
              if (!rows.length) return null
              return (
                <section key={g}>
                  <h2 className="desk-h">
                    {title} {g === 'draft' && focus && <small>{short(focus.title || 'Untitled', 70)}</small>}
                    {hint && <small className="desk-hint">{hint}</small>}
                  </h2>
                  <ul className="desk-list">
                    {rows.map((it) => (
                      <li key={it.id} className={`desk-row${open.has(it.id) ? ' open' : ''}`}>
                        <span className={`desk-kind ${it.tone}`} aria-hidden="true">
                          <Icon name={it.icon} size={15} />
                        </span>
                        <div className="desk-body">
                          <span className="desk-what">{it.what}</span>
                          <div className="desk-why">{it.why}</div>
                          {it.more && (
                            <button className="link desk-toggle" aria-expanded={open.has(it.id)} onClick={() => toggle(it.id)}>
                              {open.has(it.id) ? 'Hide details' : 'Show details'}
                            </button>
                          )}
                        </div>
                        <div className="desk-acts">
                          {it.act}
                          <button className="icon" title="Later: hide it until tomorrow" aria-label="Later" onClick={() => setAside(it.id)}>
                            <Icon name="clock" size={16} />
                          </button>
                          <button className="icon" title="Not needed: don’t show it again" aria-label="Not needed" onClick={() => drop(it.id)}>
                            <Icon name="close" size={16} />
                          </button>
                        </div>
                        {it.more && open.has(it.id) && <div className="desk-more">{it.more}</div>}
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
            {!shown.length && (
              <div className="desk-empty center">
                <p className="desk-big">Nothing needs you right now.</p>
                <p>Your citations are checked and nothing new has come in. New things show up here as they happen.</p>
                <div className="desk-pair">
                  <button className="btn-go" onClick={p.onWrite}>
                    Continue writing <span className="ar">›</span>
                  </button>
                </div>
              </div>
            )}
            {aside.length > 0 && (
              <details className="desk-aside">
                <summary>{plural(aside.length, 'item')} set aside</summary>
                <ul>
                  {aside.map((it) => (
                    <li key={it.id}>
                      {later[it.id] ? 'Later' : 'Not needed'}: {it.plain}
                      <button className="link" onClick={() => bringBack(it.id)}>
                        Bring back
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  )
}
