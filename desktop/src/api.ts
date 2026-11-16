import type {
  AskTurn,
  Citation,
  CitationGraph,
  CitingWorks,
  EnrichResult,
  IndexWork,
  CitedWorks,
  Doc,
  DocxConversion,
  DocxImport,
  DocxStyle,
  DraftSummary,
  DraftResult,
  DraftVersion,
  DuplicateReport,
  Comparison,
  FetchResult,
  FetchedHighlight,
  Highlight,
  MissingWorks,
  FileDuplicateReport,
  Finding,
  FindingCheck,
  FindingSummary,
  Matrix,
  MatrixColumn,
  MatrixDetailField,
  MatrixPaper,
  MatrixSummary,
  Folder,
  Health,
  RemovedDoc,
  IngestJob,
  IngestResult,
  ModelSettings,
  SearchSettings,
  SourceSettings,
  PageText,
  RefStyle,
  ResolvedCitation,
  Settings,
  ProposalResult,
  ProposalViolation,
  SimilarWork,
  SuggestedVariable,
  Suggestion,
  SynthesisResult,
  VariableRole,
  Topic,
  VersionList,
} from './types'

// Outside Electron (plain `vite` in a browser) fall back to a backend started by hand.
const FALLBACK = { baseUrl: 'http://127.0.0.1:8765', token: '' }
let configPromise: Promise<{ baseUrl: string; token: string }> | null = null

function config() {
  configPromise ??= window.rc ? window.rc.config() : Promise.resolve(FALLBACK)
  return configPromise
}

/** The backend API version this UI needs (API_VERSION in backend/app/main.py). */
export const API_VERSION = 20

/** The backend answered "no such endpoint": it's an older backend than this UI, still running
 * from before an update (the desktop app starts it once, at launch). */
export class BackendOutdated extends Error {
  constructor() {
    super('The backend is older than the app, so this feature is missing. Restart the app to finish updating.')
  }
}

/** The backend didn't answer at all (not running, or restarting), as opposed to an error reply. */
export class BackendUnreachable extends Error {
  constructor() {
    super("Can't reach the backend. It restarts automatically; try again in a few seconds.")
  }
}

async function send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const { baseUrl, token } = await config()
  let res: Response
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-rc-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (signal?.aborted) throw e // cancelled by the caller: an AbortError, not an outage
    throw new BackendUnreachable() // the browser's own message is just "Failed to fetch"
  }
  if (!res.ok) {
    // An unknown route answers 405 (the path exists for other methods) or a bare "Not Found";
    // a missing item answers 404 with its own message ("Draft 2 not found").
    if (res.status === 405) throw new BackendOutdated()
    if (res.status === 404 && (await res.clone().json().catch(() => ({}))).detail === 'Not Found') throw new BackendOutdated()
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* non-JSON error body */
    }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return res
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return (await send(method, path, body, signal)).json() as Promise<T>
}

/** Where the desktop app writes backend output (empty outside Electron). */
export async function backendLogPath(): Promise<string> {
  return ((await config()) as { logPath?: string }).logPath ?? ''
}

export const api = {
  health: () => request<Health>('GET', '/health'),

  ingestPath: (path: string) => request<{ results: IngestResult[] }>('POST', '/ingest/path', { path }),
  /** Several files or folders in one request, so the backend reads them in parallel. */
  ingestPaths: (paths: string[]) => request<{ results: IngestResult[] }>('POST', '/ingest/paths', { paths }),
  ingestUrl: (url: string) => request<Doc>('POST', '/ingest/url', { url }),
  /** Add files and folders in the background; poll ingestJob for each file's progress. */
  startIngest: (paths: string[]) => request<IngestJob>('POST', '/ingest/jobs', { paths }),
  ingestJob: (id: number) => request<IngestJob>('GET', `/ingest/jobs/${id}`),
  ingestJobs: () => request<IngestJob[]>('GET', '/ingest/jobs'),
  cancelIngest: (id: number) => request<IngestJob>('POST', `/ingest/jobs/${id}/cancel`),
  /** Retry the summaries, tags and metadata that failed when documents were added. */
  fillMissing: (docIds?: number[]) =>
    request<{ filled: number; still_missing: number }>('POST', '/library/fill-missing', { doc_ids: docIds ?? null }),

  documents: () => request<Doc[]>('GET', '/documents'),
  document: (id: number) => request<Doc>('GET', `/documents/${id}`),
  updateDocument: (id: number, patch: Partial<Doc>) => request<Doc>('PATCH', `/documents/${id}`, patch),
  /** Remove from the library; what it was is kept in the removal log (Removed). */
  deleteDocument: (id: number, why?: { reason: 'removed' | 'duplicate'; duplicateOf?: number; trashed?: boolean }) => {
    const q = new URLSearchParams({ reason: why?.reason ?? 'removed', trashed: String(!!why?.trashed) })
    if (why?.duplicateOf != null) q.set('duplicate_of', String(why.duplicateOf))
    return request<{ ok: boolean }>('DELETE', `/documents/${id}?${q}`)
  },
  removed: () => request<RemovedDoc[]>('GET', '/library/removed'),
  /** Add a removed source back from its file, under its old id and added date. */
  restoreRemoved: (id: number) => request<Doc>('POST', `/library/removed/${id}/restore`),
  forgetRemoved: (id: number) => request<{ ok: boolean }>('DELETE', `/library/removed/${id}`),
  /** Look papers up in OpenAlex and Crossref (all not yet looked up, or `docIds`; `refresh` asks again). */
  enrich: (docIds?: number[], refresh = false) =>
    request<EnrichResult>('POST', '/library/enrich', { doc_ids: docIds ?? null, refresh }),
  citingWorks: (docId: number, sort: 'cited' | 'recent') => request<CitingWorks>('GET', `/documents/${docId}/citing?sort=${sort}`),
  /** Find a free copy of any work and add it to the library. */
  fetchWork: (w: { title: string; doi: string; year: number | null; first_author: string }) =>
    request<FetchResult>('POST', '/library/fetch-work', w),
  /** Citations worldwide and abstracts, by DOI. */
  worksInfo: (dois: string[]) => request<Record<string, IndexWork>>('POST', '/works/info', { dois }),
  duplicateFiles: (cited: number[]) => request<FileDuplicateReport>('POST', '/library/duplicates', { cited }),
  page: (docId: number, page: number) => request<PageText>('GET', `/documents/${docId}/pages/${page}`),

  topics: () => request<Topic[]>('GET', '/topics'),
  rebuildTopics: () => request<Topic[]>('POST', '/topics/rebuild'),
  renameTopic: (id: number, label: string) => request<Topic>('PATCH', `/topics/${id}`, { label }),
  mergeTopics: (sourceIds: number[], intoId: number) =>
    request<Topic[]>('POST', '/topics/merge', { source_ids: sourceIds, into_id: intoId }),

  folders: () => request<Folder[]>('GET', '/folders'),
  classifyFolders: () => request<Folder[]>('POST', '/folders/classify'),
  createFolder: (name: string, similarity: number) => request<Folder[]>('POST', '/folders', { name, similarity }),
  updateFolder: (id: number, patch: { name?: string; similarity?: number }) =>
    request<Folder[]>('PATCH', `/folders/${id}`, patch),
  deleteFolder: (id: number) => request<Folder[]>('DELETE', `/folders/${id}`),
  classifyDocument: (docId: number) => request<Doc>('POST', `/documents/${docId}/classify`),
  addToFolder: (docId: number, name: string) => request<Doc>('POST', `/documents/${docId}/folders`, { name }),
  setFolderMember: (docId: number, folderId: number, member: boolean) =>
    request<Doc>('PUT', `/documents/${docId}/folders/${folderId}`, { member }),

  citedWorks: (docId: number) => request<CitedWorks>('GET', `/documents/${docId}/cited`),
  missingWorks: (q = '') => request<MissingWorks>('GET', `/missing${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  fetchCitedWork: (docId: number, idx: number) => request<FetchResult>('POST', `/documents/${docId}/cited/${idx}/fetch`),

  /** The citation network for a topic, for chosen papers, or (neither) the whole library. */
  graph: (q = '', ids?: number[]) => {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (ids) params.set('ids', ids.join(','))
    return request<CitationGraph>('GET', `/graph${params.size ? `?${params}` : ''}`)
  },

  /** The Ask chat kept with a draft, oldest first. */
  askTurns: (draftId: number) => request<AskTurn[]>('GET', `/drafts/${draftId}/ask`),
  /** `signal` cancels the wait; an answer Muse still gives is kept with the chat and shows next time it loads. */
  ask: (draftId: number, question: string, context: string, selection: string, signal?: AbortSignal) =>
    request<AskTurn>('POST', `/drafts/${draftId}/ask`, { question, context, selection }, signal),
  clearAsk: (draftId: number) => request<{ ok: boolean }>('DELETE', `/drafts/${draftId}/ask`),
  /** `signal` cancels the wait (Muse may still finish on the backend; the answer is dropped). */
  draft: (instruction: string, context: string, docIds: number[] | null, k?: number, signal?: AbortSignal) =>
    request<DraftResult>('POST', '/write/draft', { instruction, context, doc_ids: docIds, k }, signal),
  /** Muse's retries and route switches since `since` (epoch seconds), to explain a slow answer. */
  modelActivity: (since: number) =>
    request<{ now: number; events: { at: number; kind: 'retry' | 'switch'; text: string }[] }>('GET', `/model/activity?since=${since}`),
  documentHighlights: (docId: number) => request<Highlight[]>('GET', `/documents/${docId}/highlights`),
  addHighlight: (docId: number, page: number, text: string, note = '') =>
    request<Highlight>('POST', `/documents/${docId}/highlights`, { page, text, note }),
  setHighlightNote: (id: number, note: string) => request<Highlight>('PATCH', `/highlights/${id}`, { note }),
  deleteHighlight: (id: number) => request<{ ok: boolean }>('DELETE', `/highlights/${id}`),
  /** Highlights and notes closest to the paragraph being written, ranked by keyword scoring on this computer. */
  fetchHighlights: (context: string) => request<FetchedHighlight[]>('POST', '/highlights/fetch', { context }),
  /** Muse writes cited sentences from these highlights; each citation still needs verifying. */
  writeFromHighlights: (ids: number[], context: string, signal?: AbortSignal) =>
    request<DraftResult>('POST', '/highlights/write', { ids, context }, signal),
  verify: (claim: string, chunkId: number, quote: string) =>
    request<Citation>('POST', '/citations/verify', { claim, chunk_id: chunkId, quote }),
  suggestCitations: (claim: string, docIds: number[] | null) =>
    request<Suggestion[]>('POST', '/citations/suggest', { claim, doc_ids: docIds }),
  /** The same candidates as they are checked: `onUpdate` gets the list (best first, the
   * unchecked ones "pending") after the search and after each check; resolves with the final list. */
  suggestCitationsStream: async (claim: string, docIds: number[] | null, onUpdate: (results: Suggestion[]) => void) => {
    const res = await send('POST', '/citations/suggest/stream', { claim, doc_ids: docIds })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let final: Suggestion[] | null = null
    const take = (line: string) => {
      if (!line.trim()) return
      const update = JSON.parse(line) as { results?: Suggestion[]; done?: boolean; error?: string }
      if (update.error || !update.results) throw new Error(update.error || 'The search stopped early.')
      if (update.done) final = update.results
      else onUpdate(update.results)
    }
    for (;;) {
      const { done, value } = await reader.read().catch(() => {
        throw new BackendUnreachable() // the backend went away mid-answer
      })
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = done ? '' : lines.pop()!
      lines.forEach(take)
      if (done) break
    }
    if (!final) throw new Error('The search stopped early.')
    return final as Suggestion[]
  },
  resolveCitations: (items: { doc_id: number; page: number; quote: string }[]) =>
    request<(ResolvedCitation | null)[]>('POST', '/citations/resolve', { items }),
  references: (docIds: number[], style: RefStyle) =>
    request<{ style: RefStyle; entries: string[] }>('POST', '/references', { doc_ids: docIds, style }),

  settings: () => request<Settings>('GET', '/settings'),
  updateSettings: (changes: Partial<Settings>) => request<Settings>('PATCH', '/settings', changes),
  modelSettings: () => request<ModelSettings>('GET', '/settings/model'),
  /** Switch model, set the API key or the reasoning effort; left-out fields stay as they are. */
  updateModel: (changes: { provider?: string; api_key?: string; reasoning_effort?: string }) =>
    request<ModelSettings>('PUT', '/settings/model', changes),
  searchSettings: () => request<SearchSettings>('GET', '/settings/search'),
  sourceSettings: () => request<SourceSettings>('GET', '/settings/sources'),
  /** Set the CORE key (checked with CORE before it's saved); '' removes it. */
  updateSources: (coreApiKey: string) => request<SourceSettings>('PUT', '/settings/sources', { core_api_key: coreApiKey }),
  /** A library document's file, e.g. a PDF to show in the app. */
  documentFile: async (docId: number) => (await send('GET', `/documents/${docId}/file`)).arrayBuffer(),

  exportDocx: async (content: unknown, style: DocxStyle, title: string) =>
    (await send('POST', '/export/docx', { content, style, title })).arrayBuffer(),

  drafts: () => request<DraftSummary[]>('GET', '/drafts'),
  createDraft: (title = 'Untitled', named = false) =>
    request<{ id: number; title: string; content: string }>('POST', '/drafts', { title, named }),
  /** Name a draft so saves keep the name; an empty name goes back to its first line. */
  renameDraft: (id: number, title: string) => request<{ id: number; title: string; named: boolean }>('PATCH', `/drafts/${id}`, { title }),
  deleteDraft: (id: number) => request<{ ok: boolean }>('DELETE', `/drafts/${id}`),
  importDocx: (filename: string, data: string) => request<DocxImport>('POST', '/drafts/import', { filename, data }),
  convertDocx: (filename: string, data: string) => request<DocxConversion>('POST', '/drafts/convert-docx', { filename, data }),
  getDraft: (id: number) => request<{ id: number; title: string; content: string }>('GET', `/drafts/${id}`),
  saveDraft: (id: number, title: string, content: string) => request('PUT', `/drafts/${id}`, { title, content }),

  versions: (draftId: number) => request<VersionList>('GET', `/drafts/${draftId}/versions`),
  saveVersion: (draftId: number, label: string, title: string, content: string) =>
    request<DraftVersion>('POST', `/drafts/${draftId}/versions`, { label, title, content }),
  renameVersion: (draftId: number, id: number, label: string) =>
    request<DraftVersion>('PATCH', `/drafts/${draftId}/versions/${id}`, { label }),
  deleteVersion: (draftId: number, id: number) => request('DELETE', `/drafts/${draftId}/versions/${id}`),
  compareVersion: (draftId: number, id: number, to: { content?: unknown; against?: number }) =>
    request<Comparison>('POST', `/drafts/${draftId}/versions/${id}/compare`, to),
  restoreVersion: (draftId: number, id: number) =>
    request<{ id: number; title: string; content: string }>('POST', `/drafts/${draftId}/versions/${id}/restore`),
  checkDuplicates: (content: unknown) => request<DuplicateReport>('POST', '/drafts/check-duplicates', { content }),

  // Literature review matrices
  matrices: () => request<MatrixSummary[]>('GET', '/matrices'),
  matrixColumns: () => request<MatrixColumn[]>('GET', '/matrices/columns'),
  /** The paper details a matrix can show as columns. */
  matrixDetails: () => request<MatrixDetailField[]>('GET', '/matrices/details'),
  /** The papers a folder holds, or those about a topic (best evidence first). */
  matrixPapers: (by: { folder_id?: number; topic?: string }) => request<MatrixPaper[]>('POST', '/matrices/papers', by),
  createMatrix: (name: string, docIds: number[], columns?: MatrixColumn[]) =>
    request<Matrix>('POST', '/matrices', { name, doc_ids: docIds, columns }),
  matrix: (id: number) => request<Matrix>('GET', `/matrices/${id}`),
  updateMatrix: (id: number, patch: { name?: string; columns?: MatrixColumn[]; add_doc_ids?: number[]; remove_doc_ids?: number[] }) =>
    request<Matrix>('PATCH', `/matrices/${id}`, patch),
  deleteMatrix: (id: number) => request<{ ok: boolean }>('DELETE', `/matrices/${id}`),
  setMatrixCell: (id: number, docId: number, column: string, answer: string) =>
    request<Matrix>('PUT', `/matrices/${id}/cells/${docId}/${encodeURIComponent(column)}`, { answer }),
  /** Read again: one cell, a paper's row, a column, or everything. */
  rerunMatrix: (id: number, scope: { doc_id?: number; column?: string } = {}) =>
    request<Matrix>('POST', `/matrices/${id}/rerun`, scope),
  matrixGaps: (id: number) => request<Matrix>('POST', `/matrices/${id}/gaps`),
  matrixSynthesis: (id: number, instruction = '', columns?: string[]) =>
    request<SynthesisResult>('POST', `/matrices/${id}/synthesis`, { instruction, columns }),
  /** Gaps and passages a matrix produced, kept for the draft, newest first. */
  matrixFindings: (id: number) => request<FindingSummary[]>('GET', `/matrices/${id}/findings`),
  finding: (id: number) => request<Finding>('GET', `/findings/${id}`),
  deleteFinding: (id: number) => request<{ ok: boolean }>('DELETE', `/findings/${id}`),
  /** Variables a study addressing these gaps would use, with suggested roles. */
  proposalVariables: (src: { matrix_ids: number[]; finding_ids: number[]; focus: string }) =>
    request<SuggestedVariable[]>('POST', '/proposals/variables', src),
  writeProposal: (body: {
    matrix_ids: number[]
    finding_ids: number[]
    focus: string
    variables: { name: string; role: VariableRole; measure: string }[]
    exclusions: string
    resources: string
    avoid: ProposalViolation[]
  }) => request<ProposalResult>('POST', '/proposals', body),
  /** Published work close to a research question: has this been done? */
  proposalNovelty: (query: string) => request<{ works: SimilarWork[] }>('POST', '/proposals/novelty', { query }),
  /** Check a sentence written from a finding against its matrix (not against one quote). */
  checkFinding: (id: number, claim: string, docIds?: number[]) =>
    request<FindingCheck>('POST', `/findings/${id}/check`, { claim, doc_ids: docIds?.length ? docIds : undefined }),
  /** The matrix as editor content: a table whose cells cite their quotes. */
  matrixTable: (id: number, columns: string[]) =>
    request<{ type: 'doc'; content: unknown[] }>('GET', `/matrices/${id}/table?columns=${encodeURIComponent(columns.join(','))}`),
  exportMatrix: async (id: number, format: 'xlsx' | 'csv' | 'docx', style: DocxStyle) =>
    (await send('GET', `/matrices/${id}/export?format=${format}&style=${style}`)).arrayBuffer(),
}
