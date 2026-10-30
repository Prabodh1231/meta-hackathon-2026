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
  page_numbering: PageNumbering
  page_range: string // printed range like "341–355"; empty when unknown
  topic_id: number | null
  tags: string[]
  keywords: string[] // printed by the authors on the first page
  jel_codes: { code: string; area: string }[] // JEL classification codes, with their top-level field
  folders: DocFolder[]
  label: string
  added_at: string // "YYYY-MM-DD HH:MM:SS", UTC
}

/** A virtual folder a document is filed under: 'auto' was the classifier's call, 'user' was added by hand. */
export interface DocFolder {
  id: number
  name: string
  state: 'auto' | 'user'
  score: number | null // percent match; null if never scored
}

export interface Folder {
  id: number
  name: string
  similarity: number // percent a document must match to be filed here
  doc_count: number
}

/** Where a document's page numbers come from: the PDF's own page labels, numbers printed
 * in headers/footers, or just the PDF page index when neither was found. */
export type PageNumbering = 'pdf_labels' | 'printed' | 'index'

export interface PageText {
  doc_id: number
  page: number // PDF page index
  text: string
  label: string | null // printed page number
  page_numbering: PageNumbering
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
  page_label: string | null
  quote: string
  start: number | null
  end: number | null
  match: number
  label: string
  status: CitationStatus
  reason: string
}

/** A candidate source for a sentence the user wrote, already checked. */
export type Suggestion = Citation & { score: number }

/** Where a saved citation's quote is now (it moves when a file is re-added). */
export interface ResolvedCitation {
  doc_id: number
  chunk_id: number
  page: number
  page_label: string | null
  start: number
  end: number
  match: number
  label: string
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

export interface GraphNode {
  id: string
  kind: 'paper' | 'missing' // missing: cited by library papers but not in the library
  doc_id?: number
  title: string
  authors: string[]
  year: number | null
  cites: number
  cited_by: number
  parsed?: boolean // false when no reference list could be read from the paper
  match?: { why: string[]; hits: number } // in a topic search: what ties the paper to it
}

export interface CitationGraph {
  nodes: GraphNode[]
  citations: { source: string; target: string; kind: 'cites'; how: string }[]
  coupling: { source: string; target: string; kind: 'coupled'; weight: number }[]
  keyword?: { source: string; target: string; kind: 'keyword'; weight: number; shared: string[] }[]
  missing: GraphNode[]
  isolated: number[]
  query?: string
}

/** One entry of a paper's reference list. `in_library`: the library document it matches. */
export interface CitedWork {
  idx: number
  raw: string
  number: number | null
  title: string
  first_author: string
  year: number | null
  doi: string
  in_library: number | null
  searchable: boolean // has a DOI or a title long enough to look up
}

export interface CitedWorks {
  doc_id: number
  title: string
  references: CitedWork[]
}

/** A work papers in the library cite but the library lacks, with who cites it. `ref`: one
 *  reference entry to fetch it by (one with a DOI when any has). */
export interface MissingWork {
  id: string // the same id the citation network gives its node
  title: string
  first_author: string
  year: number | null
  doi: string
  cited_by: number
  citers: { id: number; title: string }[]
  ref: { doc_id: number; idx: number }
}

export interface MissingWorks {
  query: string
  papers: number // papers searched: about the topic, or every paper
  with_refs: number // of those, how many had a reference list to read
  total: number // works missing, before the limit
  cited_twice: number // of those, cited by two or more papers
  works: MissingWork[]
}

/** downloaded: added to the library · link: free to read online, no PDF to download ·
 *  no_free_copy: found, but paywalled · not_found: no index knows it · failed: an error */
export type FetchStatus = 'in_library' | 'downloaded' | 'link' | 'no_free_copy' | 'not_found' | 'failed'

export interface FetchResult {
  status: FetchStatus
  doc_id?: number
  document?: Doc
  url?: string
  reason?: string
  found_in?: string // the index that found it: OpenAlex or Semantic Scholar
}

export interface Health {
  ok: boolean
  api?: number // backend API version; missing from backends older than the version check
  provider: string
  embedder: string
  embedder_device?: string // "cuda" or "cpu"; missing from older backends
}

export type RefStyle = 'apa' | 'mla' | 'ieee' | 'bibtex'
export type DocxStyle = Exclude<RefStyle, 'bibtex'>
export type ThemePref = 'system' | 'light' | 'dark'

/** Preferences from the Settings panel, stored in the library database. */
export interface Settings {
  theme: ThemePref
  citation_style: DocxStyle
}

/** A draft in the drafts menu (without its content). */
export interface DraftSummary {
  id: number
  title: string
  updated_at: string | null // UTC, "YYYY-MM-DD HH:MM:SS"
  words: number
}

/** What opening a Word file converted, and what it had to simplify. */
export interface DocxImport {
  draft: { id: number; title: string; content: string }
  imported: { headings: number; paragraphs: number; list_items: number; tables: number; images: number }
}

export type DuplicateKind = 'exact_file' | 'same_text' | 'likely_same' | 'similar'

/** A library document as the duplicate finder reports it. */
export interface DuplicateDoc {
  id: number
  title: string
  source: string // file path, or URL for web pages
  kind: Doc['kind']
  authors: string[]
  year: number | null
  doi: string
  venue: string
  page_count: number
  added_at: string
  folders: string[]
  cited: boolean // the draft cites it
  is_file: boolean
  exists: boolean
  size: number | null // bytes
}

export interface DuplicateGroup {
  kind: DuplicateKind
  label: string
  explanation: string
  reasons: string[]
  similarity: number | null // percent of the shorter text found in the other
  keep: number // suggested document to keep
  keep_reason: string
  recoverable: number // bytes freed by removing the others
  docs: DuplicateDoc[]
}

export interface FileDuplicateReport {
  groups: DuplicateGroup[]
  counts: Record<DuplicateKind, number>
  recoverable: { identical: number; likely_same: number }
  scanned: number
  files: number
  missing: number
  web: number
  no_text: number
}

declare global {
  interface Window {
    rc?: {
      config: () => Promise<{ baseUrl: string; token: string; logPath?: string }>
      pickFiles: () => Promise<string[]>
      pickFolder: () => Promise<string | null>
      saveFile: (defaultName: string, data: ArrayBuffer) => Promise<string | null>
      trashFile?: (path: string) => Promise<boolean> // to the Recycle Bin / Trash; library files only
      showFile?: (path: string) => Promise<void>
    }
  }
}

/** A saved snapshot of the draft: 'milestone' named by the user, 'auto' taken while writing. */
export interface DraftVersion {
  id: number
  number: number // 1 = oldest
  kind: 'milestone' | 'auto'
  label: string
  title: string
  words: number
  change: number // percent changed since the version before it
  created_at: string // UTC, "YYYY-MM-DD HH:MM:SS"
}

export interface VersionList {
  versions: DraftVersion[] // newest first
  current_words: number
  current_change: number | null // percent the draft has changed since the newest version
}

export type ChangeStatus = 'added' | 'removed' | 'modified' | 'unchanged'
export type DiffOp = ['=' | '+' | '-', string]

export interface ParagraphChange {
  status: ChangeStatus
  change: number
  old: string
  new: string
  ops: DiffOp[]
}

export interface SectionChange {
  title: string // empty for text before the first heading
  level: number
  status: ChangeStatus
  change: number
  words: number
  paragraphs: ParagraphChange[]
}

export interface Comparison {
  document: {
    change: number
    similarity: number
    added_words: number
    removed_words: number
    old_words: number
    new_words: number
  }
  sections: SectionChange[]
  paragraph_counts: Record<ChangeStatus, number>
}

/** A draft sentence that closely matches a passage in the library. */
export interface SourceMatch {
  sentence: string
  block: number // index of the draft's text block it's in
  similarity: number
  level: 'copied' | 'close'
  cited: boolean // the sentence already cites that document
  doc_id: number
  chunk_id: number
  page: number
  page_label: string | null
  label: string
  title: string
  start: number
  end: number
  quote: string
}

export interface RepeatPair {
  similarity: number
  first: string
  second: string
  first_block: number
  second_block: number
}

export interface DuplicateReport {
  words: number
  sentences_checked: number
  overall: number // percent of the draft's words flagged either way
  sources: number
  uncited: number
  internal: number
  source_matches: SourceMatch[]
  repeated_sentences: RepeatPair[]
  repeated_paragraphs: RepeatPair[]
  paragraphs: { block: number; words: number; flagged: number; text: string }[] // only paragraphs with flagged text
}
