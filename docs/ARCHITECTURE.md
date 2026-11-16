# Architecture

How Groundwork is put together, for anyone changing it. For using the app, see the [user guide](USER_GUIDE.md). The [pipeline](#pipeline) section below walks through each step (ingest, index, folders, write, verify, references) in detail.

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
│   SQLite + FTS5 keyword search · Muse ranking           │
└───────────────┬──────────────────────────────────────────┘
                │ text passages and OCR images only
          Meta Model API (Muse)
```

- **Electron main** ([desktop/electron/main.cjs](../desktop/electron/main.cjs)) starts `uvicorn app.main:app` from `backend/.venv` on a free port, with `RC_API_TOKEN` (a random token per launch) and `RC_PARENT_PID`. Output goes to `~/.groundwork/logs/backend.log`. If the backend exits, it's restarted on the same port and token, at most 3 times a minute. Set `RC_BACKEND_URL` to use a backend you started yourself (the token check is off then).
- **One instance.** `main.cjs` takes Electron's single-instance lock: a second start focuses the open window instead of running a second backend on the same library.
- **Preload** ([desktop/electron/preload.cjs](../desktop/electron/preload.cjs)) exposes `window.rc`: the backend address and token, file and folder pickers, saving an export, moving a library file to the Recycle Bin, showing it in its folder, and the path of a dropped file. The renderer has no Node access (`contextIsolation`, `sandbox`).
- **Backend** ([backend/app/main.py](../backend/app/main.py)) is one FastAPI app around a `Library` object. Every request except `/health` needs the token. `API_VERSION` there must match `API_VERSION` in [desktop/src/api.ts](../desktop/src/api.ts); the status bar asks for a restart when they differ. No search model loads, so the backend answers at once and `/health` reports `search: "keyword+muse"`.
- **Parent watch** ([parent_watch.py](../backend/app/parent_watch.py)): the backend exits by itself if the Electron process that started it is gone.

## Backend modules

| Module | What it does |
|---|---|
| `main.py` | Routes, request models, the token check, error mapping (`LookupError` → 404, `ValueError` → 400). |
| `highlights.py` | Highlights and notes made in the reader: the selected text, its page and its offsets in the stored page text (found with `locate_quote`), so a highlight is cited like any quote and survives a paper being added again. Fetch ranks them for the paragraph being written by keyword (BM25-style) scoring of the highlight text and note; Write from these drafts from them through `Library.draft_from`, the notes passed as guidance. |
| `matrix.py` | Literature review matrices: for each paper, search restricted to it finds the passages for every column, one model call answers them all with a quote each, and the quote is located in the paper (page, offsets) or the cell marked unverified or not reported. Rows are read in the background, several at once, and resume after a restart. Also gaps, writing from the matrix (via `Library.draft_from`), the matrix as editor content (a table of citation chips) and Excel, CSV and Word export. |
| `library.py` | The knowledge base: ingestion, search, folders, the citation graph, drafting, verification, drafts and versions, duplicate checks. Holds one SQLite connection behind an `RLock`. |
| `backup.py` | The daily copy of `library.db` into `backups/`, with SQLite's backup so the snapshot is consistent while the library is in use. |
| `db.py` | Schema and migrations (SQLite in WAL mode, FTS5 for keyword search). |
| `ingest.py` | Parsers for PDF, DOCX, PPTX, Markdown/text, HTML and URLs, and images. Each returns page-addressed text. |
| `jobs.py` | Background imports: eight files at a time (`INGEST_WORKERS` in `library.py`), with per-file stages for the progress card. Within a file, the Muse calls (metadata, summary, tags) run alongside folder scoring; word statistics pick the folders worth asking Muse about. |
| `retrieval.py` | Keyword (FTS5/BM25) queries and reciprocal rank fusion. Passage ranking itself is the provider's `rank_passages` (Muse, or the mock's word overlap), called from `Library.search`. |
| `citations.py` | Finding a model's quote in the source, tolerant of whitespace, case, curly quotes and OCR slips. |
| `references.py` | APA 7, MLA 9, IEEE and BibTeX from stored metadata, after `_clean` decodes HTML entities and drops a DOI or link that isn't one. |
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
| Writing | `POST /write/draft`, `POST /citations/verify`, `POST /citations/suggest` and `/citations/suggest/stream` (the same candidates as JSON lines, first unchecked and then after each support check, so a cite marker turns green on the first supported one), `POST /citations/resolve`, `POST /references` |
| Drafts | `GET/POST /drafts`, `GET/PUT/DELETE /drafts/{id}`, `PATCH /drafts/{id}` (name; empty: its first line), `POST /drafts/import`, `POST /drafts/convert-docx`, `POST /drafts/check-duplicates` |
| Versions | `GET/POST /drafts/{id}/versions`, `GET/PATCH/DELETE /drafts/{id}/versions/{v}`, `POST …/compare`, `POST …/restore` |
| Matrices | `GET/POST /matrices`, `GET /matrices/columns`, `POST /matrices/papers` (a folder's or a topic's papers), `GET/PATCH/DELETE /matrices/{id}`, `PUT /matrices/{id}/cells/{doc}/{column}`, `POST /matrices/{id}/rerun`, `POST /matrices/{id}/gaps`, `POST /matrices/{id}/synthesis`, `GET /matrices/{id}/table`, `GET /matrices/{id}/export?format=xlsx\|csv\|docx` |
| Settings | `GET/PATCH /settings` (preferences, validated against `USER_SETTINGS` in `library.py`), `GET/PUT /settings/model` (Muse or mock, key, reasoning effort; the key is never returned), `GET /settings/search` (keyword search on this computer, ranking by the provider) |
| Files | `GET /documents/{id}/file`: a library document's file, for the PDF viewer and pdf.js. Only files the library holds. |
| Other | `POST /export/docx`, `GET /search` |

## Data

Everything lives in `~/.groundwork/` (or `RC_DATA_DIR`):

- `library.db`: SQLite. Documents, their pages (the unit a citation points to), chunks with text and character offsets (plus a legacy vector column older databases carry, which nothing reads), tags, folders and scores, parsed reference lists, drafts and their versions, review matrices (`matrices`, `matrix_rows`, `matrix_cells`), settings.
- `logs/backend.log`.
- `backups/`: copies of `library.db` ([backup.py](../backend/app/backup.py)), at most one a day, made in the background when the backend starts (before the library opens, so before any migration); the newest three are kept.
- `.env`: optional settings and the Muse key (`RC_PROVIDER`, `MUSE_API_KEY`, `MUSE_MODEL`, `MUSE_REASONING_EFFORT`, `RC_CONTACT_EMAIL`). Real environment variables override it. **Settings → AI model** rewrites the provider, key and effort lines here (keeping the rest) and swaps the provider without a restart.
- Preferences from the Settings window live in the database (`meta` table, key `settings`), so they follow the library.

Library files are never copied or moved; documents store their source path or URL.

## Frontend

React 19 with Tiptap 3, built by Vite. Entry: [desktop/src/App.tsx](../desktop/src/App.tsx).

**Layout.** `App` holds the shared state and draws:

- the **app bar**: the draft's name (click to rename; an unnamed draft shows its first line in italics), save state, the version button that opens `HistoryPanel` as a menu (`versionsOpen`) and the change since it, a **Drafts** button for the drafts menu (`DraftsPanel`), the search box, `ExportControl`, Settings;
- the **rail**, which sets `mode`: `write`, `library` or `network`;
- one **view** per mode:
  - *Write:* `WritingEditor` and the side panel, which has three tools (`tab`): **Compose** (`HighlightsPanel`, ranked for the cursor's paragraph by itself, then one Muse box switching, by `compose`, between `AssistantPanel` for drafting from sources and `AskPanel`, a plain chatbot kept per draft in `ask_turns`); **Check** (`CheckSummary`, `CitePanel`, then `ReviewPanel`; `SourceViewer` or `FindingView` while a cited passage is open); **Sources** (`SourcesPanel`: the cited sources with their citations' marks, and `ReferencesPanel`). Panels that hold work in progress stay mounted while hidden. `CitationWire` draws the line from a citation to its quote. Closed, the panel is a strip of the three icons (`toolsOpen`); focus mode (`focusMode`) hides the rail, panel, app bar and dock. The duplication check runs in the background while Write is open (`runCheck`: once the draft has text, then 15 s after edits settle, or 4 s while Check is open); its underlines show only while Check is.
  - *Library:* `LibraryPanel`: folders, a sortable table and the open paper's details.
  - *Network:* `NetworkView`, which loads Cytoscape only when it's first opened.
- `ErrorBoundary` (around the app and the reader window, in `main.tsx`): an error thrown while drawing shows a Reload screen instead of an empty window.
- the **dock** (status bar) and the dialogs: `CommandPalette` (Ctrl K: a combobox over a listbox, in sections), `WordImportDialog`, `DuplicateFilesDialog`, `CitedPapersDialog`, `MissingPapersDialog`, `SettingsDialog`, `ReaderDialog`. Settings, the palette and the reader dialog keep Tab inside them with `useFocusTrap`, which gives focus back when they close.
- `ChipCard`: pointing at a citation in the draft shows its verdict, quote and reason (chips carry an `aria-label` with the verdict in words, and no `title`).
- **One vocabulary.** `editor/citeStatus.ts` holds the verdict words (`CITATION_WORD`, `MARK_WORD`: Supported, Partly supported, Not supported, Checking…, plus a marker's Finding a source… and No source found), the flagged-first order, and `tally()`, the one counting rule (supported, needs attention, of which to confirm, checking) used by the status bar, Check's badge and `CheckSummary`. The chips' CSS words, `StatusBadge`, `CiteLegend` and the marker tooltips use the same words.

**PDFs** ([pdf.ts](../desktop/src/pdf.ts)) are fetched once per document with the app's token and shared:

- **Open PDF** opens `ReaderDialog`, the app's own reader. In the desktop app it gets a window of its own (`rc:open-reader` in main.cjs): the same page loaded with `?reader=<id>&page=<n>`, which [main.tsx](../desktop/src/main.tsx) renders as `ReaderWindow` instead of the app, with the preload bridge so it reaches the backend itself; one window, reused, opening maximized until it's sized and then remembering that in `reader-window.json`. In a plain browser it's a dialog covering the window. Either way: each page drawn with pdf.js when it scrolls near the view, with pdf.js's `TextLayer` over it so text can be selected, and the paper's highlights placed with the same matching as `SourceViewer` (`placeQuote` in pdf.ts). A selection on one page is saved as a highlight (`POST /documents/{id}/highlights`); clicking one opens its note. **Insert in draft** finds the selection in the page's stored text (`POST /citations/resolve`) and sends a verified citation to the draft: through `onInsertQuote` when the reader is a dialog, or from its own window through `rc:insert-quote` (main.cjs forwards it to the main window, whose `onInsertQuote` listener inserts it). Its toolbar tracks the page in view (the first page whose bottom is past a third of the view), zooms by redrawing the pages at a multiple of the reading width (100% is at most 900 px; **Fit width** is the window's width), keeping the page in view, and finds text: every page's `getTextContent` is read once and searched, and the matches on the current match's page are marked with CSS custom highlights (`CSS.highlights`: `::highlight(reader-find)` for the current one, `reader-find-all` for the rest) on ranges found in that page's text layer, so the DOM isn't changed. A side list shows the paper's highlights; picking one scrolls to its boxes (`.reader-hl[data-hid]`) and flashes them.
- **Open in PDF viewer** in the reader asks the main process (`rc:open-pdf` in [main.cjs](../desktop/electron/main.cjs)) to show the file in a separate, resizable window running Chromium's PDF viewer, straight from disk, for search and print. Only files the library holds are opened (the same check as Show in folder); the window has no preload, so no bridge to the backend; it's reused for the next PDF and remembers its size and place in `pdf-window.json` in Electron's user-data folder.
- Double-clicking a library row opens the paper: a PDF as above, any other library file through `rc:open-file` (`shell.openPath`, after the same library check, and only for the kinds the library reads), a web page in the browser.
- `SourceViewer` draws a cited page with pdf.js (loaded on first use: about 430 KB, plus a 1.3 MB worker) and places the quote on it: the backend's matched text is compared with pdf.js's text items with case, spacing, ligatures and curly quotes folded away, and each item it covers gets a highlight box. When the quote can't be placed, it falls back to the extracted text.

**The search box** is the palette launcher in Write, and a filter whose text `App` passes down as `query` in the Library and Network.

**Views stay mounted.** The Write view is only hidden when you switch, so the editor keeps its undo history and the Library its folder, sort and open paper. `LibraryPanel` is memoized and gets stable callbacks, so typing in the draft doesn't redraw the library. Views use `overflow: clip`, not `hidden`: scrolling a highlighted quote into view must not scroll the whole view.

**The editor** ([WritingEditor.tsx](../desktop/src/components/WritingEditor.tsx)) is Tiptap with three custom nodes and marks in [desktop/src/editor/](../desktop/src/editor/):

- `citation`: a verified citation chip with its quote, page and offsets;
- `citeMark`: the fixed-size `cite` marker whose search runs in the background (three at a time);
- `reviewMarks`: decorations for duplication underlines;
- `museMark`: the `muse` mark on text Muse wrote (`insertDraft(…, { muse: true })` and `insertHTML` go through `insertMuse`). A plugin takes the mark off whatever the writer types or pastes into it; transactions that insert Muse's text or load a draft carry `MUSE_META` so they keep it, and undo/redo and the app's own patches are skipped. Export ignores it.

Autosave runs 0.8 s after the last edit. Saves are queued one at a time, so an older copy can't land after a newer one. `flush()` saves at once; it runs before switching drafts and before restoring a version.

**API client** ([api.ts](../desktop/src/api.ts)) adds the token, and tells three cases apart: the backend can't be reached (it's restarting), an endpoint is missing (the backend is older than the UI), and a real error.

**Settings** are loaded once the backend is up and applied in `App`: the page's width, text size and font are `data-page-width`, `data-text-size` and `data-doc-font` on `<html>`, which [styles.css](../desktop/src/styles.css) turns into `--page-w`, `--page-size` and `--page-font`. Until they arrive, `DEFAULT_SETTINGS` in `SettingsDialog.tsx` applies.

**Styles** are one sheet, [styles.css](../desktop/src/styles.css), built on CSS variables. Light and dark themes switch `data-theme` on the root ([theme.ts](../desktop/src/theme.ts)).

## Pipeline

1. **Ingest.** Parsers for PDF (PyMuPDF), DOCX, PPTX, Markdown/text, HTML and URLs (trafilatura), and images. Each document is stored as **pages**, the units citations point to. Scanned PDF pages and images go to the model for OCR. Text is chunked on sentence boundaries, and each chunk keeps its page number and character offsets. Files and folders are added by a background job (`POST /ingest/jobs`) that reads eight files at a time and reports each one's stage (reading, Muse reading it, filing into folders), so the library shows live progress and an import can be stopped. Within a file, the metadata, summary and tag calls to Muse run alongside filing into folders: word statistics pick the folders worth asking about and Muse scores them from the paper's text, without waiting for the summary. Scanned PDF pages are OCR'd four at a time. If a Muse call fails (rate limit, timeout, Muse down), the file is still stored and searchable; what's missing is recorded and retried at the end of the import, and the library offers "Try again" for anything still missing. A retry never overwrites a field you corrected.
2. **Metadata.** The model extracts title, authors, year, venue and DOI from the first page, plus a summary. Metadata embedded in the file takes precedence when present. The keywords and JEL codes that authors print on the first pages are read with patterns instead, with no model call, and stored on the document; a paper with its own keyword list (three or more) uses it as its tags, so the model is only asked to tag papers without one. The JEL codes and keywords also go to the model when it rates a paper against a folder.
3. **Index.** Search is SQLite FTS5/BM25 keyword search, on this computer: the query and the short expansions Muse suggests are each searched, reciprocal rank fusion merges the lists, and Muse ranks the top passages in one call. A keyword-only mode makes no Muse call, for instant filtering. Muse's answers are kept for the session (`RecentCache` in `retrieval.py`, the last 500 of each): a query's expansions, and the scores for a query and a set of passages (the passage text is part of the key, so changed text is scored again). So a review matrix expands each column's question once, not once per paper, and searching a sentence again (Cite, **Recheck all**, a matrix row read again) costs no search call. Empty or failed answers aren't kept, and changing the model in Settings forgets them all. No vectors are computed or stored.
4. **Virtual folders.** Users create folders by typing a subject (say, "Digital finance") and choosing how closely a paper must match it, 50% by default. Scoring has two stages. Word statistics (TF-IDF over each paper's title, keywords, tags and summary) first rank every document for every folder at no cost. Muse then rates 0 to 100, by what the document says and not by file name or location, only the papers that rank above the library's average for that folder, which cuts Muse calls by about half; the rest keep a low word-statistics score. A paper is filed in every folder it reaches the threshold for, so one paper can sit in several. If Muse is unreachable the word-statistics ranking files the papers instead. Scores are stored, so moving a folder's threshold re-files instantly with no new calls. Folders are rows pointing at the original document, never copies. Users can take a paper out of a wrong folder or add one by hand; those corrections survive re-scoring and threshold changes. (The older k-means topic clustering is still in the backend API but no longer drives the library view.)
5. **Write.** The model drafts from the top-ranked passages. Every sentence must cite a passage ID and include a verbatim quote.
6. **Verify.** Each quote is located in the source; matching tolerates differences in whitespace, case, curly quotes and small OCR errors. The model then judges whether the surrounding text actually supports the claim, and the citation is marked `verified`, `weak`, `unsupported` or `quote_not_found`. Drafts appear immediately and citations are checked in the background. Clicking a chip opens the source page with the quote highlighted. Cite markers run the same search and check (up to three at once) and keep their results in the draft, so reopening it doesn't search again; a marker still searching when the draft was closed searches again when it reopens. **Recheck all** (in Check, or Ctrl K) runs the check again for every chip, against its sentence as the draft reads now, and searches again for every marker. Gaps and passages written from a review matrix are kept with it (`matrix_findings`, with a snapshot of the rows they came from). In the draft their citations are blue and are checked against the whole matrix rather than one quote (`POST /findings/{id}/check`), since a comparison across studies is rarely backed by any single passage. **Write a proposal** turns chosen gaps, from one or several matrices, into a research proposal as a new draft (`app/proposal.py`): Muse suggests variables and their roles, the writer says what they rule out and what they have, and the proposal is checked against those exclusions; only its background, gap and earlier measures cite the reviewed studies, and **Has this been done?** searches OpenAlex for close matches. Word export leaves unconfirmed markers out of the text and puts a comment on their sentence saying what was found.
7. **References.** APA 7, MLA 9, IEEE and BibTeX, built from the documents cited in the draft. Pages use printed page numbers when the PDF has them.
8. **Word export.** "Export .docx" turns the draft into a Word file in APA, MLA or IEEE style. Citations become in-text citations placed before the sentence's closing punctuation, adjacent citations are merged, and a reference list is added at the end. Citations that are unverified, weak or unsupported, or whose quote wasn't found, get a Word comment. In Word, Review → Delete All Comments clears them before submitting.
9. **Versions.** The draft is snapshotted automatically every 10 minutes while you edit, before any large edit (one that changes 25% or more of a draft of 50+ words, such as inserting an assistant draft or deleting a section), and before a restore, so a restore can be undone. You can also save a named version ("Sent to advisor"). Any version can be compared with the current draft or another version at three levels, each with a percentage changed: the whole **document** (similarity, words added and removed), each **section** (matched by its heading, so editing one section doesn't mark the others changed) and each **paragraph** (a word-level diff). The 40 newest automatic snapshots are kept; naming one keeps it for good.
10. **Duplication check.** Looks for two things: sentences that copy or closely follow a passage in the library, and passages the draft repeats from earlier in itself. It compares runs of three words (word 3-grams) with no model call: candidate passages come from keyword search, and a sentence is flagged when at least half its 3-grams appear in one passage ("copied" from 85%). A match counts as cited when the sentence already cites that document. The result is the share of the draft's words flagged, overall and per category (matches a source, of which uncited, repeats itself), per paragraph and per sentence. While the panel is open, flagged text is underlined in the draft, and each match opens its source passage. It catches copied and lightly edited text, not heavy paraphrase.
11. **Cited papers.** Lists a paper's reference list (read as for the network), marks the works already in the library, and fetches free copies of the rest, one at a time or all at once (three in parallel, stoppable). See [Cited papers](#cited-papers).

Drafts are saved as the editor's own JSON in SQLite, not as .md files, because citations carry data (source, page, character positions, verification status) that Markdown can't hold. Versions are stored the same way, alongside a plain-text copy used for comparisons.

Security: the backend can read any local path, so it binds to 127.0.0.1 only, and Electron passes it a random token each launch that every request must carry.

### Most-cited papers you don't have

The Library's ⋯ menu, Ctrl K, and the Network view's list of missing works open **Most-cited papers you don't have**. Type a topic, or leave it empty for the whole library. The papers about it are found the way the Network's topic search finds them (their keywords, title, tags or summary name it, or the text mentions it in several places). Every work their reference lists cite that isn't in the library is ranked by how many of those papers cite it, each with the papers citing it. Unlike the Network, works cited only once are included. **Download top N** (or a work's own button) fetches free copies as described under [Cited papers](#cited-papers), and a downloaded work drops off the list. "Most cited" counts your own papers' citations, not citations worldwide: that's what says a work matters to this topic.

### Cited papers

Each entry in a paper's reference list is looked up in open scholarly indexes: **OpenAlex** first, then **Semantic Scholar**, then **CORE** (university and subject repositories) when you've saved a CORE API key in Settings → Library. An entry without a DOI is first searched for in **Crossref**, which finds the DOI of most published works, so the indexes are asked by DOI. Otherwise it's looked up by its title. A hit, in Crossref or an index, only counts when its title matches the entry's (a subtitle the entry left out is allowed) and its year is within one, so a look-alike paper is never downloaded. Entries with no DOI and a title under four words aren't searched.

Only open-access copies those indexes list are downloaded: open-access journals, arXiv and university or preprint repositories. A link only counts when it actually serves a PDF; publisher pages that answer with a login wall are skipped for the next link. Each entry ends as one of:

- **Downloaded:** saved to `~/.groundwork/papers/` as `Author Year - Title.pdf` and imported like any other file (metadata, summary, folders, citation network). The index's title, DOI and year replace what the PDF itself claims, since PDF titles are often file names, and a later look-up then finds the paper already in the library.
- **Free to read online:** a free page exists but no PDF could be downloaded; "Read online" opens it in the browser.
- **No free copy / Not found:** paywalled, or unknown to both indexes; "Search Google Scholar" opens a search for it. Nothing is downloaded.

Only the reference's DOI or title is sent to OpenAlex and Semantic Scholar. Set `RC_CONTACT_EMAIL=you@example.org` in the `.env` below to join OpenAlex's faster "polite pool"; it's optional.

### What the scholarly indexes add

After an import, each paper is looked up in **OpenAlex** by its DOI, or by a DOI **Crossref** finds for its title and year, or by OpenAlex's title search. One lookup brings:

- **The publisher's metadata:** journal, volume, issue, pages and publisher, and the authors as the publisher lists them (from Crossref when it has the DOI). Reference lists in every style then carry volume, issue and pages. A title Muse couldn't read is replaced too; one it did read is kept.
- **The authors' abstract**, shown above Muse's summary. It comes from OpenAlex, or Crossref, or Semantic Scholar when the publisher withholds it from the others.
- **The reference list as OpenAlex has it**, with a DOI for most entries. It's merged with the list read from the PDF: an entry read from the text gains the DOI of the same work, and works only OpenAlex lists are added (marked "from OpenAlex"). The citation network and the most-cited-missing list use the merged lists, so more citations are matched, by DOI rather than by title.
- **Citations worldwide** (the table's Cited column) and the **papers citing it**: a paper's **Citing papers…** lists them, the most cited or the newest first, with their abstracts and free copies to add.

A field you corrected under Edit details is never changed. When the DOI printed on a paper belongs to a different work in OpenAlex (often a paper it cites), nothing is taken from the lookup and its details say so. Only the DOI or title is sent. Turn it off in Settings → Library; **⋯ → Look up papers in scholarly indexes** does it on demand, and refreshes citation counts once every paper is done.

### Muse calls

`backend/app/providers/muse.py` uses Meta's OpenAI-compatible Chat Completions with strict JSON schemas. Muse's hidden reasoning counts against the output limit (a one-line verdict used ~500 tokens), so every call gets 4,096 tokens of headroom. A reply that's still cut off raises an error rather than returning half a JSON object. Rate limits and gateway timeouts are retried with backoff. Support checks (`judge_support`) run at `CHECK_EFFORT` ("low") whatever effort is set for writing: a check's time is its reasoning, and on 24 claim and passage pairs "low" gave the same verdict as "medium" on 22, as often as medium agrees with itself. Only text chunks, and images that need OCR, are sent to the API.

Settings → AI model writes the key to `~/.groundwork/.env` (`RC_PROVIDER=muse`, `MUSE_API_KEY=...`); real environment variables override that file. Defaults: `MUSE_API_BASE=https://api.meta.ai/v1`, `MUSE_MODEL=muse-spark-1.3`, `MUSE_REASONING_EFFORT=low`. With `RC_PROVIDER=mock` everything runs offline on the mock.

## Development

```bash
cd desktop && npm run dev        # Vite + Electron; Electron starts the backend
npm run typecheck                # TypeScript
npm run smoke                    # build, launch, check the token and the backend restart
cd ../backend && .venv/Scripts/python -m pytest
```

`npm run web` serves the UI alone in a browser. It talks to a backend on `127.0.0.1:8765` without a token: start one with `uvicorn app.main:app --port 8765` from `backend/`.
