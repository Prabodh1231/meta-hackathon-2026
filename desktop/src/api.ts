import type {
  Citation,
  CitationGraph,
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
  MissingWorks,
  FileDuplicateReport,
  Matrix,
  MatrixColumn,
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
  Suggestion,
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
export const API_VERSION = 13

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

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const { baseUrl, token } = await config()
  let res: Response
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-rc-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await send(method, path, body)).json() as Promise<T>
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
  /** Full publication dates from OpenAlex for the papers not yet looked up. */
  fillPublicationDates: () =>
    request<{ checked: number; found: number; dois: number; failed: number }>('POST', '/library/publication-dates'),
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

  graph: (q = '') => request<CitationGraph>('GET', `/graph${q ? `?q=${encodeURIComponent(q)}` : ''}`),

  draft: (instruction: string, context: string, docIds: number[] | null, k?: number) =>
    request<DraftResult>('POST', '/write/draft', { instruction, context, doc_ids: docIds, k }),
  verify: (claim: string, chunkId: number, quote: string) =>
    request<Citation>('POST', '/citations/verify', { claim, chunk_id: chunkId, quote }),
  suggestCitations: (claim: string, docIds: number[] | null) =>
    request<Suggestion[]>('POST', '/citations/suggest', { claim, doc_ids: docIds }),
  resolveCitations: (items: { doc_id: number; page: number; quote: string }[]) =>
    request<(ResolvedCitation | null)[]>('POST', '/citations/resolve', { items }),
  references: (docIds: number[], style: RefStyle) =>
    request<{ style: RefStyle; entries: string[] }>('POST', '/references', { doc_ids: docIds, style }),

  settings: () => request<Settings>('GET', '/settings'),
  updateSettings: (changes: Partial<Settings>) => request<Settings>('PATCH', '/settings', changes),
  modelSettings: () => request<ModelSettings>('GET', '/settings/model'),
  /** Switch model, set the API key or the reasoning effort; left-out fields stay as they are. */
  updateModel: (changes: { provider?: string; api_key?: string; reasoning_effort?: string; route?: string }) =>
    request<ModelSettings>('PUT', '/settings/model', changes),
  searchSettings: () => request<SearchSettings>('GET', '/settings/search'),
  sourceSettings: () => request<SourceSettings>('GET', '/settings/sources'),
  /** Set the CORE key (checked with CORE before it's saved); '' removes it. */
  updateSources: (coreApiKey: string) => request<SourceSettings>('PUT', '/settings/sources', { core_api_key: coreApiKey }),
  /** Where embeddings and reranking run, and the Baseten setup; checked before it's applied. */
  updateSearch: (changes: { where?: string; api_key?: string; embed_model?: string; rerank_model?: string }) =>
    request<SearchSettings>('PUT', '/settings/search', changes),
  /** A library document's file, e.g. a PDF to show in the app. */
  documentFile: async (docId: number) => (await send('GET', `/documents/${docId}/file`)).arrayBuffer(),

  exportDocx: async (content: unknown, style: DocxStyle, title: string) =>
    (await send('POST', '/export/docx', { content, style, title })).arrayBuffer(),

  drafts: () => request<DraftSummary[]>('GET', '/drafts'),
  createDraft: (title = 'Untitled') => request<{ id: number; title: string; content: string }>('POST', '/drafts', { title }),
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
    request<DraftResult>('POST', `/matrices/${id}/synthesis`, { instruction, columns }),
  /** The matrix as editor content: a table whose cells cite their quotes. */
  matrixTable: (id: number, columns: string[]) =>
    request<{ type: 'doc'; content: unknown[] }>('GET', `/matrices/${id}/table?columns=${encodeURIComponent(columns.join(','))}`),
  exportMatrix: async (id: number, format: 'xlsx' | 'csv' | 'docx', style: DocxStyle) =>
    (await send('GET', `/matrices/${id}/export?format=${format}&style=${style}`)).arrayBuffer(),
}
