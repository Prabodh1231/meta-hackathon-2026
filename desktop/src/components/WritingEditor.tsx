import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import type { JSONContent } from '@tiptap/core'
import { CitationNode } from '../editor/citation'
import { api } from '../api'
import type { Citation, DraftSentence } from '../types'

const DRAFT_ID = 1

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
  getText: () => string
  citedDocIds: () => number[]
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
    extensions: [StarterKit, CitationNode],
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
        const first = editor.getText().split('\n').find((l) => l.trim()) ?? 'Untitled'
        api.saveDraft(DRAFT_ID, first.slice(0, 80), JSON.stringify(editor.getJSON())).catch((e) => onError(String(e)))
      }, 800)
    },
  })

  useEffect(() => {
    if (!editor) return
    api
      .getDraft(DRAFT_ID)
      .then((d) => {
        if (d.content) editor.commands.setContent(JSON.parse(d.content))
      })
      .catch(() => {
        /* backend may still be starting; an empty document is fine */
      })
      .finally(() => {
        loaded.current = true
      })
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
        if (!editor) return
        const { state, view } = editor
        let tr = state.tr
        let changed = false
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'citation' && node.attrs.cid === cid) {
            tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch })
            changed = true
          }
        })
        if (changed) view.dispatch(tr)
      },

      getText: () => editor?.getText() ?? '',

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
    <div className="editor-wrap">
      <EditorContent editor={editor} />
    </div>
  )
})
