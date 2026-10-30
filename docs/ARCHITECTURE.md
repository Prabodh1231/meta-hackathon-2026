# Architecture

How Research Companion is put together, for anyone changing it. For using the app, see the [user guide](USER_GUIDE.md). The [README](../README.md#how-it-works) describes the pipeline (ingest, index, folders, write, verify, references) in more depth.

## Processes

```
┌──────────────────────── Electron ────────────────────────┐
│ main process (electron/main.cjs)                         │
│   • picks a free port and a per-launch token             │
│   • spawns the Python backend, restarts it if it exits   │
│   • file dialogs, saving exports, Recycle Bin            │
│                                                          │
│ renderer (React, sandboxed)  ──preload.cjs (window.rc)── │
└───────────────┬──────────────────────────────────────────┘
                │ HTTP on 127.0.0.1, header x-rc-token
┌───────────────▼──────────────────────────────────────────┐
│ backend (FastAPI, backend/app)                           │
│   SQLite + FTS5 · numpy vector scan · local embeddings   │
└───────────────┬──────────────────────────────────────────┘
                │ text passages and OCR images only
          Meta Model API (Muse)
```

- **Electron main** ([desktop/electron/main.cjs](../desktop/electron/main.cjs)) starts `uvicorn app.main:app` from `backend/.venv` on a free port, with `RC_API_TOKEN` (a random token per launch) and `RC_PARENT_PID`. Output goes to `~/.research-companion/logs/backend.log`. If the backend exits, it's restarted on the same port and token, at most 3 times a minute. Set `RC_BACKEND_URL` to use a backend you started yourself (the token check is off then).
- **Preload** ([desktop/electron/preload.cjs](../desktop/electron/preload.cjs)) exposes `window.rc`: the backend address and token, file and folder pickers, saving an export, moving a library file to the Recycle Bin, showing it in its folder, and the path of a dropped file. The renderer has no Node access (`contextIsolation`, `sandbox`).
- **Backend** ([backend/app/main.py](../backend/app/main.py)) is one FastAPI app around a `Library` object. Every request except `/health` needs the token. `API_VERSION` there must match `API_VERSION` in [desktop/src/api.ts](../desktop/src/api.ts); the status bar asks for a restart when they differ.
- **Parent watch** ([parent_watch.py](../backend/app/parent_watch.py)): the backend exits by itself if the Electron process that started it is gone.

## Backend modules

| Module | What it does |
|---|---|
| `main.py` | Routes, request models, the token check, error mapping (`LookupError` → 404, `ValueError` → 400). |
| `library.py` | The knowledge base: ingestion, search, folders, the citation graph, drafting, verification, drafts and versions, duplicate checks. Holds one SQLite connection behind an `RLock`. |
| `db.py` | Schema and migrations (SQLite in WAL mode, FTS5 for keyword search). |
| `ingest.py` | Parsers for PDF, DOCX, PPTX, Markdown/text, HTML and URLs, and images. Each returns page-addressed text. |
| `jobs.py` | Background imports: four files at a time, with per-file stages for the progress card. |
| `embeddings.py` | Local embedders: BGE-M3 on a GPU, bge-small via fastembed on CPU, a hashing fallback. |
| `retrieval.py` | Keyword (BM25) queries, reciprocal rank fusion, the optional local reranker. |
| `citations.py` | Finding a model's quote in the source, tolerant of whitespace, case, curly quotes and OCR slips. |
| `references.py` | APA 7, MLA 9, IEEE and BibTeX from stored metadata. |
| `refparse.py`, `citegraph.py` | Reading reference lists; who cites whom, shared references, works the library lacks. |
| `openaccess.py` | Free copies of cited works from open scholarly indexes. |
| `paper_meta.py` | Keywords and JEL codes printed on a paper's first page, by pattern. |
| `topics.py` | k-means topics (kept in the API; the library view uses folders). |
| `draft_review.py` | A draft as text at three levels; duplication and version comparison. |
| `docx_import.py`, `export_docx.py` | Word in and out. |
| `dupfiles.py` | Duplicate files in the library. Suggests; never deletes. |
| `providers/` | The model interface (`base.py`), Muse over the OpenAI-compatible Meta Model API (`muse.py`), an offline mock (`mock.py`), and the prompts and JSON schemas (`prompts.py`). |

## API

All JSON. Main groups (see `main.py` for the full list):

| Area | Endpoints |
|---|---|
| Health | `GET /health` |
| Adding sources | `POST /ingest/jobs`, `GET /ingest/jobs[/{id}]`, `POST /ingest/jobs/{id}/cancel`, `POST /ingest/url`, `POST /library/fill-missing` |
| Documents | `GET/PATCH/DELETE /documents/{id}`, `GET /documents`, `GET /documents/{id}/pages/{page}`, `POST /library/duplicates` |
| Folders | `GET/POST /folders`, `PATCH/DELETE /folders/{id}`, `POST /folders/classify`, `POST /documents/{id}/folders`, `PUT /documents/{id}/folders/{folder}` |
| Citation network | `GET /graph?q=`, `GET /missing?q=`, `GET /documents/{id}/cited`, `POST /documents/{id}/cited/{idx}/fetch` |
| Writing | `POST /write/draft`, `POST /citations/verify`, `POST /citations/suggest`, `POST /citations/resolve`, `POST /references` |
| Drafts | `GET/POST /drafts`, `GET/PUT/DELETE /drafts/{id}`, `POST /drafts/import`, `POST /drafts/convert-docx`, `POST /drafts/check-duplicates` |
| Versions | `GET/POST /drafts/{id}/versions`, `GET/PATCH/DELETE /drafts/{id}/versions/{v}`, `POST …/compare`, `POST …/restore` |
| Other | `GET/PATCH /settings`, `POST /export/docx`, `GET /search` |

## Data

Everything lives in `~/.research-companion/` (or `RC_DATA_DIR`):

- `library.db`: SQLite. Documents, their pages (the unit a citation points to), chunks with embeddings and character offsets, tags, folders and scores, parsed reference lists, drafts and their versions, settings.
- The embedding model cache.
- `logs/backend.log`.
- `.env`: optional settings and the Muse key (`RC_PROVIDER`, `MUSE_API_KEY`, `MUSE_MODEL`, `RC_EMBEDDER`, `RC_RERANKER`, `RC_CONTACT_EMAIL`). Real environment variables override it.

Library files are never copied or moved; documents store their source path or URL.

## Frontend

React 19 with Tiptap 3, built by Vite. Entry: [desktop/src/App.tsx](../desktop/src/App.tsx).

**Layout.** `App` holds the shared state and draws:

- the **app bar**: the title (opening the drafts menu, `DraftsPanel`), save state and version, the search box, `ExportControl`, Settings;
- the **rail**, which sets `mode`: `write`, `library` or `network`;
- one **view** per mode:
  - *Write:* `WritingEditor` and the side panel. Its tabs are `AssistantPanel`, Citations (`CitePanel`, or `SourceViewer` while a cited passage is open), `ReferencesPanel`, `ReviewPanel` and `HistoryPanel`. `CitationWire` draws the line from a citation to its quote.
  - *Library:* `LibraryPanel`: folders, a sortable table and the open paper's details.
  - *Network:* `NetworkView`, which loads Cytoscape only when it's first opened.
- the **dock** (status bar) and the dialogs: `CommandPalette` (Ctrl K), `WordImportDialog`, `DuplicateFilesDialog`, `CitedPapersDialog`, `MissingPapersDialog`, `SettingsDialog`.

**The search box** is the palette launcher in Write, and a filter whose text `App` passes down as `query` in the Library and Network.

**Views stay mounted.** The Write view is only hidden when you switch, so the editor keeps its undo history and the Library its folder, sort and open paper. `LibraryPanel` is memoized and gets stable callbacks, so typing in the draft doesn't redraw the library. Views use `overflow: clip`, not `hidden`: scrolling a highlighted quote into view must not scroll the whole view.

**The editor** ([WritingEditor.tsx](../desktop/src/components/WritingEditor.tsx)) is Tiptap with three custom nodes and marks in [desktop/src/editor/](../desktop/src/editor/):

- `citation`: a verified citation chip with its quote, page and offsets;
- `citeMark`: the fixed-size `cite` marker whose search runs in the background (three at a time);
- `reviewMarks`: decorations for duplication underlines.

Autosave runs 0.8 s after the last edit. Saves are queued one at a time, so an older copy can't land after a newer one. `flush()` saves at once; it runs before switching drafts and before restoring a version.

**API client** ([api.ts](../desktop/src/api.ts)) adds the token, and tells three cases apart: the backend can't be reached (it's restarting), an endpoint is missing (the backend is older than the UI), and a real error.

**Styles** are one sheet, [styles.css](../desktop/src/styles.css), built on CSS variables. Light and dark themes switch `data-theme` on the root ([theme.ts](../desktop/src/theme.ts)).

## Development

```bash
cd desktop && npm run dev        # Vite + Electron; Electron starts the backend
npm run typecheck                # TypeScript
npm run smoke                    # build, launch, check the token and the backend restart
cd ../backend && .venv/Scripts/python -m pytest
```

`npm run web` serves the UI alone in a browser. It talks to a backend on `127.0.0.1:8765` without a token: start one with `uvicorn app.main:app --port 8765` from `backend/`.
