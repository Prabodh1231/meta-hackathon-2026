<p align="center">
  <img src="desktop/src/assets/logo.svg" alt="" width="88" />
</p>

<h1 align="center">Groundwork</h1>

<p align="center"><b>Write only what your sources say.</b></p>

<p align="center">
A desktop app for researchers: keep everything you read in one library, write from it,<br />
and see every claim backed by a quote found on the page it came from.
</p>

<p align="center"><i>Built for the Meta Global AI Developer Hackathon, Oct 27 – Nov 4, 2026.</i></p>

![Writing in Groundwork: each citation in the draft is checked against its source](docs/images/write.png)

## Why

AI writing tools are quick to produce a sentence and a reference that look right. Whether the paper actually says it is left to you. Groundwork works the other way round: it writes only from the papers in your library, every sentence carries a quote from one of them, and that quote is looked up on its page and checked against the claim before you rely on it.

## What it does

- **One library for everything you read.** PDFs, Word files, slides, Markdown, web pages and scans. Each paper's title, authors and summary are read for you, and papers are filed into subject folders by what they say, not by file name. Journal details, abstracts and citation counts come from OpenAlex and Crossref.
- **Citations that are checked.** Ask Muse to draft from your sources, or mark a sentence of your own with **Cite**. Each citation is matched to a quote on a page and marked supported, partly supported, not supported or no source found.
- **The quote on its page.** Click any citation to see its quote highlighted on the PDF page.
- **Literature review matrices.** One row per paper, a column per question (sample, setting, method, findings, limitations), every cell answered from a quote. Find the gaps across studies, write from the matrix, or export it to Excel, CSV or Word.
- **The citation network.** See who cites whom in your library, and which works your papers cite most that you don't have yet. Free copies download in one click.
- **Ready to hand in.** A duplication check against your sources and against the draft itself, versions you can compare, and Word export in APA, MLA or IEEE, with a comment on any citation that still needs checking.

| A citation and its quote on the page | A review matrix |
|---|---|
| ![](docs/images/citation-source.png) | ![](docs/images/matrix.png) |

The [user guide](docs/USER_GUIDE.md) walks through every screen.

## Powered by Muse

All of the reading, writing and checking is done by **Muse Spark** (`muse-spark-1.3`) through Meta's [Model API](https://dev.meta.ai/products/meta-model-api). That covers reading papers and scans, tagging and filing, drafting with quotes, judging whether a quote supports its claim, and building review matrices. Search runs on your computer as keyword search, and Muse ranks the results.

Your files stay on your computer. Only the passages Muse needs, and images that need OCR, are sent to it.

## Run it

You need Python 3.11+ and Node 22.12+.

```bash
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
cd ../desktop && npm install
npm run dev
```

On macOS or Linux, use `.venv/bin/pip`. Electron starts the backend itself.

**Add your Muse key** in **Settings → AI model**: paste it and click **Save and switch**. Without a key the app runs on an offline mock that matches words instead of reading, which is enough to look around but not to judge the results.

**No papers yet?** Click **Try the sample library** in Getting started. It loads six demo files and a draft with a checklist of things to try.

Your library lives in `~/.groundwork/`. Set `RC_DATA_DIR` to keep it somewhere else.

### Windows installer

```bash
cd backend && .venv/Scripts/pip install pyinstaller
cd ../desktop && npm run dist
```

This writes `desktop/release/Groundwork-Setup-<version>.exe`, with the backend bundled, so testers don't need Python or Node. It installs for the current user without admin rights. The installer isn't signed, so Windows warns about an unknown publisher: click **More info → Run anyway**.

### Development

- `cd backend && .venv/Scripts/python -m pytest` runs the backend tests.
- `npm run smoke` builds and launches Electron and checks the backend's token check.
- `RC_BACKEND_URL=http://127.0.0.1:8765 npm run dev` points Electron at a backend you started yourself (`uvicorn app.main:app --reload --port 8765`).
- The Muse key can also go in `~/.groundwork/.env` as `RC_PROVIDER=muse` and `MUSE_API_KEY=...`.
- The backend's log is `~/.groundwork/logs/backend.log`. If the backend exits, the app restarts it.

```
backend/   Python FastAPI service: reading files, search, drafting, citation checks
desktop/   Electron + React app
docs/      User guide and architecture
samples/   Demo library (two research themes, six file types)
```

How the code fits together, and how each step works in detail, is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Known limitations

- Windows only for the installer, and it's unsigned.
- Papers imported without a Muse key keep the mock's rough summaries and tags until they're imported again with Muse.
- An import interrupted by a backend restart has to be started again; the files already added stay.
- Scanned pages without a text layer can't be highlighted.
