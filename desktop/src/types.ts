import type { JSONContent } from '@tiptap/core'

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
  /** Model work that failed when it was added and is still owed: "metadata", "title", "summary", "tags". */
  missing: string[]
  jel_codes: { code: string; area: string }[] // JEL classification codes, with their top-level field
  folders: DocFolder[]
  label: string
  added_at: string // "YYYY-MM-DD HH:MM:SS", UTC
  /** When the file reached this computer (earlier of its created and modified times); null for web pages. */
  file_date: string | null
  sha256: string
  /** Full publication date from OpenAlex, "YYYY-MM-DD" or "YYYY-MM"; '' when only `year` is known. */
  published: string
  published_checked: boolean // OpenAlex was asked already
  // What the scholarly indexes (OpenAlex, Crossref) know about it; see `enriched`.
  abstract: string // the authors' own
  volume: string
  issue: string
  publisher: string
  openalex_id: string
  cited_by_count: number | null // citations worldwide
  /** '' not looked up yet, 'not_found', 'mismatch' (the DOI on the paper is another work's: see index_title). */
  enriched: '' | 'found' | 'not_found' | 'mismatch'
  index_title: string
  /** This same file was removed once before it was added again. */
  previously_removed: {
    id: number
    title: string
    removed_at: string
    reason: RemovalReason
    duplicate_of: number | null
    duplicate_of_title: string
  } | null
}

export type RemovalReason = 'removed' | 'duplicate'

/** A source removed from the library, as the removal log keeps it (metadata only). */
export interface RemovedDoc {
  id: number // its id when it was in the library; a restore brings it back under the same one
  source: string
  kind: Doc['kind']
  title: string
  authors: string[]
  year: number | null
  venue: string
  doi: string
  url: string
  published: string
  sha256: string
  file_date: string | null
  edited_fields: Record<string, unknown> // the user's corrections, restored with it
  folders: string[] // folders the user had filed it in
  added_at: string
  removed_at: string
  reason: RemovalReason
  duplicate_of: number | null
  duplicate_of_title: string
  file_trashed: boolean
  back_in_library: number | null // added again since, as this document
  file_exists: boolean | null // null for a web page
  restorable: boolean
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
  /** Written from a review matrix (a gap, or a passage from Write from this matrix): the id of
   * the kept finding, which the citation is checked against instead of its quote. */
  finding?: number | null
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

/** One message in the Ask chat and the AI's reply (Markdown). */
export interface AskTurn {
  id: number
  question: string
  selection: string // the draft text the question was about, '' for none
  created_at: string
  reply: string
}

export interface DraftResult {
  sentences: DraftSentence[]
  passages: { pid: string; chunk_id: number; label: string }[]
}

/** Write from this matrix: the sentences, kept as a finding (null when nothing was written). */
export type SynthesisResult = DraftResult & { finding: number | null }

/** A gap or a written passage a review matrix produced, kept so the draft can cite it. */
export interface FindingSummary {
  id: number
  kind: 'gap' | 'synthesis' | 'proposal'
  matrix_id: number | null // null once the matrix is deleted
  matrix_name: string
  title: string // a gap's title; the instruction a passage was written to ('' for the standard one)
  text: string // a gap's detail; a passage's sentences
  created_at: string
  papers: number
  matrix_changed: boolean // the matrix's rows differ from what this was written from
}

export interface FindingRow {
  doc_id: number
  label: string
  title: string
  values: { key: string; label: string; value: string; quote: string }[]
}

export interface Finding extends FindingSummary {
  matrix_exists: boolean
  matrix_ids: number[] // a proposal can draw on several matrices
  sentences: DraftSentence[]
  /** The matrix rows it was written from. */
  snapshot: FindingRow[]
}

export type VariableRole = 'independent' | 'dependent' | 'mediator' | 'moderator' | 'control'

/** A variable a proposed study would use, as Muse suggests it. */
export interface SuggestedVariable {
  name: string
  role: VariableRole
  why: string
  measures: { doc_id: number; label: string; how: string }[] // how the reviewed studies measured it
}

/** A broken exclusion: what the writer ruled out, and where the proposal does it anyway. */
export interface ProposalViolation {
  rule: string
  section: string
  why: string
}

export interface ProposalResult {
  finding: number
  title: string
  doc: { type: 'doc'; content: unknown[] }
  research_questions: string[]
  hypotheses: string[]
  violations: ProposalViolation[]
  matrices: string
  citations: { verified: number; flagged: number }
  /** Chosen gaps the one study doesn't take on, and why. */
  left_out: { gap: string; why: string }[]
  core_question: string
  /** What the separate review of the research questions changed: revised or removed, and why. */
  question_review: {
    original: string
    verdict: 'revise' | 'remove' | 'core' // 'core': the title and core question were refocused
    text: string
    why: string
    title_before?: string
    title?: string
  }[]
  /** Background and gap paragraphs Muse rewrote from the rows they cite, or dropped, after a failed check. */
  repaired: { section: string; before: string; after: string; status: CitationStatus | 'removed'; reason: string }[]
  /** Earlier measures the matrices don't state, taken out of the variables table. */
  removed: { claim: string; reason: string; study: string }[]
  /** Claims about the reviewed studies the matrices don't back (amber or red in the draft). */
  flagged: { section: string; claim: string; status: CitationStatus; reason: string; studies: string[] }[]
}

/** Published work close to a research question (OpenAlex). */
export interface SimilarWork {
  openalex_id: string
  doi: string
  title: string
  authors: string[]
  year: number | null
  venue: string
  cited_by_count: number | null
  abstract: string
  in_library: number | null
}

/** A sentence checked against a finding's matrix. */
export interface FindingCheck {
  status: CitationStatus
  reason: string
  against: 'matrix' | 'saved' // the matrix as it is now, or the copy kept with the finding
  matrix_changed: boolean
}

/** One file in a background import. */
export interface IngestFile {
  source: string
  name: string
  state: 'queued' | 'working' | 'done' | 'failed' | 'skipped'
  stage: '' | 'reading' | 'analysing' | 'filing'
  error: string | null
  document_id: number | null
  title: string | null
  missing: string[] // added, but with these parts still owed
}

/** Files and folders being added in the background (POST /ingest/jobs). */
export interface IngestJob {
  id: number
  state: 'queued' | 'listing' | 'running' | 'retrying' | 'looking_up' | 'done' | 'cancelled' | 'failed'
  paths: string[]
  files: IngestFile[]
  total: number
  done: number
  failed: number
  skipped: number
  incomplete: number // added without a summary, tags or metadata
  cancelled: boolean
  error: string | null
  started_at: number
  finished_at: number | null
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
  from_index: boolean // listed by OpenAlex, not read from the paper's own text
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
  embedder: string // the model's id, or "loading" / "failed" while the backend starts
  embedder_device?: string // "cuda" or "cpu"; missing from older backends
  muse_route?: string[] // Muse's services in the order requests try them, e.g. ["baseten", "meta"]
}

export type RefStyle = 'apa' | 'mla' | 'ieee' | 'bibtex'
export type DocxStyle = Exclude<RefStyle, 'bibtex'>
export type ThemePref = 'system' | 'light' | 'dark'

/** Preferences from the Settings window, stored in the library database (USER_SETTINGS in
 * backend/app/library.py lists the allowed values). */
export interface Settings {
  // Appearance and editor
  theme: ThemePref
  page_width: 'normal' | 'narrow' | 'wide'
  text_size: 'normal' | 'small' | 'large'
  doc_font: 'charter' | 'georgia' | 'sans'
  spellcheck: boolean
  tools_at_start: 'last' | 'open' | 'closed'
  // Writing and citations
  citation_style: DocxStyle
  assistant_passages: number
  cite_scope: 'ticked' | 'library'
  // Review and history
  duplicate_sensitivity: number
  auto_recheck: boolean
  snapshot_minutes: number
  snapshots_kept: number
  // Library
  folder_similarity: number
  contact_email: string
  index_lookup: boolean // look new papers up in OpenAlex and Crossref
}

/** A work as OpenAlex lists it: one citing a library paper, or a work the library lacks. */
export interface IndexWork {
  openalex_id: string
  doi: string
  title: string
  authors: string[]
  year: number | null
  venue: string
  cited_by_count: number | null
  abstract: string
}

export interface CitingWorks {
  doc_id: number
  title: string
  found: boolean // OpenAlex knows the paper
  total: number // works citing it, of which `works` are the first
  cited_by_count: number | null
  works: (IndexWork & { in_library: number | null; first_author: string })[]
}

export interface EnrichResult {
  checked: number
  found: number
  dates: number
  dois: number
  mismatched: number
  failed: number // OpenAlex couldn't be reached; tried again next time
}

/** Where free copies of papers are searched for: CORE only with the user's own key. */
export interface SourceSettings {
  has_core_key: boolean
  core_key_hint: string // last 4 characters of the saved key
}

/** Where embeddings and reranking run. The Baseten key is never sent back, only whether there is one. */
export interface SearchSettings {
  where: 'auto' | 'local' | 'baseten'
  embedder: string
  embedder_on: string // "cuda", "cpu" or "baseten"
  reranker: string | null
  reranker_on: string | null
  has_key: boolean
  key_hint: string
  embed_model: string // a Baseten model ID or address
  rerank_model: string
  gpu: boolean // this computer has a CUDA GPU
  restart_needed?: boolean // after a change: applies at the next start, which re-embeds the library
}

/** The language model in use. The API key is never sent back, only whether there is one. */
export interface ModelSettings {
  provider: 'muse' | 'mock'
  has_key: boolean
  key_hint: string // its last four characters
  model: string
  reasoning_effort: string
  efforts: string[]
  env_locked: string[] // set in the environment, which wins over the app's .env at the next start
  route: 'baseten-first' | 'meta' | 'baseten' // where Muse requests go
  routes: string[] // the services in use, in the order requests try them
  has_baseten_key: boolean
  baseten_model: string
}

/** A draft in the drafts menu (without its content). */
export interface DraftSummary {
  id: number
  title: string
  updated_at: string | null // UTC, "YYYY-MM-DD HH:MM:SS"
  words: number
}

/** What opening a Word file converted, and what it had to simplify. */
/** What a Word import converted ("headings" … "links") or simplified ("tables", "images"). */
export interface DocxStats {
  headings: number
  paragraphs: number
  list_items: number
  quotes: number
  links: number
  tables: number
  images: number
}

export interface DocxImport {
  draft: { id: number; title: string; content: string }
  imported: DocxStats
}

/** A Word document converted for the editor, not saved anywhere yet. */
export interface DocxConversion {
  content: JSONContent & { type: 'doc'; content: JSONContent[] }
  title: string
  imported: DocxStats
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
      config: () => Promise<{ baseUrl: string; token: string; logPath?: string; samplesDir?: string }>
      pickFiles: () => Promise<string[]>
      pickFolder: () => Promise<string | null>
      /** Asks where to save; the dialog offers the type of `defaultName`'s extension (.docx, .xlsx, .csv). */
      saveFile: (defaultName: string, data: ArrayBuffer) => Promise<string | null>
      trashFile?: (path: string) => Promise<boolean> // to the Recycle Bin / Trash; library files only
      showFile?: (path: string) => Promise<void>
      /** A library PDF in its own resizable window, at a page (the desktop app only). */
      openPdf?: (path: string, page: number, title: string) => Promise<void>
      /** Where a dropped or picked file is on disk ('' for one that isn't a file on disk). */
      pathForFile?: (file: File) => string
      /** Copies the demo corpus into the data folder and resolves to that folder. */
      copySamples?: () => Promise<string>
    }
  }
}

/** A column of a literature review matrix: what to extract from each paper. */
export interface MatrixColumn {
  key: string // a detail's starts with "@"
  /** 'question': read from each paper by Muse, with a quote. 'detail': the paper's record (year, journal, citations…). */
  kind?: 'question' | 'detail'
  field?: string // for a detail
  label: string
  instruction: string
  query?: string
}

/** A paper detail a matrix can show as a column. */
export interface MatrixDetailField {
  field: string
  label: string
}

/** One cell: a short answer and the verbatim quote it rests on, located in the paper. */
export interface MatrixCell {
  status: 'pending' | 'found' | 'unverified' | 'not_reported' | 'error'
  answer: string
  quote: string
  chunk_id: number | null
  page: number | null
  start: number | null
  end: number | null
  label: string // "Parino & Bianchi 2018, p. 4"
  edited: number
  error: string
}

export interface MatrixRow {
  doc_id: number
  title: string
  authors: string[]
  year: number | null
  kind: Doc['kind']
  label: string // "Parino & Bianchi 2018"
  cells: Record<string, MatrixCell>
  /** The paper's record, by detail field: authors and keywords are lists, year and citations numbers. */
  details: Record<string, string | number | string[] | null>
}

export interface Matrix {
  id: number
  name: string
  columns: MatrixColumn[]
  rows: MatrixRow[]
  gaps: { id: number; title: string; detail: string }[] | null
  pending: number // cells still being read
  cells: number
  updated_at: string
}

export interface MatrixSummary {
  id: number
  name: string
  columns: number
  papers: number
  pending: number
  updated_at: string
}

/** A paper a matrix could include, from a folder or a topic. */
export interface MatrixPaper {
  id: number
  title: string
  authors: string[]
  year: number | null
  kind: Doc['kind']
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
