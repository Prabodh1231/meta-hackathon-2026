import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import type { Editor, JSONContent } from '@tiptap/core'
import { CitationNode } from '../editor/citation'
import { FormatToolbar } from './FormatToolbar'
import { api } from '../api'
import type { Citation, DraftSentence } from '../types'

const DRAFT_ID = 1
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
}

function titleOf(editor: Editor): string {
  return (editor.getText().split('\n').find((l) => l.trim()) ?? 'Untitled').trim().slice(0, 80)
}

interface Props {
  onCitationClick: (chip: ChipAttrs) => void
  onError: (msg: string) => void
}

export const WritingEditor = forwardRef<WritingEditorHandle, Props>(function WritingEditor(
  { onCitationClick, onError },
  ref,
) {
  const saveTimer = useRef<number | undefined>(undefined)
  const loaded = useRef(false)
  const clickRef = useRef(onCitationClick)
  clickRef.current = onCitationClick

  const editor = useEditor({
    extensions: [StarterKit, TextStyle, FontFamily, FontSize, CitationNode],
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
      if (!loaded.current) return
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        api.saveDraft(DRAFT_ID, titleOf(editor), JSON.stringify(editor.getJSON())).catch((e) => onError(String(e)))
      }, 800)
    },
  })

  useEffect(() => {
    if (!editor) return
    let cancelled = false
    ;(async () => {
      // Keep retrying while the backend starts. Autosave stays off until the stored draft
      // has loaded, or the first keystroke into an empty editor would overwrite it.
      while (!cancelled) {
        try {
          const d = await api.getDraft(DRAFT_ID)
          if (cancelled) return
          if (d.content) editor.commands.setContent(JSON.parse(d.content))
          break
        } catch {
          await new Promise((r) => setTimeout(r, 700))
        }
      }
      if (cancelled) return
      loaded.current = true
      await repairChips(editor)
    })().catch((e) => onError(`Could not refresh citations: ${e instanceof Error ? e.message : e}`))
    return () => {
      cancelled = true
    }
  }, [editor])

  useImperativeHandle(
    ref,
    () => ({
      insertDraft(sentences) {
        if (!editor) return
        const content: JSONContent[] = []
        for (const s of sentences) {
          content.push({ type: 'text', text: s.text.trim() + ' ' })
          for (const c of s.citations) {
            const attrs: ChipAttrs = {
              cid: c.cid!,
              chunkId: c.chunk_id,
              docId: c.doc_id,
              page: c.page,
              start: c.start,
              end: c.end,
              quote: c.quote,
              claim: s.text,
              label: c.label,
              status: c.status,
              reason: c.reason,
            }
            content.push({ type: 'citation', attrs }, { type: 'text', text: ' ' })
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
      <FormatToolbar editor={editor} />
      <div className="editor-wrap">
        <EditorContent editor={editor} />
      </div>
    </>
  )
})
