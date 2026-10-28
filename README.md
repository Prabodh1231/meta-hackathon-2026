# Research Companion

A personal AI research companion. It turns one researcher's scattered documents (papers, notes, slides, scans, web pages) into an organized local knowledge base, then helps them write from it with citations that are checked against the source.

Built for the **Meta Global AI Developer Hackathon** (Oct 27 – Nov 4, 2026).

## Meta models

| Model | Where | What it does here |
|---|---|---|
| **Muse Spark** (`muse-spark-1.3`) via the [Meta Model API](https://api.meta.ai/v1) | `backend/app/providers/muse.py` | Everything that needs a language model: title, author and summary extraction, tagging, naming topics, OCR for scans and images, drafting with cited quotes, and judging whether each quote supports its claim. It takes text and images natively and returns strict JSON. |

Muse is the only hosted model the app calls. Only text chunks, and images that need OCR, leave the machine. Embeddings and reranking are open models that run locally (see [How it works](#how-it-works)), so your library stays on your computer. Without a key the app falls back to an offline **mock model** (see [Using Muse](#using-muse)).

**Status:** the app runs on Muse once a key is in place.

## Layout

```
backend/   Python FastAPI service: parsing, local index, topics, cited drafting, verification
  app/providers/   LLMProvider interface + MockProvider (offline) + MuseProvider (Meta Model API)
  tests/           pytest suite: full pipeline on a generated corpus
  scripts/         make_samples.py builds a demo corpus in ../samples
desktop/   Electron shell + React/Tiptap UI
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

The backend runs detached from the terminal you launched from, so a Ctrl+C there doesn't kill it. If it exits anyway, the app restarts it (up to 3 times a minute) and the header shows "Backend offline, reconnecting…" meanwhile. Its output is appended to `~/.research-companion/logs/backend.log`. On Windows, run the app with `npm.cmd run dev` if PowerShell blocks `npm`.

## How it works

1. **Ingest.** Parsers for PDF (PyMuPDF), DOCX, PPTX, Markdown/text, HTML and URLs (trafilatura), and images. Each document is stored as **pages**, the units citations point to. Scanned PDF pages and images go to the model for OCR. Text is chunked on sentence boundaries, and each chunk keeps its page number and character offsets.
2. **Metadata.** The model extracts title, authors, year, venue and DOI, plus a summary and tags. Metadata embedded in the file takes precedence when present.
3. **Index.** Embeddings come from a local model (BGE-M3 on the GPU when there is one, otherwise `fastembed` with bge-small) and are stored in SQLite; search is a numpy cosine scan. That's fast enough for one researcher's library, and there's no native vector database to bundle into Electron. If neither is available, a hashing embedder takes over. Changing embedders re-embeds the whole library automatically.
4. **Virtual folders.** Users create folders by typing a subject (say, "Digital finance") and choosing how closely a paper must match it, 50% by default. Scoring has two stages. The local embeddings first rank every document for every folder at no cost. Muse then rates 0 to 100, by what the document says and not by file name or location, only the papers that rank above the library's average for that folder, which cuts Muse calls by about half; the rest keep a low embedding-only score. A paper is filed in every folder it reaches the threshold for, so one paper can sit in several. If Muse is unreachable the embedding ranking files the papers instead. Scores are stored, so moving a folder's threshold re-files instantly with no new calls. Folders are rows pointing at the original document, never copies. Users can take a paper out of a wrong folder or add one by hand; those corrections survive re-scoring and threshold changes. (The older k-means topic clustering is still in the backend API but no longer drives the library view.)
5. **Write.** The model drafts from the top-ranked passages. Every sentence must cite a passage ID and include a verbatim quote.
6. **Verify.** Each quote is located in the source; matching tolerates differences in whitespace, case, curly quotes and small OCR errors. The model then judges whether the surrounding text actually supports the claim, and the citation is marked `verified`, `weak`, `unsupported` or `quote_not_found`. Drafts appear immediately and citations are checked in the background. Clicking a chip opens the source page with the quote highlighted.
7. **References.** APA 7, MLA 9, IEEE and BibTeX, built from the documents cited in the draft. Pages use printed page numbers when the PDF has them.
8. **Word export.** "Export .docx" turns the draft into a Word file in APA, MLA or IEEE style. Citations become in-text citations placed before the sentence's closing punctuation, adjacent citations are merged, and a reference list is added at the end. Citations that are unverified, weak or unsupported, or whose quote wasn't found, get a Word comment. In Word, Review → Delete All Comments clears them before submitting.

Drafts are saved as the editor's own JSON in SQLite, not as .md files, because citations carry data (source, page, character positions, verification status) that Markdown can't hold.

Security: the backend can read any local path, so it binds to 127.0.0.1 only, and Electron passes it a random token each launch that every request must carry.

## Using Muse

Put the key in `~/.research-companion/.env`, the app's data folder, outside the repository:

```
RC_PROVIDER=muse
MUSE_API_KEY=<your Meta Model API key>
```

Restart the app. The backend reads that file on start; real environment variables override it. Defaults: `MUSE_API_BASE=https://api.meta.ai/v1`, `MUSE_MODEL=muse-spark-1.3`, `MUSE_REASONING_EFFORT=low`. Without the file, or with `RC_PROVIDER=mock`, everything runs offline on the mock.

`backend/app/providers/muse.py` uses Meta's OpenAI-compatible Chat Completions with strict JSON schemas. Muse's hidden reasoning counts against the output limit (a one-line verdict used ~500 tokens), so every call gets 4,096 tokens of headroom. A reply that's still cut off raises an error rather than returning half a JSON object. Rate limits and gateway timeouts are retried with backoff. Only text chunks, and images that need OCR, are sent to the API.

## Known gaps / next steps

- **Documents imported on the mock** keep its rough metadata, summaries and tags until they're re-imported with Muse on.
- **Packaging:** the Python backend still needs bundling with PyInstaller and shipping as an Electron `extraResources` binary. Today `main.cjs` runs `backend/.venv`.
- **Ingestion speed:** files are ingested four at a time with their Muse calls overlapped, but a folder is still one request, so the UI shows no per-file progress. Add a background job with progress reporting.
- **Source viewer:** shows extracted page text. Rendering the PDF page itself with pdf.js would make highlights match the original layout.
