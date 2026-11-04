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
- **Backend** ([backend/app/main.py](../backend/app/main.py)) is one FastAPI app around a `Library` object. Every request except `/health` needs the token. `API_VERSION` there must match `API_VERSION` in [desktop/src/api.ts](../desktop/src/api.ts); the status bar asks for a restart when they differ. The embedding model loads in a background thread (`LoadingEmbedder` in [embeddings.py](../backend/app/embeddings.py)), re-embedding the library first if the model changed, so the backend answers within about 2 s; the re-embed runs outside the library lock, so listing stays responsive; `/health` reports `embedder: "loading"` (or `"failed"`) until then, and anything that embeds waits for it.
- **Parent watch** ([parent_watch.py](../backend/app/parent_watch.py)): the backend exits by itself if the Electron process that started it is gone.

## Backend modules

| Module | What it does |
|---|---|
| `main.py` | Routes, request models, the token check, error mapping (`LookupError` → 404, `ValueError` → 400). |
| `highlights.py` | Highlights and notes made in the reader: the selected text, its page and its offsets in the stored page text (found with `locate_quote`), so a highlight is cited like any quote and survives a paper being added again. Fetch ranks them for the paragraph being written with the library's embedder; Write from these drafts from them through `Library.draft_from`, the notes passed as guidance. |
| `matrix.py` | Literature review matrices: for each paper, search restricted to it finds the passages for every column, one model call answers them all with a quote each, and the quote is located in the paper (page, offsets) or the cell marked unverified or not reported. Rows are read in the background, several at once, and resume after a restart. Also gaps, writing from the matrix (via `Library.draft_from`), the matrix as editor content (a table of citation chips) and Excel, CSV and Word export. |
| `library.py` | The knowledge base: ingestion, search, folders, the citation graph, drafting, verification, drafts and versions, duplicate checks. Holds one SQLite connection behind an `RLock`. |
| `db.py` | Schema and migrations (SQLite in WAL mode, FTS5 for keyword search). |
| `ingest.py` | Parsers for PDF, DOCX, PPTX, Markdown/text, HTML and URLs, and images. Each returns page-addressed text. |
| `jobs.py` | Background imports: eight files at a time (`INGEST_WORKERS` in `library.py`), with per-file stages for the progress card. Within a file, the Muse calls (metadata, summary, tags, folder scoring) run alongside the embedding; folder scoring starts once the vectors are ready. |
| `embeddings.py` | Embedders: bge-small via fastembed on this computer, the only model the app ships (BGE-M3 was measured and dropped: see [backend/eval/README.md](../backend/eval/README.md)), a hashing fallback, and `LoadingEmbedder`, which loads it in the background. `bundled_model` finds the installer's copy of a model in `RC_MODELS_DIR` (Electron passes `resources/models`, filled by [scripts/fetch_models.py](../backend/scripts/fetch_models.py)); the embedder and the local reranker load from there instead of downloading. |
| `retrieval.py` | Keyword (BM25) queries, reciprocal rank fusion, and the local cross-encoder reranker. |
| `citations.py` | Finding a model's quote in the source, tolerant of whitespace, case, curly quotes and OCR slips. |
| `references.py` | APA 7, MLA 9, IEEE and BibTeX from stored metadata. |
| `refparse.py`, `citegraph.py` | Reading reference lists; who cites whom, shared references, works the library lacks. |
| `openaccess.py` | Free copies of cited works from open scholarly indexes. |
| `paper_meta.py` | Keywords and JEL codes printed on a paper's first page, by pattern. |
| `topics.py` | k-means topics (kept in the API; the library view uses folders). |
| `draft_review.py` | A draft as text at three levels; duplication and version comparison. |
| `docx_import.py`, `export_docx.py` | Word in and out. |
| `dupfiles.py` | Duplicate files in the library. Suggests; never deletes. |
| `providers/` | The model interface (`base.py`), Muse over Meta's OpenAI-compatible Model API (`muse.py`), an offline mock (`mock.py`), and the prompts and JSON schemas (`prompts.py`). |

## API

All JSON. Main groups (see `main.py` for the full list):

| Area | Endpoints |
|---|---|
| Health | `GET /health`, `GET /model/activity?since=` (Muse retries, route switches and the steps of a proposal being written, for `WaitStatus` to explain a slow answer) |
| Adding sources | `POST /ingest/jobs`, `GET /ingest/jobs[/{id}]`, `POST /ingest/jobs/{id}/cancel`, `POST /ingest/url`, `POST /library/fill-missing` |
| Documents | `GET/PATCH/DELETE /documents/{id}`, `GET /documents`, `GET /documents/{id}/pages/{page}`, `POST /library/duplicates` |
| Folders | `GET/POST /folders`, `PATCH/DELETE /folders/{id}`, `POST /folders/classify`, `POST /documents/{id}/folders`, `PUT /documents/{id}/folders/{folder}` |
| Citation network | `GET /graph?q=`, `GET /missing?q=`, `GET /documents/{id}/cited`, `POST /documents/{id}/cited/{idx}/fetch` |
| Writing | `POST /write/draft`, `POST /citations/verify`, `POST /citations/suggest`, `POST /citations/resolve`, `POST /references` |
| Drafts | `GET/POST /drafts`, `GET/PUT/DELETE /drafts/{id}`, `PATCH /drafts/{id}` (name; empty: its first line), `POST /drafts/import`, `POST /drafts/convert-docx`, `POST /drafts/check-duplicates` |
| Versions | `GET/POST /drafts/{id}/versions`, `GET/PATCH/DELETE /drafts/{id}/versions/{v}`, `POST …/compare`, `POST …/restore` |
| Matrices | `GET/POST /matrices`, `GET /matrices/columns`, `POST /matrices/papers` (a folder's or a topic's papers), `GET/PATCH/DELETE /matrices/{id}`, `PUT /matrices/{id}/cells/{doc}/{column}`, `POST /matrices/{id}/rerun`, `POST /matrices/{id}/gaps`, `POST /matrices/{id}/synthesis`, `GET /matrices/{id}/table`, `GET /matrices/{id}/export?format=xlsx\|csv\|docx` |
| Settings | `GET/PATCH /settings` (preferences, validated against `USER_SETTINGS` in `library.py`), `GET/PUT /settings/model` (Muse or mock, key, reasoning effort; the key is never returned), `GET /settings/search` (the embedding and reranking models, both local) |
| Files | `GET /documents/{id}/file`: a library document's file, for the PDF viewer and pdf.js. Only files the library holds. |
| Other | `POST /export/docx`, `GET /search` |

## Data

Everything lives in `~/.research-companion/` (or `RC_DATA_DIR`):

- `library.db`: SQLite. Documents, their pages (the unit a citation points to), chunks with embeddings and character offsets, tags, folders and scores, parsed reference lists, drafts and their versions, review matrices (`matrices`, `matrix_rows`, `matrix_cells`), settings.
- The embedding model cache.
- `logs/backend.log`.
- `.env`: optional settings and the Muse key (`RC_PROVIDER`, `MUSE_API_KEY`, `MUSE_MODEL`, `MUSE_REASONING_EFFORT`, `RC_EMBEDDER`, `RC_RERANKER`, `RC_CONTACT_EMAIL`). Real environment variables override it. **Settings → AI model** rewrites the provider, key and effort lines here (keeping the rest) and swaps the provider without a restart.
- Preferences from the Settings window live in the database (`meta` table, key `settings`), so they follow the library.

Library files are never copied or moved; documents store their source path or URL.

## Frontend

React 19 with Tiptap 3, built by Vite. Entry: [desktop/src/App.tsx](../desktop/src/App.tsx).

**Layout.** `App` holds the shared state and draws:

- the **app bar**: the title (opening the drafts menu, `DraftsPanel`), save state and version, the search box, `ExportControl`, Settings;
- the **rail**, which sets `mode`: `write`, `library` or `network`;
- one **view** per mode:
  - *Write:* `WritingEditor` and the side panel. Its tabs are `AssistantPanel`, `AskPanel` (a plain chatbot, kept per draft in `ask_turns`), Citations (`CitePanel`, or `SourceViewer` while a cited passage is open), `ReferencesPanel`, `ReviewPanel` and `HistoryPanel`. `CitationWire` draws the line from a citation to its quote. Closed, the panel is a strip of the tabs' icons (`toolsOpen`); focus mode (`focusMode`) hides the rail, panel, app bar and dock.
  - *Library:* `LibraryPanel`: folders, a sortable table and the open paper's details.
  - *Network:* `NetworkView`, which loads Cytoscape only when it's first opened.
- the **dock** (status bar) and the dialogs: `CommandPalette` (Ctrl K), `WordImportDialog`, `DuplicateFilesDialog`, `CitedPapersDialog`, `MissingPapersDialog`, `SettingsDialog`, `ReaderDialog`.

**PDFs** ([pdf.ts](../desktop/src/pdf.ts)) are fetched once per document with the app's token and shared:

- **Open PDF** opens `ReaderDialog`, the app's own reader. In the desktop app it gets a window of its own (`rc:open-reader` in main.cjs): the same page loaded with `?reader=<id>&page=<n>`, which [main.tsx](../desktop/src/main.tsx) renders as `ReaderWindow` instead of the app, with the preload bridge so it reaches the backend itself; one window, reused, opening maximized until it's sized and then remembering that in `reader-window.json`. In a plain browser it's a dialog covering the window. Either way: each page drawn with pdf.js when it scrolls near the view, with pdf.js's `TextLayer` over it so text can be selected, and the paper's highlights placed with the same matching as `SourceViewer` (`placeQuote` in pdf.ts). A selection on one page is saved as a highlight (`POST /documents/{id}/highlights`); clicking one opens its note.
- **Open in PDF viewer** in the reader asks the main process (`rc:open-pdf` in [main.cjs](../desktop/electron/main.cjs)) to show the file in a separate, resizable window running Chromium's PDF viewer, straight from disk, for search and print. Only files the library holds are opened (the same check as Show in folder); the window has no preload, so no bridge to the backend; it's reused for the next PDF and remembers its size and place in `pdf-window.json` in Electron's user-data folder.
- Double-clicking a library row opens the paper: a PDF as above, any other library file through `rc:open-file` (`shell.openPath`, after the same library check, and only for the kinds the library reads), a web page in the browser.
- `SourceViewer` draws a cited page with pdf.js (loaded on first use: about 430 KB, plus a 1.3 MB worker) and places the quote on it: the backend's matched text is compared with pdf.js's text items with case, spacing, ligatures and curly quotes folded away, and each item it covers gets a highlight box. When the quote can't be placed, it falls back to the extracted text.

**The search box** is the palette launcher in Write, and a filter whose text `App` passes down as `query` in the Library and Network.

**Views stay mounted.** The Write view is only hidden when you switch, so the editor keeps its undo history and the Library its folder, sort and open paper. `LibraryPanel` is memoized and gets stable callbacks, so typing in the draft doesn't redraw the library. Views use `overflow: clip`, not `hidden`: scrolling a highlighted quote into view must not scroll the whole view.

**The editor** ([WritingEditor.tsx](../desktop/src/components/WritingEditor.tsx)) is Tiptap with three custom nodes and marks in [desktop/src/editor/](../desktop/src/editor/):

- `citation`: a verified citation chip with its quote, page and offsets;
- `citeMark`: the fixed-size `cite` marker whose search runs in the background (three at a time);
- `reviewMarks`: decorations for duplication underlines.

Autosave runs 0.8 s after the last edit. Saves are queued one at a time, so an older copy can't land after a newer one. `flush()` saves at once; it runs before switching drafts and before restoring a version.

**API client** ([api.ts](../desktop/src/api.ts)) adds the token, and tells three cases apart: the backend can't be reached (it's restarting), an endpoint is missing (the backend is older than the UI), and a real error.

**Settings** are loaded once the backend is up and applied in `App`: the page's width, text size and font are `data-page-width`, `data-text-size` and `data-doc-font` on `<html>`, which [styles.css](../desktop/src/styles.css) turns into `--page-w`, `--page-size` and `--page-font`. Until they arrive, `DEFAULT_SETTINGS` in `SettingsDialog.tsx` applies.

**Styles** are one sheet, [styles.css](../desktop/src/styles.css), built on CSS variables. Light and dark themes switch `data-theme` on the root ([theme.ts](../desktop/src/theme.ts)).

## Development

```bash
cd desktop && npm run dev        # Vite + Electron; Electron starts the backend
npm run typecheck                # TypeScript
npm run smoke                    # build, launch, check the token and the backend restart
cd ../backend && .venv/Scripts/python -m pytest
```

`npm run web` serves the UI alone in a browser. It talks to a backend on `127.0.0.1:8765` without a token: start one with `uvicorn app.main:app --port 8765` from `backend/`.
