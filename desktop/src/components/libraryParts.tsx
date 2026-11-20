// Pieces of the Library that its front page (the topic folders) and its paper list both use:
// menus, the topic forms, the names of the ready-made views, and remembered choices.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Doc, Folder } from '../types'

export const KIND_LABEL: Record<Doc['kind'], string> = {
  pdf: 'PDF',
  docx: 'Doc',
  text: 'Notes',
  web: 'Web',
  pptx: 'Slides',
  image: 'Scan',
}

/** 'Okafor & Raman', 'Chen et al.': surnames, as a reference list shows them. */
export function authorsShort(d: { authors: string[] }): string {
  const surname = (a: string) => (a.includes(',') ? a.split(',')[0] : a.split(' ').pop() ?? a).trim()
  if (d.authors.length > 2) return `${surname(d.authors[0])} et al.`
  return d.authors.map(surname).join(' & ')
}

export type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>

/** The ready-made views: every source, the last two weeks' additions, what Muse drafts from, what the
 * open draft cites, records that need fixing, unread, starred, sources in no topic, and the removal log. */
export type View = 'all' | 'recent' | 'drafting' | 'cited' | 'needs' | 'unread' | 'starred' | 'none' | 'removed'
export type Scope = View | number // a view, or one topic

export function SimilaritySlider({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="sim">
      <span>Similarity</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        disabled={disabled}
        aria-label="Similarity threshold"
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <b>{value}%</b>
    </label>
  )
}

/** A topic is defined by the subject the user types and how closely a paper must match it. */
export function NewFolderForm({ initial, onCreate, onCancel }: {
  initial: number
  onCreate: (name: string, similarity: number) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [similarity, setSimilarity] = useState(initial)
  return (
    <form
      className="newfolder"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onCreate(name.trim(), similarity)
      }}
    >
      <div className="newfolder-title">New topic</div>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        placeholder="Subject, e.g. Digital finance"
        aria-label="Topic name"
      />
      <SimilaritySlider value={similarity} onChange={setSimilarity} />
      <p className="muted">
        Every paper that matches this subject at {similarity}% or more is filed here, and a paper can be in several topics. Lower it to take in looser matches, raise it to be stricter.
      </p>
      <div className="newfolder-actions">
        <button className="primary" disabled={!name.trim()}>
          Create topic
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Shown for an opened topic: its name, how closely a paper has to match to be filed here,
 * and renaming or deleting it. */
export function FolderBar({ folder, run, onWhatsNew }: { folder: Folder; run: Run; onWhatsNew?: (folderId: number) => void }) {
  const [value, setValue] = useState(folder.similarity)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const pending = useRef<number | undefined>(undefined)
  const latest = useRef({ folder, run, value })
  latest.current = { folder, run, value }
  const save = () => {
    pending.current = undefined
    const { folder: f, run: r, value: v } = latest.current
    if (v !== f.similarity) r('Re-filing…', () => api.updateFolder(f.id, { similarity: v }))
  }
  // Wait for the slider to settle (it can move many steps in a second) before re-filing.
  const change = (v: number) => {
    latest.current.value = v
    setValue(v)
    window.clearTimeout(pending.current)
    pending.current = window.setTimeout(save, 450)
  }
  useEffect(() => {
    if (pending.current === undefined) setValue(folder.similarity)
  }, [folder.similarity])
  useEffect(() => {
    setRenaming(false)
    setDeleting(false)
  }, [folder.id])
  useEffect(
    () => () => {
      if (pending.current !== undefined) {
        window.clearTimeout(pending.current)
        save()
      }
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )
  return (
    <div className="lib-folderbar">
      <div className="lib-folderbar-top">
        {renaming ? (
          <input
            autoFocus
            defaultValue={folder.name}
            aria-label="Topic name"
            onBlur={() => setRenaming(false)}
            onKeyDown={(e) => {
              const name = e.currentTarget.value.trim()
              if (e.key === 'Escape') setRenaming(false)
              if (e.key === 'Enter' && name) {
                setRenaming(false)
                run('Renaming…', () => api.updateFolder(folder.id, { name }))
              }
            }}
          />
        ) : (
          <b className="lib-folderbar-name" onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
            {folder.name}
          </b>
        )}
        <span className="spacer" />
        {deleting ? (
          <>
            <button className="danger" onClick={() => run('Deleting topic…', () => api.deleteFolder(folder.id))}>
              Delete topic
            </button>
            <button onClick={() => setDeleting(false)}>Keep</button>
          </>
        ) : (
          <>
            {onWhatsNew && (
              <button className="link" onClick={() => onWhatsNew(folder.id)} title="Recent works that cite this topic's papers and aren't in your library">
                What's new
              </button>
            )}
            <button className="link" onClick={() => setRenaming(true)}>Rename</button>
            <button className="link danger-link" onClick={() => setDeleting(true)} title="The sources stay in your library">
              Delete
            </button>
          </>
        )}
      </div>
      <SimilaritySlider value={value} onChange={change} />
      <span className="muted">Papers matching {value}% or more are filed here. What you add or remove by hand is kept.</span>
    </div>
  )
}

export function load<T>(key: string, fallback: T, ok: (v: unknown) => boolean): T {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return ok(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}
export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // no storage (a private window): the choice lasts until the app closes
  }
}

export type MenuItem =
  | { label: string; kbd?: string; count?: number; danger?: boolean; disabled?: boolean; checked?: boolean; keepOpen?: boolean; run: () => void }
  | { head: string }
  | 'sep'

/** A menu at a point on screen (a right-click, or under a button), kept inside the window. */
export function PopMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)),
    })
  }, [x, y])
  // The keyboard goes to the menu once it's placed and showing: while hidden it can't take it.
  const placed = pos !== null
  useLayoutEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  }, [placed])
  useDismiss(true, onClose, ref)
  const move = (dir: 1 | -1) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
    const at = all.indexOf(document.activeElement as HTMLElement)
    all[(at + dir + all.length) % all.length]?.focus()
  }
  /** A letter goes to the next choice with a word starting with it (a long list of authors or journals). */
  const jump = (letter: string) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
    const at = all.indexOf(document.activeElement as HTMLElement)
    const starts = (el: HTMLElement) =>
      (el.querySelector('.lib-pop-label')?.textContent ?? '').toLowerCase().split(/[\s,]+/).some((w) => w.startsWith(letter.toLowerCase()))
    ;[...all.slice(at + 1), ...all.slice(0, at + 1)].find(starts)?.focus()
  }
  return (
    <div
      ref={ref}
      className="lib-pop"
      role="menu"
      style={pos ?? { left: x, top: y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') (e.stopPropagation(), onClose())
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') (e.preventDefault(), move(e.key === 'ArrowDown' ? 1 : -1))
        else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) jump(e.key)
      }}
    >
      {items.map((item, i) =>
        item === 'sep' ? (
          <hr key={i} />
        ) : 'head' in item ? (
          <div key={i} className="lib-pop-head">{item.head}</div>
        ) : (
          <button
            key={i}
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            onClick={() => {
              if (!item.keepOpen) onClose()
              item.run()
            }}
          >
            {item.checked !== undefined && <span className="lib-pop-check" aria-hidden="true">{item.checked ? '✓' : ''}</span>}
            <span className="lib-pop-label">{item.label}</span>
            {item.count !== undefined && <span className="lib-pop-count">{item.count}</span>}
            {item.kbd && <kbd>{item.kbd}</kbd>}
          </button>
        ),
      )}
    </div>
  )
}

/** Naming a view: when it's saved, and when it's renamed. */
export function ViewNameForm({ initial, action, onDone, onCancel }: { initial: string; action: string; onDone: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial)
  return (
    <form
      className="lib-view-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onDone(name.trim())
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onCancel()
      }}
    >
      <input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} aria-label="Name of the view" placeholder="Name this view" />
      <button className="primary" disabled={!name.trim()}>{action}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  )
}

/** Closes a popup menu on a click outside `ref`. */
export function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close()
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, close, ref])
}

/** Two topics that hold (nearly) the same papers, the closest pair first; `into` is the one to keep. */
export function alikeTopics(docs: Doc[], folders: Folder[], kept: string[]) {
  const members = new Map<number, Set<number>>()
  for (const d of docs) for (const f of d.folders) (members.get(f.id) ?? members.set(f.id, new Set()).get(f.id)!).add(d.id)
  let best: { from: Folder; into: Folder; shared: number; total: number; key: string } | null = null
  for (let i = 0; i < folders.length; i++) {
    for (let j = i + 1; j < folders.length; j++) {
      const [a, b] = [members.get(folders[i].id), members.get(folders[j].id)]
      if (!a || !b || Math.min(a.size, b.size) < 2) continue
      const shared = [...a].filter((id) => b.has(id)).length
      const total = a.size + b.size - shared
      const key = `${Math.min(folders[i].id, folders[j].id)}-${Math.max(folders[i].id, folders[j].id)}`
      if (shared / total < 0.8 || kept.includes(key) || (best && shared / total <= best.shared / best.total)) continue
      // Keep the larger topic; of two the same size, the shorter name.
      const keepFirst = a.size !== b.size ? a.size > b.size : folders[i].name.length <= folders[j].name.length
      best = { from: folders[keepFirst ? j : i], into: folders[keepFirst ? i : j], shared, total, key }
    }
  }
  return best
}

export const VIEW_NAME: Record<View, string> = {
  all: 'All sources', recent: 'Recently added', drafting: 'Drafting from', cited: 'Cited in this draft', needs: 'Needs attention',
  unread: 'Unread', starred: 'Starred', none: 'Unfiled', removed: 'Removed',
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
