import type { Citation, Doc, DraftResult, Health, IngestResult, PageText, RefStyle, Topic } from './types'

// Outside Electron (plain `vite` in a browser) fall back to a backend started by hand.
const FALLBACK = { baseUrl: 'http://127.0.0.1:8765', token: '' }
let configPromise: Promise<{ baseUrl: string; token: string }> | null = null

function config() {
  configPromise ??= window.rc ? window.rc.config() : Promise.resolve(FALLBACK)
  return configPromise
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { baseUrl, token } = await config()
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-rc-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* non-JSON error body */
    }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return res.json() as Promise<T>
}

export const api = {
  health: () => request<Health>('GET', '/health'),

  ingestPath: (path: string) => request<{ results: IngestResult[] }>('POST', '/ingest/path', { path }),
  ingestUrl: (url: string) => request<Doc>('POST', '/ingest/url', { url }),

  documents: () => request<Doc[]>('GET', '/documents'),
  updateDocument: (id: number, patch: Partial<Doc>) => request<Doc>('PATCH', `/documents/${id}`, patch),
  deleteDocument: (id: number) => request<{ ok: boolean }>('DELETE', `/documents/${id}`),
  page: (docId: number, page: number) => request<PageText>('GET', `/documents/${docId}/pages/${page}`),

  topics: () => request<Topic[]>('GET', '/topics'),
  rebuildTopics: () => request<Topic[]>('POST', '/topics/rebuild'),
  renameTopic: (id: number, label: string) => request<Topic>('PATCH', `/topics/${id}`, { label }),
  mergeTopics: (sourceIds: number[], intoId: number) =>
    request<Topic[]>('POST', '/topics/merge', { source_ids: sourceIds, into_id: intoId }),

  draft: (instruction: string, context: string, docIds: number[] | null) =>
    request<DraftResult>('POST', '/write/draft', { instruction, context, doc_ids: docIds }),
  verify: (claim: string, chunkId: number, quote: string) =>
    request<Citation>('POST', '/citations/verify', { claim, chunk_id: chunkId, quote }),
  references: (docIds: number[], style: RefStyle) =>
    request<{ style: RefStyle; entries: string[] }>('POST', '/references', { doc_ids: docIds, style }),

  getDraft: (id: number) => request<{ id: number; title: string; content: string }>('GET', `/drafts/${id}`),
  saveDraft: (id: number, title: string, content: string) => request('PUT', `/drafts/${id}`, { title, content }),
}
