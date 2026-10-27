# Research Companion

A personal AI research companion. It turns one researcher's scattered documents (papers, notes, slides, scans, web pages) into an organized local knowledge base, then helps them write from it with citations that are checked against the source.

**Status:** the app is fully runnable offline against a **mock model**. The real model is Meta's **Muse** via the Meta Model API, which plugs in behind one interface once there's API access (see [Switching to Muse](#switching-to-muse)).

## Layout

```
backend/   Python FastAPI service: parsing, local index, topics, cited drafting, verification
  app/providers/   LLMProvider interface + MockProvider (offline) + MuseProvider (stub)
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

On first launch the backend downloads the local embedding model (bge-small, about 30 MB) into the data folder. The UI shows "Starting backend…" until that finishes.

Your library lives in `~/.research-companion/`: a SQLite database plus the embedding model cache. Set `RC_DATA_DIR` to put it somewhere else.

## How it works

1. **Ingest.** Parsers for PDF (PyMuPDF), DOCX, PPTX, Markdown/text, HTML and URLs (trafilatura), and images. Each document is stored as **pages**, the units citations point to. Scanned PDF pages and images go to the model for OCR. Text is chunked on sentence boundaries, and each chunk keeps its page number and character offsets.
2. **Metadata.** The model extracts title, authors, year, venue and DOI, plus a summary and tags. Metadata embedded in the file takes precedence when present.
3. **Index.** Embeddings come from a local `fastembed` model and are stored in SQLite; search is a numpy cosine scan. That's fast enough for one researcher's library, and there's no native vector database to bundle into Electron. If fastembed is unavailable, a hashing embedder takes over. Changing embedders re-embeds the whole library automatically.
4. **Topics.** Documents are grouped by spherical k-means over each document's chunk vectors, averaged with longer chunks weighted more. The model names each cluster. Users can rename and merge topics, and a renamed topic keeps its name when topics are rebuilt.
5. **Write.** The model drafts from the top-ranked passages. Every sentence must cite a passage ID and include a verbatim quote.
6. **Verify.** Each quote is located in the source; matching tolerates differences in whitespace, case, curly quotes and small OCR errors. The model then judges whether the surrounding text actually supports the claim, and the citation is marked `verified`, `weak`, `unsupported` or `quote_not_found`. Drafts appear immediately and citations are checked in the background. Clicking a chip opens the source page with the quote highlighted.
7. **References.** APA 7, MLA 9, IEEE and BibTeX, built from the documents cited in the draft. Pages use printed page numbers when the PDF has them.
8. **Word export.** "Export .docx" turns the draft into a Word file in APA, MLA or IEEE style. Citations become in-text citations placed before the sentence's closing punctuation, adjacent citations are merged, and a reference list is added at the end. Citations that are unverified, weak or unsupported, or whose quote wasn't found, get a Word comment. In Word, Review → Delete All Comments clears them before submitting.

Drafts are saved as the editor's own JSON in SQLite, not as .md files, because citations carry data (source, page, character positions, verification status) that Markdown can't hold.

Security: the backend can read any local path, so it binds to 127.0.0.1 only, and Electron passes it a random token each launch that every request must carry.

## Switching to Muse

```bash
RC_PROVIDER=muse MUSE_API_BASE=<endpoint> MUSE_API_KEY=<key> MUSE_MODEL=<model id> npm run dev
```

`backend/app/providers/muse.py` **assumes an OpenAI-style chat-completions shape**. That hasn't been checked against Meta's docs because there's no access yet. When access arrives, confirm the endpoint path, auth header, structured-output parameter, image input format and model ID. Only `chat()` and `transcribe_image()` should need changes; every prompt lives in `providers/prompts.py` and is shared.

## Known gaps / next steps

- **Mock limits:** the mock can't paraphrase, so drafts are extracted source sentences, sometimes title blocks. It does no OCR and finds no journal names. Muse covers all of these.
- **Packaging:** the Python backend still needs bundling with PyInstaller and shipping as an Electron `extraResources` binary. Today `main.cjs` runs `backend/.venv`.
- **Ingestion speed:** large folders are ingested synchronously. Add a background job with progress reporting.
- **Source viewer:** shows extracted page text. Rendering the PDF page itself with pdf.js would make highlights match the original layout.
