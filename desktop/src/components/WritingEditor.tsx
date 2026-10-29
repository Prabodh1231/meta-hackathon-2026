import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { Extension, type Editor, type JSONContent } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { CitationNode } from '../editor/citation'
import { ReviewMarks, findInBlock, setReviewMarks, textBlocks, type ReviewRange } from '../editor/reviewMarks'
import { FormatToolbar } from './FormatToolbar'
import { api } from '../api'
import type { Citation, DraftSentence } from '../types'

const MISSING_REASON = 'This passage is no longer in your library.'

function patchChips(editor: Editor, patches: Map<string, Partial<ChipAttrs>>) {
  const { state, view } = editor
  let tr = state.tr
  let changed = false
  state.doc.descendants((node, pos) => {
    const patch = node.type.name === 'citation' ? patches.get(node.attrs.cid) : undefined
    if (!patch || Object.entries(patch).every(([k, v]) => node.attrs[k] === v)) return
    tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch })
    changed = true
  })
  if (changed) view.dispatch(tr)
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
}

/** Live numbers for the status dock. */
export interface DraftStats {
  words: number
  citations: number
  verified: number
  flagged: number // weak, unsupported or quote not found
}

export type SaveState = { state: 'idle' | 'saving' | 'saved' | 'error'; at?: number }

function statsOf(editor: Editor): DraftStats {
  const s: DraftStats = { words: 0, citations: 0, verified: 0, flagged: 0 }
  s.words = (editor.getText().match(/\w+(?:['’-]\w+)*/g) ?? []).length
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'citation') return
    s.citations++
    if (node.attrs.status === 'verified') s.verified++
    else if (node.attrs.status !== 'pending') s.flagged++
  })
  return s
}

export interface WritingEditorHandle {
  insertDraft: (sentences: DraftSentence[]) => void
  updateCitation: (cid: string, patch: Partial<ChipAttrs>) => void
  /** Bring one chip up to date with the library and return its current attributes. */
  resolveChip: (chip: ChipAttrs) => Promise<ChipAttrs>
  getText: () => string
  getJSON: () => JSONContent | null
  /** First non-empty line, used as the draft's title. */
  getTitle: () => string
  citedDocIds: () => number[]
  /** Insert a chip for the sentence chosen with Cite. Returns false if that spot is gone. */
  insertCitation: (c: Citation, claim: string) => boolean
  /** Save pending edits now (before switching to another draft). */
  flush: () => Promise<void>
  /** Insert a whole document (an imported Word file) at the cursor; it fills an empty draft. */
  insertDocument: (json: JSONContent) => void
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
  }
}

const LEAF = '￼' // stands in for a chip so text offsets line up with document positions

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
  onStats?: (stats: DraftStats) => void
  onSaveState?: (s: SaveState) => void
  onCitationClick: (chip: ChipAttrs) => void
  /** Cite button / Ctrl+Shift+C: find sources for this text. */
  onCiteRequest: (claim: string) => void
  onError: (msg: string) => void
}

export const WritingEditor = forwardRef<WritingEditorHandle, Props>(function WritingEditor(
  { draftId, banner, onCitationClick, onCiteRequest, onError, onStats, onSaveState },
  ref,
) {
  const saveTimer = useRef<number | undefined>(undefined)
  const draftRef = useRef(draftId) // the draft the editor is showing; saves go here
  const statsTimer = useRef<number | undefined>(undefined)
  const report = useRef({ onStats, onSaveState })
  report.current = { onStats, onSaveState }
  const loaded = useRef(false)
  const clickRef = useRef(onCitationClick)
  clickRef.current = onCitationClick
  // Where the chip for the pending Cite request goes, kept in step with later edits.
  const citePos = useRef<number | null>(null)
  const citeRef = useRef<() => void>(() => {})
  const placed = useRef(false) // the writer has put the cursor somewhere since the draft opened

  const editor = useEditor({
    extensions: [
      StarterKit,
      TextStyle,
      FontFamily,
      FontSize,
      CitationNode,
      ReviewMarks,
      Extension.create({
        name: 'citeShortcut',
        addKeyboardShortcuts: () => ({ 'Mod-Shift-c': () => (citeRef.current(), true) }),
      }),
    ],
    onTransaction: ({ transaction }) => {
      if (citePos.current != null && transaction.docChanged) {
        const mapped = transaction.mapping.mapResult(citePos.current)
        citePos.current = mapped.deleted ? null : mapped.pos
      }
    },
    onFocus: () => {
      placed.current = true
    },
    content: '',
    editorProps: {
      attributes: { class: 'prose', spellcheck: 'true' },
      handleClickOn: (_view, _pos, node) => {
        if (node.type.name !== 'citation') return false
        clickRef.current(node.attrs as ChipAttrs)
        return true
      },
    },
    onUpdate: ({ editor }) => {
      window.clearTimeout(statsTimer.current)
      statsTimer.current = window.setTimeout(() => report.current.onStats?.(statsOf(editor)), 250)
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
    e.commands.setContent(json, { emitUpdate: false })
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
      report.current.onSaveState?.({ state: 'saved' })
      await repairChips(editor)
    })().catch((e) => onError(`Could not refresh citations: ${e instanceof Error ? e.message : e}`))
    return () => {
      cancelled = true
    }
  }, [editor, draftId])

  citeRef.current = () => {
    if (!editor) return
    const target = citeTarget(editor)
    if (!target) {
      onError('Put the cursor in a sentence, or select the text you want to cite.')
      return
    }
    citePos.current = target.pos
    onCiteRequest(target.claim)
  }

  useImperativeHandle(
    ref,
    () => ({
      insertDraft(sentences) {
        if (!editor) return
        const content: JSONContent[] = []
        for (const s of sentences) {
          content.push({ type: 'text', text: s.text.trim() + ' ' })
          for (const c of s.citations) {
            content.push({ type: 'citation', attrs: chipFromCitation(c, s.text) }, { type: 'text', text: ' ' })
          }
        }
        editor.chain().focus().insertContent({ type: 'paragraph', content }).run()
      },

      updateCitation(cid, patch) {
        if (editor) patchChips(editor, new Map([[cid, patch]]))
      },

      async resolveChip(chip) {
        if (!editor) return chip
        const patch = (await repairChips(editor, [chip])).get(chip.cid)
        return { ...chip, ...patch }
      },

      insertCitation(c, claim) {
        const pos = citePos.current
        if (!editor || pos == null) return false
        const before = pos > 0 ? editor.state.doc.textBetween(pos - 1, pos, ' ', LEAF) : ''
        const content: JSONContent[] = [{ type: 'citation', attrs: chipFromCitation(c, claim) }]
        if (before && !/\s/.test(before)) content.unshift({ type: 'text', text: ' ' })
        editor.chain().focus().insertContentAt(pos, content).run()
        return true
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

      isEmpty: () => editor?.isEmpty ?? true,
      focus: () => editor?.commands.focus('end'),

      setContent(json) {
        if (!editor) return
        window.clearTimeout(saveTimer.current) // a pending autosave of the old text must not win
        editor.commands.setContent(json ? JSON.parse(json) : '', { emitUpdate: false })
        report.current.onStats?.(statsOf(editor))
        report.current.onSaveState?.({ state: 'saved', at: Date.now() })
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
      <FormatToolbar editor={editor} onCite={() => citeRef.current()} />
      <div className="editor-wrap">
        {banner}
        <EditorContent editor={editor} />
      </div>
    </>
  )
})
