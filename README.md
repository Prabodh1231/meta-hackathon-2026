# Research Companion

A personal AI research companion. It turns one researcher's scattered documents (papers, notes, slides, scans, web pages) into an organized local knowledge base, then helps them write from it with citations that are checked against the source.

Built for the **Meta Global AI Developer Hackathon** (Oct 27 – Nov 4, 2026).

## Meta models

| Model | Where | What it does here |
|---|---|---|
| **Muse Spark** (`muse-spark-1.3`) via the [Meta Model API](https://api.meta.ai/v1), and `muse-spark-open-1026` via [Baseten's Model APIs](https://www.baseten.co/) | `backend/app/providers/muse.py`, `failover.py` | Everything that needs a language model: title, author and summary extraction, tagging, naming topics, OCR for scans and images, drafting with cited quotes, and judging whether each quote supports its claim. It takes text and images natively and returns strict JSON. |

Muse is the only hosted model the app calls. Only text chunks, and images that need OCR, leave the machine. Embeddings and reranking are open models that run locally (see [How it works](#how-it-works)), so your library stays on your computer. Without a key the app falls back to an offline **mock model** (see [Using Muse](#using-muse)).

**Status:** the app runs on Muse once a key is in place.

## Documentation

- [User guide](docs/USER_GUIDE.md): using the app, screen by screen.
- [Architecture](docs/ARCHITECTURE.md): processes, modules, API, data and the frontend.

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

On first launch the backend downloads the local embedding model into the data folder: bge-small (about 30 MB) on a CPU-only machine, or BGE-M3 (about 2 GB) when an NVIDIA GPU is found. The UI shows "Starting backend…" until that finishes.

For the GPU model, install a CUDA build of PyTorch before the other requirements, for example `pip install torch --index-url https://download.pytorch.org/whl/cu124`. BGE-M3 runs in fp16 and fits in 6 GB of VRAM. Set `RC_EMBEDDER=fastembed` to keep the small CPU model.

Your library lives in `~/.research-companion/`: a SQLite database plus the embedding model cache. Set `RC_DATA_DIR` to put it somewhere else.

The backend runs detached from the terminal you launched from, so a Ctrl+C there doesn't kill it. If it exits anyway, the app restarts it (up to 3 times a minute) and the status bar shows "Backend offline, reconnecting…" meanwhile. Its output is appended to `~/.research-companion/logs/backend.log`. On Windows, run the app with `npm.cmd run dev` if PowerShell blocks `npm`.

## Using the app

The **[user guide](docs/USER_GUIDE.md)** walks through every screen with pictures. In short:

- The **rail** on the left switches between four places: **Write** (the draft, with its tools beside it), **Library** (your sources), **Network** (who cites whom) and **Matrix** (literature review matrices: one row per paper, a column per question such as sample, setting, method, findings and limitations, every cell a short answer resting on a quote found in the paper, beside sortable, filterable columns of each paper's details such as year, journal, citations and abstract; with gap finding, writing from the matrix, insertion into the draft as a cited table, and Excel, CSV and Word export). One fills the window at a time.
- The **top bar** has the draft's title (click it for your drafts: new, import a Word file, switch, delete), its save state and version, **one search box**, Export and Settings. In Write the search box finds anything and runs any action (Ctrl K); in the Library it filters your sources; in the Network it finds papers on a topic.
- Beside the draft, five **tabs**: **Assistant** (drafts from your sources with cited quotes), **Citations** (confirm `cite` markers, and see a cited quote highlighted on its page), **References**, **Review** (duplication) and **History** (versions).
- The **Library** is a reference manager: **+ Add sources** (files, a folder, or a pasted link or path; or drop files on the window), subject folders, a sortable table, and the open paper's details.
- The **status bar** shows live counts for the draft; each one opens its tool.

How the code fits together is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## How it works

1. **Ingest.** Parsers for PDF (PyMuPDF), DOCX, PPTX, Markdown/text, HTML and URLs (trafilatura), and images. Each document is stored as **pages**, the units citations point to. Scanned PDF pages and images go to the model for OCR. Text is chunked on sentence boundaries, and each chunk keeps its page number and character offsets. Files and folders are added by a background job (`POST /ingest/jobs`) that reads eight files at a time and reports each one's stage (reading, Muse reading it, filing into folders), so the library shows live progress and an import can be stopped. Within a file, the metadata, summary and tag calls to Muse run alongside the local embedding, and so does filing into folders: as soon as the embedding is done it picks the folders worth asking about and Muse scores them from the paper's text, without waiting for the summary. Scanned PDF pages are OCR'd four at a time. If a Muse call fails (rate limit, timeout, Muse down), the file is still stored and searchable; what's missing is recorded and retried at the end of the import, and the library offers "Try again" for anything still missing. A retry never overwrites a field you corrected.
2. **Metadata.** The model extracts title, authors, year, venue and DOI from the first page, plus a summary. Metadata embedded in the file takes precedence when present. The keywords and JEL codes that authors print on the first pages are read with patterns instead, with no model call, and stored on the document; a paper with its own keyword list (three or more) uses it as its tags, so the model is only asked to tag papers without one. The JEL codes and keywords also go to the model when it rates a paper against a folder.
3. **Index.** Embeddings come from a local model (BGE-M3 on the GPU when there is one, otherwise `fastembed` with bge-small), or from BGE-M3 on Baseten for a machine without a GPU (see [Search on Baseten](#search-on-baseten)), and are stored in SQLite; search is a numpy cosine scan. That's fast enough for one researcher's library, and there's no native vector database to bundle into Electron. If neither is available, a hashing embedder takes over. Changing embedders re-embeds the whole library automatically.
4. **Virtual folders.** Users create folders by typing a subject (say, "Digital finance") and choosing how closely a paper must match it, 50% by default. Scoring has two stages. The local embeddings first rank every document for every folder at no cost. Muse then rates 0 to 100, by what the document says and not by file name or location, only the papers that rank above the library's average for that folder, which cuts Muse calls by about half; the rest keep a low embedding-only score. A paper is filed in every folder it reaches the threshold for, so one paper can sit in several. If Muse is unreachable the embedding ranking files the papers instead. Scores are stored, so moving a folder's threshold re-files instantly with no new calls. Folders are rows pointing at the original document, never copies. Users can take a paper out of a wrong folder or add one by hand; those corrections survive re-scoring and threshold changes. (The older k-means topic clustering is still in the backend API but no longer drives the library view.)
5. **Write.** The model drafts from the top-ranked passages. Every sentence must cite a passage ID and include a verbatim quote.
6. **Verify.** Each quote is located in the source; matching tolerates differences in whitespace, case, curly quotes and small OCR errors. The model then judges whether the surrounding text actually supports the claim, and the citation is marked `verified`, `weak`, `unsupported` or `quote_not_found`. Drafts appear immediately and citations are checked in the background. Clicking a chip opens the source page with the quote highlighted. Cite markers run the same search and check (up to three at once) and keep their results in the draft, so reopening it doesn't search again; a marker still searching when the draft was closed searches again when it reopens. **Recheck all citations** (Citations tab or Ctrl K) runs the check again for every chip, against its sentence as the draft reads now, and searches again for every marker. Word export leaves unconfirmed markers out of the text and puts a comment on their sentence saying what was found.
7. **References.** APA 7, MLA 9, IEEE and BibTeX, built from the documents cited in the draft. Pages use printed page numbers when the PDF has them.
8. **Word export.** "Export .docx" turns the draft into a Word file in APA, MLA or IEEE style. Citations become in-text citations placed before the sentence's closing punctuation, adjacent citations are merged, and a reference list is added at the end. Citations that are unverified, weak or unsupported, or whose quote wasn't found, get a Word comment. In Word, Review → Delete All Comments clears them before submitting.
9. **Versions.** The draft is snapshotted automatically every 10 minutes while you edit, before any large edit (one that changes 25% or more of a draft of 50+ words, such as inserting an assistant draft or deleting a section), and before a restore, so a restore can be undone. You can also save a named version ("Sent to advisor"). Any version can be compared with the current draft or another version at three levels, each with a percentage changed: the whole **document** (similarity, words added and removed), each **section** (matched by its heading, so editing one section doesn't mark the others changed) and each **paragraph** (a word-level diff). The 40 newest automatic snapshots are kept; naming one keeps it for good.
10. **Duplication check.** Looks for two things: sentences that copy or closely follow a passage in the library, and passages the draft repeats from earlier in itself. It compares runs of three words (word 3-grams) with no model call: candidate passages come from keyword and embedding search, and a sentence is flagged when at least half its 3-grams appear in one passage ("copied" from 85%). A match counts as cited when the sentence already cites that document. The result is the share of the draft's words flagged, overall and per category (matches a source, of which uncited, repeats itself), per paragraph and per sentence. While the panel is open, flagged text is underlined in the draft, and each match opens its source passage. It catches copied and lightly edited text, not heavy paraphrase.

11. **Cited papers.** Lists a paper's reference list (read as for the network), marks the works already in the library, and fetches free copies of the rest, one at a time or all at once (three in parallel, stoppable). See [Cited papers](#cited-papers).

Drafts are saved as the editor's own JSON in SQLite, not as .md files, because citations carry data (source, page, character positions, verification status) that Markdown can't hold. Versions are stored the same way, alongside a plain-text copy used for comparisons.

Security: the backend can read any local path, so it binds to 127.0.0.1 only, and Electron passes it a random token each launch that every request must carry.

## Most-cited papers you don't have

The Library's ⋯ menu, Ctrl K, and the Network view's list of missing works open **Most-cited papers you don't have**. Type a topic, or leave it empty for the whole library. The papers about it are found the way the Network's topic search finds them (their keywords, title, tags or summary name it, or the text mentions it in several places). Every work their reference lists cite that isn't in the library is ranked by how many of those papers cite it, each with the papers citing it. Unlike the Network, works cited only once are included. **Download top N** (or a work's own button) fetches free copies as described under [Cited papers](#cited-papers), and a downloaded work drops off the list. "Most cited" counts your own papers' citations, not citations worldwide: that's what says a work matters to this topic.

## Cited papers

Each entry in a paper's reference list is looked up in open scholarly indexes: **OpenAlex** first, then **Semantic Scholar**, then **CORE** (university and subject repositories) when you've saved a CORE API key in Settings → Library. An entry without a DOI is first searched for in **Crossref**, which finds the DOI of most published works, so the indexes are asked by DOI. Otherwise it's looked up by its title. A hit, in Crossref or an index, only counts when its title matches the entry's (a subtitle the entry left out is allowed) and its year is within one, so a look-alike paper is never downloaded. Entries with no DOI and a title under four words aren't searched.

Only open-access copies those indexes list are downloaded: open-access journals, arXiv and university or preprint repositories. A link only counts when it actually serves a PDF; publisher pages that answer with a login wall are skipped for the next link. Each entry ends as one of:

- **Downloaded:** saved to `~/.research-companion/papers/` as `Author Year - Title.pdf` and imported like any other file (metadata, summary, folders, citation network). The index's title, DOI and year replace what the PDF itself claims, since PDF titles are often file names, and a later look-up then finds the paper already in the library.
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

Put the key in `~/.research-companion/.env`, the app's data folder, outside the repository:

```
RC_PROVIDER=muse
MUSE_API_KEY=<your Meta Model API key>
```

Restart the app. Or open **Settings → AI model**, paste the key and click **Save and switch**: it writes the same file and switches at once, with no restart. The backend reads that file on start; real environment variables override it. Defaults: `MUSE_API_BASE=https://api.meta.ai/v1`, `MUSE_MODEL=muse-spark-1.3`, `MUSE_REASONING_EFFORT=low`. Without the file, or with `RC_PROVIDER=mock`, everything runs offline on the mock.

### Muse on Baseten

Muse Spark is also served by Baseten (`meta-models/muse-spark-open-1026`), which measured about twice as fast as Meta's API on the app's own requests: folder scoring 4.1 s against 7.8 s, a summary 2.2 s against 3.6 s, with the same titles and authors and folder scores within a few points. With a Baseten key in the `.env` (`BASETEN_API_KEY`), each Muse request goes to Baseten first and to Meta's API if Baseten fails or is rate-limited; a failing service is passed over for a minute (`backend/app/providers/failover.py`). **Settings → AI model → Where Muse runs** chooses *Baseten, then Meta* (the default with both keys), *Meta's API* or *Baseten only*; it's `MUSE_ROUTE` (`baseten-first`, `meta`, `baseten`) in the `.env`.

`backend/app/providers/muse.py` uses Meta's OpenAI-compatible Chat Completions with strict JSON schemas. Muse's hidden reasoning counts against the output limit (a one-line verdict used ~500 tokens), so every call gets 4,096 tokens of headroom. A reply that's still cut off raises an error rather than returning half a JSON object. Rate limits and gateway timeouts are retried with backoff. Only text chunks, and images that need OCR, are sent to the API.

## Search on Baseten

On a computer without an NVIDIA GPU, the app falls back to the small bge-small model, which finds sources less well. It can instead run the same BGE-M3 model, and optionally a larger reranker, on [Baseten](https://www.baseten.co/):

1. In your Baseten account, deploy `BAAI/bge-m3` with Baseten's embeddings engine (BEI), and optionally a reranker such as `BAAI/bge-reranker-v2-m3` (BEI with `webserver_default_route: /rerank`).
2. In **Settings → Search & embeddings**, paste your Baseten API key and each model's ID, choose where search runs, and click **Save and check**. The app tries each deployment before switching.

*Auto* (the default) uses this computer's GPU when it has one and Baseten only when it doesn't; *This computer* never uses Baseten. The embedding deployment runs the model the GPU runs, so moving between the two doesn't re-embed the library. On Baseten, the text of passages, questions and cited sentences is sent there; files and drafts stay local. The settings are kept in the data folder's `.env` (`BASETEN_API_KEY`, `BASETEN_EMBED_MODEL`, `BASETEN_RERANK_MODEL`, `RC_EMBEDDER`, `RC_RERANKER`).

On a machine with a GPU, Baseten doesn't make imports faster: embedding a paper takes about a second and finishes while Muse is still reading it.

## Known gaps / next steps

- **Documents imported on the mock** keep its rough metadata, summaries and tags until they're re-imported with Muse on.
- **Packaging:** the Python backend still needs bundling with PyInstaller and shipping as an Electron `extraResources` binary. Today `main.cjs` runs `backend/.venv`.
- **Import jobs live in memory:** if the backend restarts mid-import, the files already added stay, but the rest of that import has to be started again.
- **PDF viewer download name:** Chromium's viewer shows and downloads the file under a random blob name; Show in folder finds the original.
