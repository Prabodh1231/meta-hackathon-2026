<img src="desktop/src/assets/logo.svg" alt="" width="72" />

# Groundwork

**Write only what your sources say.**

Groundwork is a personal AI research assistant. It turns one researcher's scattered documents (papers, notes, slides, scans, web pages) into an organized local knowledge base, then helps them write from it with citations that are checked against the source.

Built for the **Meta Global AI Developer Hackathon** (Oct 27 – Nov 4, 2026).

## Meta models

| Model | Where | What it does here |
|---|---|---|
| **Muse Spark** (`muse-spark-1.3`) via the [Meta Model API](https://dev.meta.ai/products/meta-model-api) (`https://api.meta.ai/v1`) | `backend/app/providers/muse.py` | Everything that needs a language model: title, author and summary extraction, tagging, naming topics, OCR for scans and images, drafting with cited quotes, and judging whether each quote supports its claim. It takes text and images natively and returns strict JSON. |

Muse is the only language model the app uses: every piece of reading, writing and judging above, plus review matrices, gap finding and research proposals, is Muse's work. Every Muse request goes to Meta's Model API. Search is keyword search on this computer plus Muse ranking through the same API (the offline mock ranks by word overlap when no key is set). Only text chunks and images that need OCR leave the machine, for Muse. Without a key the app falls back to an offline **mock model** (see [Using Muse](#using-muse)).

## Search (no model of its own)

Search itself is not a model: SQLite FTS5/BM25 keyword search (`backend/app/retrieval.py` and `Library.search` in `backend/app/library.py`) finds the passages that match, and Muse — a Meta model, above — expands the query and ranks the best matches through the provider layer. No other model is downloaded, bundled or called, and no non-Meta model runs alongside Muse.

No other AI service is called: the only model API the app uses is Meta's. The other web services the app calls are scholarly indexes, not AI models: OpenAlex, Crossref, Semantic Scholar, CORE and arXiv, for paper details and free copies.

**Status:** the app runs on Muse once a key is in place.

## Documentation

- [User guide](docs/USER_GUIDE.md): using the app, screen by screen.
- [Architecture](docs/ARCHITECTURE.md): processes, modules, API, data and the frontend.
- [AI review panel](desktop/scripts/app-review/README.md): AI models use the real app and mark it from four points of view; the first marksheet, what we learned, and what to improve.

## Layout

```
backend/   Python FastAPI service: parsing, local index, topics, cited drafting, verification
  app/providers/   LLMProvider interface + MockProvider (offline) + MuseProvider (Meta Model API)
  tests/           pytest suite: full pipeline on a generated corpus
  scripts/         make_samples.py builds a demo corpus in ../samples
desktop/   Electron shell + React/Tiptap UI
docs/      User guide and architecture notes
samples/   Demo corpus (two research themes, six formats)
```

## Run it

```bash
# one-time setup
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # use .venv/bin/pip on macOS/Linux
cd ../desktop && npm install

# develop: Vite + Electron (Electron starts the backend itself)
npm run dev
```

Other commands:

- `npm run smoke`: builds and launches Electron, checks the spawned backend accepts the app's token and rejects requests without it, then quits.
- `cd backend && .venv/Scripts/python -m pytest`: runs the backend tests.
- `RC_BACKEND_URL=http://127.0.0.1:8765 npm run dev`: points Electron at a backend you started yourself, for example `uvicorn app.main:app --reload --port 8765` (the token check is off in this mode).

The app ships no search model, so it needs no model download and its keyword search works offline from the first start; Muse (and the scholarly indexes) need internet and, for Muse, a key. The library and drafts open at once: nothing has to load before searching, cite suggestions or imports.

Your library lives in `~/.groundwork/`: a SQLite database plus logs and settings. Set `RC_DATA_DIR` to put it somewhere else. A library from before the app was renamed, in `~/.research-companion/`, moves to `~/.groundwork/` the first time the app starts.

### Build a Windows installer

To give the app to someone who won't set up Python and Node, build an installer from a working dev setup:

```bash
cd backend && .venv/Scripts/pip install pyinstaller
cd ../desktop && npm run dist
```

`npm run dist` builds the UI, freezes the backend with PyInstaller (`backend/groundwork-backend.spec`, into `backend/dist/groundwork-backend`) and packages it with electron-builder into `desktop/release/Groundwork-Setup-<version>.exe`. The installed app runs that bundled backend instead of `backend/.venv`. It installs for the current user without admin rights.

Things to tell testers:

- Windows says the installer is from an **unknown publisher**, because it isn't signed. They click **More info → Run anyway**.
- Until they paste a key in **Settings → Model** and pick Muse, the app runs on the offline mock, which matches words instead of reading. Getting started and the amber *Offline mock* in the status bar both lead there. Give each tester their own key if you can; a shared key spends from your account.
- **Try the sample library** in Getting started loads six demo files and a demo draft with a checklist of what to try (see the [user guide](docs/USER_GUIDE.md#try-the-demo)). The installer ships the files from `samples/`.
- Their library lives in their own `~/.groundwork/`. The first start needs no internet (only Muse and the scholarly indexes do).

The packaged backend is the same code as in development. It leaves out PyMuPDF's optional layout add-on, which isn't in `requirements.txt`.

The backend runs detached from the terminal you launched from, so a Ctrl+C there doesn't kill it. If it exits anyway, the app restarts it (up to 3 times a minute) and the status bar shows "Backend offline, reconnecting…" meanwhile. Its output is appended to `~/.groundwork/logs/backend.log`. On Windows, run the app with `npm.cmd run dev` if PowerShell blocks `npm`.

## Using the app

The **[user guide](docs/USER_GUIDE.md)** walks through every screen with pictures. In short:

- The **rail** on the left switches between four places: **Write** (the draft, with its tools beside it), **Library** (your sources), **Network** (who cites whom) and **Matrix** (literature review matrices: one row per paper, a column per question such as sample, setting, method, findings and limitations, every cell a short answer resting on a quote found in the paper, beside sortable, filterable columns of each paper's details such as year, journal, citations and abstract; with gap finding, writing from the matrix, insertion into the draft as a cited table, and Excel, CSV and Word export). One fills the window at a time.
- The **top bar** has the draft's title (click it for your drafts: new, import a Word file, switch, delete), its save state and version, **one search box**, Export and Settings. In Write the search box finds anything and runs any action (Ctrl K); in the Library it filters your sources; in the Network it finds papers on a topic.
- Beside the draft, the **tabs**: **Assistant** (drafts from your sources with cited quotes), **Highlights** (what you highlighted and noted while reading a PDF in the app, ranked for the paragraph you're writing: insert one as a verified quote, or have Muse write from a few), **Ask** (a chatbot), **Citations** (confirm `cite` markers, and see a cited quote highlighted on its page), **References**, **Review** (duplication) and **History** (versions).
- The **Library** is a reference manager: **+ Add sources** (files, a folder, or a pasted link or path; or drop files on the window), subject folders, a sortable table, and the open paper's details.
- The **status bar** shows live counts for the draft; each one opens its tool.

How the code fits together is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## How it works

1. **Ingest.** Parsers for PDF (PyMuPDF), DOCX, PPTX, Markdown/text, HTML and URLs (trafilatura), and images. Each document is stored as **pages**, the units citations point to. Scanned PDF pages and images go to the model for OCR. Text is chunked on sentence boundaries, and each chunk keeps its page number and character offsets. Files and folders are added by a background job (`POST /ingest/jobs`) that reads eight files at a time and reports each one's stage (reading, Muse reading it, filing into folders), so the library shows live progress and an import can be stopped. Within a file, the metadata, summary and tag calls to Muse run alongside filing into folders: word statistics pick the folders worth asking about and Muse scores them from the paper's text, without waiting for the summary. Scanned PDF pages are OCR'd four at a time. If a Muse call fails (rate limit, timeout, Muse down), the file is still stored and searchable; what's missing is recorded and retried at the end of the import, and the library offers "Try again" for anything still missing. A retry never overwrites a field you corrected.
2. **Metadata.** The model extracts title, authors, year, venue and DOI from the first page, plus a summary. Metadata embedded in the file takes precedence when present. The keywords and JEL codes that authors print on the first pages are read with patterns instead, with no model call, and stored on the document; a paper with its own keyword list (three or more) uses it as its tags, so the model is only asked to tag papers without one. The JEL codes and keywords also go to the model when it rates a paper against a folder.
3. **Index.** Search is SQLite FTS5/BM25 keyword search, on this computer: the query and the short expansions Muse suggests are each searched, reciprocal rank fusion merges the lists, and Muse ranks the top passages in one call. A keyword-only mode makes no Muse call, for instant filtering. No vectors are computed or stored.
4. **Virtual folders.** Users create folders by typing a subject (say, "Digital finance") and choosing how closely a paper must match it, 50% by default. Scoring has two stages. Word statistics (TF-IDF over each paper's title, keywords, tags and summary) first rank every document for every folder at no cost. Muse then rates 0 to 100, by what the document says and not by file name or location, only the papers that rank above the library's average for that folder, which cuts Muse calls by about half; the rest keep a low word-statistics score. A paper is filed in every folder it reaches the threshold for, so one paper can sit in several. If Muse is unreachable the word-statistics ranking files the papers instead. Scores are stored, so moving a folder's threshold re-files instantly with no new calls. Folders are rows pointing at the original document, never copies. Users can take a paper out of a wrong folder or add one by hand; those corrections survive re-scoring and threshold changes. (The older k-means topic clustering is still in the backend API but no longer drives the library view.)
5. **Write.** The model drafts from the top-ranked passages. Every sentence must cite a passage ID and include a verbatim quote.
6. **Verify.** Each quote is located in the source; matching tolerates differences in whitespace, case, curly quotes and small OCR errors. The model then judges whether the surrounding text actually supports the claim, and the citation is marked `verified`, `weak`, `unsupported` or `quote_not_found`. Drafts appear immediately and citations are checked in the background. Clicking a chip opens the source page with the quote highlighted. Cite markers run the same search and check (up to three at once) and keep their results in the draft, so reopening it doesn't search again; a marker still searching when the draft was closed searches again when it reopens. **Recheck all citations** (Citations tab or Ctrl K) runs the check again for every chip, against its sentence as the draft reads now, and searches again for every marker. Gaps and passages written from a review matrix are kept with it (`matrix_findings`, with a snapshot of the rows they came from). In the draft their citations are blue and are checked against the whole matrix rather than one quote (`POST /findings/{id}/check`), since a comparison across studies is rarely backed by any single passage. **Write a proposal** turns chosen gaps, from one or several matrices, into a research proposal as a new draft (`app/proposal.py`): Muse suggests variables and their roles, the writer says what they rule out and what they have, and the proposal is checked against those exclusions; only its background, gap and earlier measures cite the reviewed studies, and **Has this been done?** searches OpenAlex for close matches. Word export leaves unconfirmed markers out of the text and puts a comment on their sentence saying what was found.
7. **References.** APA 7, MLA 9, IEEE and BibTeX, built from the documents cited in the draft. Pages use printed page numbers when the PDF has them.
8. **Word export.** "Export .docx" turns the draft into a Word file in APA, MLA or IEEE style. Citations become in-text citations placed before the sentence's closing punctuation, adjacent citations are merged, and a reference list is added at the end. Citations that are unverified, weak or unsupported, or whose quote wasn't found, get a Word comment. In Word, Review → Delete All Comments clears them before submitting.
9. **Versions.** The draft is snapshotted automatically every 10 minutes while you edit, before any large edit (one that changes 25% or more of a draft of 50+ words, such as inserting an assistant draft or deleting a section), and before a restore, so a restore can be undone. You can also save a named version ("Sent to advisor"). Any version can be compared with the current draft or another version at three levels, each with a percentage changed: the whole **document** (similarity, words added and removed), each **section** (matched by its heading, so editing one section doesn't mark the others changed) and each **paragraph** (a word-level diff). The 40 newest automatic snapshots are kept; naming one keeps it for good.
10. **Duplication check.** Looks for two things: sentences that copy or closely follow a passage in the library, and passages the draft repeats from earlier in itself. It compares runs of three words (word 3-grams) with no model call: candidate passages come from keyword search, and a sentence is flagged when at least half its 3-grams appear in one passage ("copied" from 85%). A match counts as cited when the sentence already cites that document. The result is the share of the draft's words flagged, overall and per category (matches a source, of which uncited, repeats itself), per paragraph and per sentence. While the panel is open, flagged text is underlined in the draft, and each match opens its source passage. It catches copied and lightly edited text, not heavy paraphrase.

11. **Cited papers.** Lists a paper's reference list (read as for the network), marks the works already in the library, and fetches free copies of the rest, one at a time or all at once (three in parallel, stoppable). See [Cited papers](#cited-papers).

Drafts are saved as the editor's own JSON in SQLite, not as .md files, because citations carry data (source, page, character positions, verification status) that Markdown can't hold. Versions are stored the same way, alongside a plain-text copy used for comparisons.

Security: the backend can read any local path, so it binds to 127.0.0.1 only, and Electron passes it a random token each launch that every request must carry.

## Most-cited papers you don't have

The Library's ⋯ menu, Ctrl K, and the Network view's list of missing works open **Most-cited papers you don't have**. Type a topic, or leave it empty for the whole library. The papers about it are found the way the Network's topic search finds them (their keywords, title, tags or summary name it, or the text mentions it in several places). Every work their reference lists cite that isn't in the library is ranked by how many of those papers cite it, each with the papers citing it. Unlike the Network, works cited only once are included. **Download top N** (or a work's own button) fetches free copies as described under [Cited papers](#cited-papers), and a downloaded work drops off the list. "Most cited" counts your own papers' citations, not citations worldwide: that's what says a work matters to this topic.

## Cited papers

Each entry in a paper's reference list is looked up in open scholarly indexes: **OpenAlex** first, then **Semantic Scholar**, then **CORE** (university and subject repositories) when you've saved a CORE API key in Settings → Library. An entry without a DOI is first searched for in **Crossref**, which finds the DOI of most published works, so the indexes are asked by DOI. Otherwise it's looked up by its title. A hit, in Crossref or an index, only counts when its title matches the entry's (a subtitle the entry left out is allowed) and its year is within one, so a look-alike paper is never downloaded. Entries with no DOI and a title under four words aren't searched.

Only open-access copies those indexes list are downloaded: open-access journals, arXiv and university or preprint repositories. A link only counts when it actually serves a PDF; publisher pages that answer with a login wall are skipped for the next link. Each entry ends as one of:

- **Downloaded:** saved to `~/.groundwork/papers/` as `Author Year - Title.pdf` and imported like any other file (metadata, summary, folders, citation network). The index's title, DOI and year replace what the PDF itself claims, since PDF titles are often file names, and a later look-up then finds the paper already in the library.
- **Free to read online:** a free page exists but no PDF could be downloaded; "Read online" opens it in the browser.
- **No free copy / Not found:** paywalled, or unknown to both indexes; "Search Google Scholar" opens a search for it. Nothing is downloaded.

Only the reference's DOI or title is sent to OpenAlex and Semantic Scholar. Set `RC_CONTACT_EMAIL=you@example.org` in the `.env` below to join OpenAlex's faster "polite pool"; it's optional.

## What the scholarly indexes add

After an import, each paper is looked up in **OpenAlex** by its DOI, or by a DOI **Crossref** finds for its title and year, or by OpenAlex's title search. One lookup brings:

- **The publisher's metadata:** journal, volume, issue, pages and publisher, and the authors as the publisher lists them (from Crossref when it has the DOI). Reference lists in every style then carry volume, issue and pages. A title Muse couldn't read is replaced too; one it did read is kept.
- **The authors' abstract**, shown above Muse's summary. It comes from OpenAlex, or Crossref, or Semantic Scholar when the publisher withholds it from the others.
- **The reference list as OpenAlex has it**, with a DOI for most entries. It's merged with the list read from the PDF: an entry read from the text gains the DOI of the same work, and works only OpenAlex lists are added (marked "from OpenAlex"). The citation network and the most-cited-missing list use the merged lists, so more citations are matched, by DOI rather than by title.
- **Citations worldwide** (the table's Cited column) and the **papers citing it**: a paper's **Citing papers…** lists them, the most cited or the newest first, with their abstracts and free copies to add.

A field you corrected under Edit details is never changed. When the DOI printed on a paper belongs to a different work in OpenAlex (often a paper it cites), nothing is taken from the lookup and its details say so. Only the DOI or title is sent. Turn it off in Settings → Library; **⋯ → Look up papers in scholarly indexes** does it on demand, and refreshes citation counts once every paper is done.

## Using Muse

Put the key in `~/.groundwork/.env`, the app's data folder, outside the repository:

```
RC_PROVIDER=muse
MUSE_API_KEY=<your Meta Model API key>
```

Restart the app. Or open **Settings → AI model**, paste the key and click **Save and switch**: it writes the same file and switches at once, with no restart. The backend reads that file on start; real environment variables override it. Defaults: `MUSE_API_BASE=https://api.meta.ai/v1`, `MUSE_MODEL=muse-spark-1.3`, `MUSE_REASONING_EFFORT=low`. Without the file, or with `RC_PROVIDER=mock`, everything runs offline on the mock.

`backend/app/providers/muse.py` uses Meta's OpenAI-compatible Chat Completions with strict JSON schemas. Muse's hidden reasoning counts against the output limit (a one-line verdict used ~500 tokens), so every call gets 4,096 tokens of headroom. A reply that's still cut off raises an error rather than returning half a JSON object. Rate limits and gateway timeouts are retried with backoff. Only text chunks, and images that need OCR, are sent to the API.

## Known gaps / next steps

- **Documents imported on the mock** keep its rough metadata, summaries and tags until they're re-imported with Muse on.
- **Installer:** Windows only, unsigned (Windows warns about an unknown publisher), with the default Electron icon.
- **Import jobs live in memory:** if the backend restarts mid-import, the files already added stay, but the rest of that import has to be started again.
- **Highlights on scanned pages:** a page without a text layer can't be selected, so it can't be highlighted.
