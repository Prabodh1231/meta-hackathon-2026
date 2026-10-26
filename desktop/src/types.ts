export interface Doc {
  id: number
  source: string
  kind: 'pdf' | 'docx' | 'pptx' | 'text' | 'web' | 'image'
  title: string
  authors: string[]
  year: number | null
  venue: string
  doi: string
  url: string
  summary: string
  page_count: number
  topic_id: number | null
  tags: string[]
  label: string
}

export interface Topic {
  id: number
  label: string
  description: string
  user_named: number
  doc_count: number
}

export type CitationStatus = 'pending' | 'verified' | 'weak' | 'unsupported' | 'quote_not_found'

export interface Citation {
  cid?: string // client-side id so async verification can find the chip in the editor
  chunk_id: number
  doc_id: number
  page: number
  quote: string
  start: number | null
  end: number | null
  match: number
  label: string
  status: CitationStatus
  reason: string
}

export interface DraftSentence {
  text: string
  citations: Citation[]
}

export interface DraftResult {
  sentences: DraftSentence[]
  passages: { pid: string; chunk_id: number; label: string }[]
}

export interface IngestResult {
  source: string
  ok: boolean
  error?: string
  document?: Doc
}

export interface Health {
  ok: boolean
  provider: string
  embedder: string
}

export type RefStyle = 'apa' | 'mla' | 'ieee' | 'bibtex'

declare global {
  interface Window {
    rc?: {
      config: () => Promise<{ baseUrl: string; token: string }>
      pickFiles: () => Promise<string[]>
      pickFolder: () => Promise<string | null>
    }
  }
}
