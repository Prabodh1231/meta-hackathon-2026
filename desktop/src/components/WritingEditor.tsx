import { forwardRef, useEffect, useImperativeHandle, useRef, useSyncExternalStore } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { TableKit } from '@tiptap/extension-table'
import { Extension, type Editor, type JSONContent } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { CitationNode } from '../editor/citation'
import { CiteMarkNode, stateOf, stateSoFar, unfinished, type CiteMarkAttrs } from '../editor/citeMark'
import { ReviewMarks, findInBlock, setReviewMarks, textBlocks, type ReviewRange } from '../editor/reviewMarks'
import { MUSE_META, MuseMark, insertMuse } from '../editor/museMark'
import { FormatToolbar } from './FormatToolbar'
import { ChipCard } from './ChipCard'
import { api } from '../api'
import type { Citation, DraftSentence, Suggestion } from '../types'

const MISSING_REASON = 'This passage is no longer in your library.'

/** Update chips and cite markers by cid. Not an undo step: these are the app's findings, and
 * Ctrl+Z should undo the writer's own edits, not a colour change that arrived meanwhile. */
function patchChips(editor: Editor, patches: Map<string, Partial<ChipAttrs> | Partial<CiteMarkAttrs>>) {
  const { state, view } = editor
  let tr = state.tr
  let changed = false
  state.doc.descendants((node, pos) => {
    const patch = node.type.name === 'citation' || node.type.name === 'citeMark' ? patches.get(node.attrs.cid) : undefined
    if (!patch || Object.entries(patch).every(([k, v]) => node.attrs[k] === v)) return
    tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch })
    changed = true
  })
  if (changed) view.dispatch(tr.setMeta('addToHistory', false))
}

/** Position of the node with this cid, if it's still in the document. */
function findCid(editor: Editor, cid: string): number | null {
  let found: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (found != null) return false
    if ((node.type.name === 'citeMark' || node.type.name === 'citation') && node.attrs.cid === cid) found = pos
  })
  return found
}

function citeMarks(editor: Editor): CiteMarkAttrs[] {
  const out: CiteMarkAttrs[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'citeMark') out.push(node.attrs as CiteMarkAttrs)
  })
  return out
}

// Background searches for cite markers: a few at a time (each runs several Muse checks), and
// never two for the same marker.
const MAX_SEARCHES = 3
let activeSearches = 0
const waitingSearches: (() => void)[] = []
const searching = new Map<string, Promise<void>>()

// The markers whose search is running now (not waiting for a turn), for Check.
let checking: ReadonlySet<string> = new Set()
const checkingListeners = new Set<() => void>()
function setChecking(cid: string, on: boolean) {
  const next = new Set(checking)
  if (on) next.add(cid)
  else next.delete(cid)
  checking = next
  checkingListeners.forEach((l) => l())
}
/** Cite markers being checked at this moment; the others still searching are waiting their turn. */
export function useCheckingMarkers(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      checkingListeners.add(l)
      return () => checkingListeners.delete(l)
    },
    () => checking,
  )
}

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (activeSearches >= MAX_SEARCHES) await new Promise<void>((r) => waitingSearches.push(r))
  activeSearches++
  try {
    return await fn()
  } finally {
    activeSearches--
    waitingSearches.shift()?.()
  }
}

/** Re-find chips' quotes in the library as it is now (files may have been re-added since
 * the draft was written) and update their location, page label and chunk. Chips whose
 * passage is gone are marked so the writer sees it. */
async function repairChips(editor: Editor, only?: ChipAttrs[]): Promise<Map<string, Partial<ChipAttrs>>> {
  let chips = only
  if (!chips) {
    const seen = new Map<string, ChipAttrs>()
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'citation' && node.attrs.cid) seen.set(node.attrs.cid, node.attrs as ChipAttrs)
    })
    chips = [...seen.values()]
  }
  const patches = new Map<string, Partial<ChipAttrs>>()
  chips = chips.filter((c) => c.quote) // a gap's citations name whole papers: there's no passage to find
  if (!chips.length) return patches
  const resolved = await api.resolveCitations(chips.map((c) => ({ doc_id: c.docId, page: c.page, quote: c.quote })))
  chips.forEach((c, i) => {
    const r = resolved[i]
    patches.set(
      c.cid,
      r
        ? { docId: r.doc_id, chunkId: r.chunk_id, page: r.page, start: r.start, end: r.end, label: r.label }
        : { status: 'quote_not_found', reason: MISSING_REASON },
    )
  })
  patchChips(editor, patches)
  return patches
}

export interface ChipAttrs {
  cid: string
  chunkId: number
  docId: number
  page: number
  start: number | null
  end: number | null
  quote: string
  claim: string
  label: string
  status: Citation['status']
  reason: string
  /** Written from a review matrix: the kept finding it's checked against (see Citation.finding). */
  finding: number | null
}

/** What a "Recheck all citations" run did. `checked` holds each chip's new attributes. */
export interface RecheckSummary {
  citations: number
  verified: number
  flagged: number // weak, unsupported or quote not found
  failed: number // the check didn't finish; the chip keeps its earlier result
  markers: number
  checked: Map<string, Partial<ChipAttrs>>
}

/** Live numbers for the status dock. */
export interface DraftStats {
  words: number
  citations: number
  verified: number
  flagged: number // weak, unsupported or quote not found
  unconfirmed: number // cite markers waiting for the writer to pick a source
  chips: ChipAttrs[] // the citation chips, in document order, for Check
}

export type SaveState = { state: 'idle' | 'saving' | 'saved' | 'error'; at?: number }

function statsOf(editor: Editor): DraftStats {
  const s: DraftStats = { words: 0, citations: 0, verified: 0, flagged: 0, unconfirmed: 0, chips: [] }
  s.words = (editor.getText().match(/\w+(?:['’-]\w+)*/g) ?? []).length
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'citeMark') s.unconfirmed++
    if (node.type.name !== 'citation') return
    s.citations++
    s.chips.push(node.attrs as ChipAttrs)
    if (node.attrs.status === 'verified') s.verified++
    else if (node.attrs.status !== 'pending') s.flagged++
  })
  return s
}

export interface WritingEditorHandle {
  /** Insert sentences with their citations; `muse` marks them as Muse's writing (not a quote's own words). */
  insertDraft: (sentences: DraftSentence[], opts?: { muse?: boolean }) => void
  updateCitation: (cid: string, patch: Partial<ChipAttrs>) => void
  /** Bring one chip up to date with the library and return its current attributes. */
  resolveChip: (chip: ChipAttrs) => Promise<ChipAttrs>
  getText: () => string
  /** The selected text, and the paragraph the cursor is in. */
  getFocus: () => { selection: string; paragraph: string }
  getJSON: () => JSONContent | null
  /** First non-empty line, used as the draft's title. */
  getTitle: () => string
  citedDocIds: () => number[]
  /** Turn a cite marker into a citation of the chosen source. False if the marker is gone. */
  confirmCite: (cid: string, c: Citation) => boolean
  /** Search again for a marker, for its sentence as it reads now. */
  recheckCite: (cid: string) => void
  /** Check every citation again against its sentence as it reads now (after finding its
   * quote in the library as it is now), and search again for every cite marker. */
  recheckAll: () => Promise<RecheckSummary>
  /** Check one citation again, for its sentence as it reads now: against its review matrix (with
   * the other citations of that sentence from the same finding), or against its own quote. */
  checkCitation: (cid: string, how: 'matrix' | 'quote') => Promise<Partial<ChipAttrs> | null>
  removeCite: (cid: string) => void
  /** Select a marker and scroll it into view. */
  showCite: (cid: string) => void
  /** Save pending edits now (before switching to another draft). */
  flush: () => Promise<void>
  /** Insert a whole document (an imported Word file) at the cursor; it fills an empty draft. */
  insertDocument: (json: JSONContent) => void
  /** Insert HTML (a chat reply, Muse's) at the cursor, or at the end if the page wasn't clicked into. */
  insertHTML: (html: string) => void
  isEmpty: () => boolean
  focus: () => void
  /** Replace the whole document (restoring a version). */
  setContent: (json: string) => void
  /** Scroll to a text block (numbered as the backend numbers them) and select `text` in it. */
  reveal: (block: number, text?: string) => void
  /** Underline passages found by the duplication check; an empty list clears them. */
  markReview: (marks: { block: number; text: string; kind: ReviewRange['kind']; title?: string }[]) => void
}

function titleOf(editor: Editor): string {
  return (editor.getText().split('\n').find((l) => l.trim()) ?? 'Untitled').trim().slice(0, 80)
}

let nextCid = 0

function chipFromCitation(c: Citation, claim: string): ChipAttrs {
  return {
    cid: c.cid ?? `c${Date.now()}-${nextCid++}`,
    chunkId: c.chunk_id,
    docId: c.doc_id,
    page: c.page,
    start: c.start,
    end: c.end,
    quote: c.quote,
    claim,
    label: c.label,
    status: c.status,
    reason: c.reason,
    finding: c.finding ?? null,
  }
}

const LEAF = '￼' // stands in for a chip so text offsets line up with document positions

/** The sentence just before `pos` in its paragraph (what a cite marker there is citing now). */
function sentenceBefore(editor: Editor, pos: number): string {
  const $pos = editor.state.doc.resolve(pos)
  if (!$pos.parent.isTextblock) return ''
  const text = editor.state.doc.textBetween($pos.start(), pos, ' ', LEAF).split(LEAF).join('')
  const sentences = text.match(/[^.!?]+[.!?]*["')\]]*/g) ?? []
  return (sentences.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).at(-1) ?? '').trim()
}

/** The sentence a chip at `pos` cites now: the one it was made for while that's still in its
 * paragraph (a matrix cell's whole answer, say), else the sentence just before it, or with
 * `paragraph` (a gap, which cites the matrix for all it says) the paragraph's text up to it. */
function claimAt(editor: Editor, pos: number, stored: string, paragraph = false): string {
  const $pos = editor.state.doc.resolve(pos)
  if (!$pos.parent.isTextblock) return stored
  const norm = (t: string) => t.split(LEAF).join('').replace(/\s+/g, ' ').trim()
  const para = norm(editor.state.doc.textBetween($pos.start(), $pos.end(), ' ', LEAF))
  if (stored && para.includes(norm(stored))) return stored
  if (paragraph) return norm(editor.state.doc.textBetween($pos.start(), pos, ' ', LEAF)) || stored
  return sentenceBefore(editor, pos) || stored
}

/** The text to cite and where its chip goes: the selection, or else the sentence around
 * the cursor. Null when there's no text there. */
function citeTarget(editor: Editor): { claim: string; pos: number } | null {
  const { doc, selection } = editor.state
  const clean = (s: string) => s.split(LEAF).join('').replace(/\s+/g, ' ').trim()
  if (!selection.empty) {
    const claim = clean(doc.textBetween(selection.from, selection.to, ' ', LEAF))
    return claim ? { claim, pos: selection.to } : null
  }
  const $pos = selection.$from
  if (!$pos.parent.isTextblock) return null
  const start = $pos.start()
  const text = doc.textBetween(start, $pos.end(), ' ', LEAF)
  const offset = $pos.parentOffset
  for (const m of text.matchAll(/[^.!?]*(?:[.!?]+["')\]]*|$)/g)) {
    const s = m.index ?? 0
    const e = s + m[0].length
    if (s <= offset && offset <= e && clean(m[0])) return { claim: clean(m[0]), pos: start + e }
  }
  return null
}

interface Props {
  draftId: number
  /** Shown above the page, e.g. the getting-started steps. */
  banner?: React.ReactNode
  /** Underline misspelled words (Settings). */
  spellcheck?: boolean
  onStats?: (stats: DraftStats) => void
  onSaveState?: (s: SaveState) => void
  onCitationClick: (chip: ChipAttrs) => void
  /** A cite marker was clicked: show what its search found. */
  onCiteMarkClick: (cid: string) => void
  /** The draft's cite markers, whenever they change (added, recoloured, confirmed, removed). */
  onCiteMarks?: (marks: CiteMarkAttrs[]) => void
  /** The sources cite searches look in (the ticked ones), or null for the whole library. */
  getScope: () => number[] | null
  /** The toolbar's Ask Muse button: ask about the selection in Compose's chat. */
  onAsk: () => void
  onError: (msg: string) => void
}

export const WritingEditor = forwardRef<WritingEditorHandle, Props>(function WritingEditor(
  { draftId, banner, spellcheck = true, onCitationClick, onCiteMarkClick, onCiteMarks, getScope, onAsk, onError, onStats, onSaveState },
  ref,
) {
  const saveTimer = useRef<number | undefined>(undefined)
  const draftRef = useRef(draftId) // the draft the editor is showing; saves go here
  const statsTimer = useRef<number | undefined>(undefined)
  const report = useRef({ onStats, onSaveState, onCiteMarks })
  report.current = { onStats, onSaveState, onCiteMarks }
  const loaded = useRef(false)
  const clickRef = useRef({ chip: onCitationClick, mark: onCiteMarkClick })
  clickRef.current = { chip: onCitationClick, mark: onCiteMarkClick }
  const scopeRef = useRef(getScope)
  scopeRef.current = getScope
  const citeRef = useRef<() => void>(() => {})
  const placed = useRef(false) // the writer has put the cursor somewhere since the draft opened
  const placedBefore = useRef(false) // `placed` as it was before the latest mousedown focused the editor
  const editorRef = useRef<Editor | null>(null)

  /** Find sources for a marker's sentence in the background, then recolour the marker. */
  function searchFor(cid: string, claim: string): Promise<void> {
    const already = searching.get(cid)
    if (already) return already
    let sofar: Suggestion[] = [] // what has come back, should the rest never arrive
    const run = limited(() => {
      setChecking(cid, true)
      // Each check's verdict as it arrives: the marker turns green on the first supported
      // candidate instead of waiting for the slowest check.
      return api.suggestCitationsStream(claim, scopeRef.current(), (results) => {
        sofar = results
        if (editorRef.current) patchChips(editorRef.current, new Map([[cid, { state: stateSoFar(results), results, claim }]]))
      })
    })
      .then((results) => {
        // The writer may have moved to another draft meanwhile: then this marker isn't in the
        // editor, stays "searching" in its draft, and is searched again when that draft opens.
        if (editorRef.current) patchChips(editorRef.current, new Map([[cid, { state: stateOf(results), results, claim }]]))
      })
      .catch(() => {
        // Cut off part-way: keep a supported source that was already found, and drop the
        // candidates whose checks never came back.
        const checked = sofar.filter((r) => r.status !== 'pending')
        const found = checked.some((r) => r.status === 'verified')
        const patch = found ? { state: 'verified' as const, results: checked } : { state: 'error' as const, results: [] }
        if (editorRef.current) patchChips(editorRef.current, new Map([[cid, patch]]))
      })
      .finally(() => {
        searching.delete(cid)
        setChecking(cid, false)
      })
    searching.set(cid, run)
    return run
  }

  /** Check a sentence written from a review matrix against that matrix, and recolour its chips. */
  /** Checked against the rows of the studies the sentence's citations name (`chips`), not the whole review. */
  async function checkAgainstMatrix(finding: number, claim: string, chips: ChipAttrs[]): Promise<Partial<ChipAttrs>> {
    const cids = chips.map((c) => c.cid)
    const v = await api.checkFinding(finding, claim, [...new Set(chips.map((c) => c.docId))])
    const patch = { status: v.status, reason: v.reason }
    if (editorRef.current) patchChips(editorRef.current, new Map(cids.map((cid) => [cid, patch])))
    return patch
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      TextStyle,
      FontFamily,
      FontSize,
      CitationNode,
      CiteMarkNode,
      ReviewMarks,
      MuseMark,
      // Tables come in from a review matrix (cells that cite their quotes); edited as text.
      TableKit.configure({ table: { resizable: false } }),
      Extension.create({
        name: 'citeShortcut',
        addKeyboardShortcuts: () => ({ 'Mod-Shift-c': () => (citeRef.current(), true) }),
      }),
    ],
    onFocus: () => {
      placed.current = true
    },
    content: '',
    editorProps: {
      attributes: { class: 'prose', spellcheck: 'true' },
      handleDOMEvents: {
        mousedown: () => {
          placedBefore.current = placed.current
          return false
        },
      },
      // Clicking a marker or a citation focuses the editor but leaves the cursor where it was, so
      // it doesn't count as placing it: an insert still goes to the end, not above the title.
      handleClickOn: (_view, _pos, node) => {
        if (node.type.name === 'citeMark') {
          placed.current = placedBefore.current
          clickRef.current.mark(node.attrs.cid)
          return true
        }
        if (node.type.name !== 'citation') return false
        placed.current = placedBefore.current
        clickRef.current.chip(node.attrs as ChipAttrs)
        return true
      },
    },
    onUpdate: ({ editor }) => {
      window.clearTimeout(statsTimer.current)
      statsTimer.current = window.setTimeout(() => {
        report.current.onStats?.(statsOf(editor))
        report.current.onCiteMarks?.(citeMarks(editor))
      }, 250)
      if (!loaded.current) return
      window.clearTimeout(saveTimer.current)
      report.current.onSaveState?.({ state: 'saving' })
      saveTimer.current = window.setTimeout(() => save(editor), 800)
    },
  })

  // Saves go out one at a time. Two in flight could finish in either order, and an older
  // copy landing last would overwrite newer text on the server.
  const saving = useRef<Promise<void>>(Promise.resolve())

  function save(e: Editor): Promise<void> {
    saveTimer.current = undefined
    const id = draftRef.current
    const title = titleOf(e)
    const content = JSON.stringify(e.getJSON())
    const next = saving.current.then(() =>
      api
        .saveDraft(id, title, content)
        .then(() => {
          // A later edit already queued its own save: stay on "Saving…" until that one lands.
          if (saveTimer.current === undefined && saving.current === next) report.current.onSaveState?.({ state: 'saved', at: Date.now() })
        })
        .catch((err) => {
          report.current.onSaveState?.({ state: 'error' })
          onError(`Could not save the draft: ${err instanceof Error ? err.message : err}`)
        }),
    )
    saving.current = next
    return next
  }

  /** Show other content as if freshly opened: no update event, and an empty undo history, so
   * Ctrl+Z can't bring back the text of the draft that was showing before. */
  function replaceContent(e: Editor, json: JSONContent | string) {
    e.chain().command(({ tr }) => (tr.setMeta(MUSE_META, true), true)).setContent(json, { emitUpdate: false }).run()
    const { state } = e
    e.view.updateState(EditorState.create({ schema: state.schema, doc: state.doc, plugins: state.plugins }))
  }

  useEffect(() => {
    if (!editor) return
    let cancelled = false
    // A save still waiting for this draft would land on the next one: App flushes before
    // switching, so anything left here is dropped.
    window.clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    loaded.current = false
    placed.current = false
    draftRef.current = draftId
    ;(async () => {
      // Keep retrying while the backend starts. Autosave stays off until the stored draft
      // has loaded, or the first keystroke into an empty editor would overwrite it.
      while (!cancelled) {
        try {
          const d = await api.getDraft(draftId)
          if (cancelled) return
          replaceContent(editor, d.content ? JSON.parse(d.content) : '')
          break
        } catch {
          await new Promise((r) => setTimeout(r, 700))
        }
      }
      if (cancelled) return
      loaded.current = true
      report.current.onStats?.(statsOf(editor))
      report.current.onCiteMarks?.(citeMarks(editor))
      report.current.onSaveState?.({ state: 'saved' })
      // Markers still searching or checking when the draft was last open (closed mid-search) search again.
      for (const m of citeMarks(editor)) if (unfinished(m)) searchFor(m.cid, m.claim)
      await repairChips(editor)
    })().catch((e) => onError(`Could not refresh citations: ${e instanceof Error ? e.message : e}`))
    return () => {
      cancelled = true
    }
  }, [editor, draftId])

  editorRef.current = editor

  useEffect(() => {
    if (editor) editor.view.dom.setAttribute('spellcheck', String(spellcheck))
  }, [editor, spellcheck])

  // Cite: put a grey "cite" marker at the end of the sentence at once and look for sources in
  // the background, so writing never waits. The cursor stays where it was.
  citeRef.current = () => {
    if (!editor) return
    const target = citeTarget(editor)
    if (!target) {
      onError('Put the cursor in a sentence, or select the text you want to cite.')
      return
    }
    const cid = `k${Date.now()}-${nextCid++}`
    const before = target.pos > 0 ? editor.state.doc.textBetween(target.pos - 1, target.pos, ' ', LEAF) : ''
    const content: JSONContent[] = [{ type: 'citeMark', attrs: { cid, claim: target.claim, state: 'searching', results: [] } }]
    if (before && !/\s/.test(before)) content.unshift({ type: 'text', text: ' ' })
    editor.chain().insertContentAt(target.pos, content, { updateSelection: false }).run()
    searchFor(cid, target.claim)
  }

  useImperativeHandle(
    ref,
    () => ({
      insertDraft(sentences, opts) {
        if (!editor) return
        const content: JSONContent[] = []
        for (const s of sentences) {
          content.push({ type: 'text', text: s.text.trim() + ' ' })
          for (const c of s.citations) {
            content.push({ type: 'citation', attrs: chipFromCitation(c, s.text) }, { type: 'text', text: ' ' })
          }
        }
        // As with an imported file: not clicked into since the draft opened means the end.
        if (opts?.muse) insertMuse(editor, { type: 'paragraph', content }, placed.current ? undefined : 'end')
        else editor.chain().focus(placed.current ? undefined : 'end').insertContent({ type: 'paragraph', content }).scrollIntoView().run()
      },

      updateCitation(cid, patch) {
        if (editor) patchChips(editor, new Map([[cid, patch]]))
      },

      async resolveChip(chip) {
        if (!editor) return chip
        const patch = (await repairChips(editor, [chip])).get(chip.cid)
        return { ...chip, ...patch }
      },

      confirmCite(cid, c) {
        const pos = editor ? findCid(editor, cid) : null
        if (!editor || pos == null) return false
        const mark = editor.state.doc.nodeAt(pos)!
        // This one is an undo step: Ctrl+Z brings the marker back.
        const chip = editor.schema.nodes.citation.create(chipFromCitation({ ...c, cid: undefined }, mark.attrs.claim))
        editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + 1, chip))
        return true
      },

      recheckCite(cid) {
        const pos = editor ? findCid(editor, cid) : null
        if (!editor || pos == null) return
        const claim = sentenceBefore(editor, pos) || editor.state.doc.nodeAt(pos)!.attrs.claim
        patchChips(editor, new Map([[cid, { state: 'searching' as const, results: [], claim }]]))
        searchFor(cid, claim)
      },

      async recheckAll() {
        const summary: RecheckSummary = { citations: 0, verified: 0, flagged: 0, failed: 0, markers: 0, checked: new Map() }
        if (!editor) return summary
        const work: Promise<void>[] = []

        for (const m of citeMarks(editor)) {
          const pos = findCid(editor, m.cid)
          if (pos == null) continue
          const claim = sentenceBefore(editor, pos) || m.claim
          patchChips(editor, new Map([[m.cid, { state: 'searching' as const, results: [], claim }]]))
          summary.markers++
          work.push(searchFor(m.cid, claim))
        }

        // Find each quote where it is now first: a re-added file has new chunk ids.
        const located = await repairChips(editor)
        const chips = new Map<string, { pos: number; attrs: ChipAttrs }>()
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'citation' && node.attrs.cid && !chips.has(node.attrs.cid)) chips.set(node.attrs.cid, { pos, attrs: node.attrs as ChipAttrs })
        })
        summary.citations = chips.size
        // Written from a review matrix: checked against the matrix, once per sentence.
        const fromMatrix = new Map<string, { finding: number; claim: string; chips: ChipAttrs[] }>()
        for (const [cid, { pos, attrs }] of chips) {
          if (!attrs.finding) continue
          chips.delete(cid)
          const claim = claimAt(editor, pos, attrs.claim, !attrs.quote)
          const key = `${attrs.finding}\n${claim}`
          if (!fromMatrix.has(key)) fromMatrix.set(key, { finding: attrs.finding, claim, chips: [] })
          fromMatrix.get(key)!.chips.push(attrs)
          patchChips(editor, new Map([[cid, { status: 'pending' as const, reason: '', claim }]]))
        }
        for (const { finding, claim, chips: group } of fromMatrix.values()) {
          work.push(
            limited(() => checkAgainstMatrix(finding, claim, group))
              .then((patch) => {
                for (const c of group) summary.checked.set(c.cid, patch)
                if (patch.status === 'verified') summary.verified += group.length
                else summary.flagged += group.length
              })
              .catch(() => {
                summary.failed += group.length
                if (editorRef.current) patchChips(editorRef.current, new Map(group.map((c) => [c.cid, { status: c.status, reason: c.reason }])))
              }),
          )
        }

        for (const [cid, { pos, attrs }] of chips) {
          if (located.get(cid)?.status === 'quote_not_found') {
            summary.flagged++
            summary.checked.set(cid, located.get(cid)!)
            continue
          }
          const claim = claimAt(editor, pos, attrs.claim)
          const before = { status: attrs.status, reason: attrs.reason }
          patchChips(editor, new Map([[cid, { status: 'pending' as const, reason: '', claim }]]))
          work.push(
            limited(() => api.verify(claim, attrs.chunkId, attrs.quote))
              .then((v) => {
                const patch = { status: v.status, reason: v.reason, start: v.start, end: v.end }
                summary.checked.set(cid, patch)
                if (v.status === 'verified') summary.verified++
                else summary.flagged++
                if (editorRef.current) patchChips(editorRef.current, new Map([[cid, patch]]))
              })
              .catch(() => {
                summary.failed++
                if (editorRef.current) patchChips(editorRef.current, new Map([[cid, before]]))
              }),
          )
        }
        await Promise.all(work)
        return summary
      },

      async checkCitation(cid, how) {
        const pos = editor ? findCid(editor, cid) : null
        if (!editor || pos == null) return null
        const attrs = editor.state.doc.nodeAt(pos)!.attrs as ChipAttrs
        const claim = claimAt(editor, pos, attrs.claim, !attrs.quote)
        if (how === 'matrix') {
          if (!attrs.finding) return null
          const group: ChipAttrs[] = []
          editor.state.doc.descendants((node, p) => {
            const a = node.attrs as ChipAttrs
            if (node.type.name === 'citation' && a.finding === attrs.finding && claimAt(editor, p, a.claim, !a.quote) === claim) group.push(a)
          })
          patchChips(editor, new Map(group.map((c) => [c.cid, { status: 'pending' as const, reason: '', claim }])))
          try {
            return { ...(await checkAgainstMatrix(attrs.finding, claim, group)), claim }
          } catch (e) {
            patchChips(editor, new Map(group.map((c) => [c.cid, { status: c.status, reason: c.reason }])))
            throw e
          }
        }
        if (!attrs.quote) return null
        patchChips(editor, new Map([[cid, { status: 'pending' as const, reason: '', claim }]]))
        try {
          const located = (await repairChips(editor, [attrs])).get(cid)
          if (located?.status === 'quote_not_found') return { ...located, claim }
          const v = await api.verify(claim, located?.chunkId ?? attrs.chunkId, attrs.quote)
          const patch = { status: v.status, reason: v.reason, start: v.start, end: v.end }
          if (editorRef.current) patchChips(editorRef.current, new Map([[cid, patch]]))
          return { ...patch, claim }
        } catch (e) {
          patchChips(editor, new Map([[cid, { status: attrs.status, reason: attrs.reason }]]))
          throw e
        }
      },

      removeCite(cid) {
        const pos = editor ? findCid(editor, cid) : null
        if (!editor || pos == null) return
        // Take the space put in front of it too, so no double space is left behind.
        const from = pos > 0 && editor.state.doc.textBetween(pos - 1, pos) === ' ' ? pos - 1 : pos
        editor.view.dispatch(editor.state.tr.delete(from, pos + 1))
      },

      showCite(cid) {
        const pos = editor ? findCid(editor, cid) : null
        if (!editor || pos == null) return
        editor.chain().focus().setNodeSelection(pos).scrollIntoView().run()
      },

      async flush() {
        if (editor && loaded.current && saveTimer.current !== undefined) {
          window.clearTimeout(saveTimer.current)
          await save(editor)
        }
        await saving.current // and any save already on its way
      },

      insertDocument(json) {
        if (!editor) return
        const blocks = json.content ?? []
        if (!blocks.length) return
        if (editor.isEmpty) editor.chain().focus().setContent(json).run()
        // Not clicked into since the draft opened: the cursor is still parked at the top, so
        // "at the cursor" would push the whole draft down. The end is what's meant.
        else editor.chain().focus(placed.current ? undefined : 'end').insertContent(blocks).scrollIntoView().run()
      },

      insertHTML(html) {
        if (editor && html) insertMuse(editor, html, placed.current ? undefined : 'end')
      },

      isEmpty: () => editor?.isEmpty ?? true,
      focus: () => editor?.commands.focus('end'),

      setContent(json) {
        if (!editor) return
        window.clearTimeout(saveTimer.current) // a pending autosave of the old text must not win
        editor.chain().command(({ tr }) => (tr.setMeta(MUSE_META, true), true)).setContent(json ? JSON.parse(json) : '', { emitUpdate: false }).run()
        placed.current = false // the cursor was in the old text
        report.current.onStats?.(statsOf(editor))
        report.current.onCiteMarks?.(citeMarks(editor))
        report.current.onSaveState?.({ state: 'saved', at: Date.now() })
        for (const m of citeMarks(editor)) if (unfinished(m)) searchFor(m.cid, m.claim)
        repairChips(editor).catch((e) => onError(`Could not refresh citations: ${e instanceof Error ? e.message : e}`))
      },

      reveal(block, text) {
        if (!editor) return
        const b = textBlocks(editor)[block]
        if (!b) return
        const range = text ? findInBlock(editor, block, text) : null
        editor.chain().focus().setTextSelection(range ?? { from: b.start, to: b.start }).scrollIntoView().run()
        const dom = editor.view.nodeDOM(b.pos)
        if (dom instanceof HTMLElement) {
          dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
          dom.classList.remove('flash')
          void dom.offsetWidth // restart the animation
          dom.classList.add('flash')
        }
      },

      markReview(marks) {
        if (!editor) return
        const ranges: ReviewRange[] = []
        const blocks = textBlocks(editor)
        for (const m of marks) {
          const r = findInBlock(editor, m.block, m.text, blocks)
          if (r) ranges.push({ ...r, kind: m.kind, title: m.title })
        }
        setReviewMarks(editor, ranges)
      },

      getText: () => editor?.getText() ?? '',
      getFocus() {
        if (!editor) return { selection: '', paragraph: '' }
        const { from, to, $from } = editor.state.selection
        const selection = editor.state.doc.textBetween(from, to, ' ', '').replace(/\s+/g, ' ').trim()
        return { selection, paragraph: $from.parent.textContent }
      },
      getJSON: () => editor?.getJSON() ?? null,
      getTitle: () => (editor ? titleOf(editor) : 'Untitled'),

      citedDocIds() {
        const ids: number[] = []
        editor?.state.doc.descendants((node) => {
          if (node.type.name === 'citation' && !ids.includes(node.attrs.docId)) ids.push(node.attrs.docId)
        })
        return ids
      },
    }),
    [editor],
  )

  return (
    <>
      <FormatToolbar editor={editor} onCite={() => citeRef.current()} onAsk={onAsk} />
      <div className="editor-wrap">
        {banner}
        <EditorContent editor={editor} />
        <ChipCard editor={editor} />
      </div>
    </>
  )
})
