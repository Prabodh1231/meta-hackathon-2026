<p align="center">
  <img src="desktop/src/assets/logo.svg" alt="Groundwork logo: a page with a quotation mark on solid ground" width="88" />
</p>

<h1 align="center">Groundwork</h1>

<p align="center"><b>Write only what your sources say.</b></p>

<p align="center">
A desktop app for researchers writing from papers, notes, slides, scans and web pages.<br />
Muse Spark drafts from your library, and each citation is checked against a quote on its page.
</p>

<p align="center"><i>Built for the Meta Global AI Developer Hackathon.</i></p>

![Write view: a draft with citation chips marked Supported and partly supported, with Compose, Check and Sources tools on the right](docs/images/write.png)
*The Write view: a draft, its checked citations, and the writing tools beside it.*

**Contents**

- [Why](#why)
- [How Muse is used](#how-muse-is-used)
- [What it does](#what-it-does)
- [Run it](#run-it)
- [Development](#development)

## Why

Large firms give their people knowledge-management platforms: one place to find what the organisation knows. An individual researcher, a student or a scientist at a university without big subscriptions usually has a folder of PDFs.

Many researchers also work without access to Scopus or Web of Science. Every paper they need to read means a hunt across repositories and preprint servers for a free copy, and that hunt stops the real work. And AI writing tools can produce a sentence and a reference that look right, while leaving you to check whether the paper says it.

Groundwork is a personal knowledge platform for one researcher:

- **A virtual library.** The papers you already have, organised by what they say. Your files stay where they are, and folders only point at them.
- **Free papers without the hunt.** For the works your papers cite, Groundwork finds legal open-access copies through OpenAlex, Semantic Scholar and CORE, and downloads them in one click. No subscription needed.
- **Writing you can trust.** It drafts only from your sources, attaches a quote to each sentence, and shows you that quote highlighted on its page.

Only the text passages Muse needs, and images that need OCR, are sent to the API.

## How Muse is used

Muse Spark (`muse-spark-1.3`) through Meta's [Model API](https://dev.meta.ai/products/meta-model-api) does the reading, writing and checking in Groundwork. Search is local keyword search that Muse ranks. Muse calls use strict JSON schemas.

1. **Reading:** Muse extracts each source's title, authors, year and summary, tags papers that have no keyword list of their own, and reads scanned pages and images with OCR. Word statistics first rank papers against your subject folders; Muse then scores the strongest candidates.
2. **Search:** keyword (BM25) search on your computer finds matching passages; Muse expands the search and ranks the best passages first.
3. **Writing:** Muse drafts from the top-ranked passages. Every sentence must cite a passage and include a verbatim quote from it.
4. **Checking:** the app locates that quote in the source, then Muse judges whether it supports the sentence: Supported, Partly supported, or Not supported.
5. **Matrices and proposals:** Muse answers each matrix column for a paper from its passages, with a quote per cell, reads the finished matrix to name gaps across studies, writes comparisons from it, and plans a research proposal from the gaps.

## What it does

### A virtual library for everything you read

- Add files, a whole folder, or a pasted link or path, or drop files on the window. Groundwork reads PDF, Word (.docx), PowerPoint (.pptx), Markdown, plain text, HTML and images (PNG, JPEG, WebP).
- **Your files stay where they are.** Groundwork never copies or moves them; it keeps its own index in `~/.groundwork/`. Subject folders are virtual: a folder points at your files, so one paper can sit in several folders at once, and deleting a folder deletes no paper.
- **Folders by meaning.** Type a subject such as "Digital finance" and choose how closely a paper must match; papers are filed by what they say, not by where they are saved.
- **Real titles, not file names.** Each paper is listed by the title, authors and year Muse reads from inside it, so `scan_0042.pdf` still shows up as the paper it is. Papers Groundwork downloads for you are saved as `Author Year - Title.pdf`.
- Lookups in OpenAlex and Crossref add journal details, the authors' abstract and citation counts. Tick papers to limit drafting and cite searches to just those.
- Open a PDF in the app's reader to highlight passages and add notes. Highlights can be inserted into the draft as quotes, or ticked so Muse writes a paragraph from them; their ranking for the paragraph you are in runs on your computer.

![The Add sources menu: paste a link or path, or drop files](docs/images/add-sources.png)
*Add sources: pick files or a folder, or paste a link or path.*

![Library: subject folders, a sortable table of sources, and one paper's details and abstract](docs/images/library.png)
*The Library: subject folders, a sortable table of sources, and the open paper's details.*

### Write with checked citations

- In **Compose**, with **Cite my sources** on, Muse drafts from your library; every sentence carries a quote, checked in the background. Tick the sentences to keep and insert just those. **Just chat** answers from Muse's own knowledge, with no citations.
- For a sentence of your own, press **Cite**. A `cite` marker searches in the background: green means a source was found for you to confirm, amber means partly supported, red means not supported, and red with a question mark means no source found.
- Text Muse wrote keeps a faint mark in the draft, so you can tell its words from yours. The mark is not exported.

![A citation clicked: its quote highlighted on the PDF page, joined to the citation chip by a dashed line](docs/images/citation-source.png)
*A citation and the quote that backs it, highlighted on the source page.*

### Check the whole draft

- **Check** counts citations as supported, needing attention or still checking, worst first, each with the reason Muse gave. **Recheck all** checks every citation again against its sentence as it reads now.
- The same tab reports duplication: sentences that repeat each other, and text that matches a source closely, cited or not. Versions are snapshotted as you write, can be named and compared, and restoring one keeps a snapshot of the draft as it was.
- **Sources** builds the reference list in APA 7, MLA 9 or IEEE, or as BibTeX. Export writes a Word file in the chosen style, with a Word comment on any citation that did not pass its check.

![Check tab: citation status counts and the duplication check for the draft](docs/images/review.png)
*Check: citation counts in the same words as the draft's marks, and the duplication check.*

### Review matrices and the citation network

- A matrix has one row per paper and one column per question: sample, setting, method, findings, limitations, or your own. Each cell rests on a quote found in the paper, marked with its page, marked **Needs check** when the quote was not found, or *Not reported* when the passages read do not say. From a finished matrix you can find gaps across studies, write a comparison citing the matrix, plan a research proposal from the gaps, and export to Excel, CSV or Word.
- **Network** maps who cites whom for a topic, your ticked papers, or the whole library, and lists the most-cited works your papers cite that you do not have. Where a legal open-access copy exists (open-access journals, arXiv, university repositories), it downloads in one click, with no subscription needed, and is saved as `Author Year - Title.pdf`.

![A review matrix: one row per paper, columns for Sample, Setting, Method and Findings, each cell with its page](docs/images/matrix.png)
*A review matrix: one row per paper, each cell a short answer with the page its quote is on.*

![A matrix cell open beside the matrix, with its quote highlighted on the PDF page](docs/images/matrix-cell.png)
*A matrix cell open beside the table, its quote highlighted on the page.*

![The citation network for 'cryptocurrency', with the most-cited works not in the library listed beside it](docs/images/network.png)
*The citation network, with the works your papers cite most that you do not have.*

Full detail on every feature is in the [user guide](docs/USER_GUIDE.md).

## Run it

You need Python 3.11+ and Node 22.12+. From the repository root:

```bash
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
cd ../desktop && npm install
npm run dev
```

On macOS or Linux, use `.venv/bin/pip` in the first command. Electron starts the backend itself.

### First run

- Get a key from Meta's [Model API](https://dev.meta.ai/products/meta-model-api) page, then **Add your Muse key** in **Settings → AI model**: paste the key and click **Save and switch**. The change takes effect at once, with no restart.
- Without a key, the app runs on an offline mock that matches words instead of reading them. The status bar shows *Offline mock* in amber; click it to open the same Settings section. Use the mock to look around, not to judge results.
- A new library opens on **Getting started**. Click **Try the sample library** to load six small files on sleep and coral reefs: two papers, reading notes, a fieldwork log, lab slides and a chapter outline.
- The sample draft then opens with a checklist. One of its four sentences is false on purpose: the sleep paper found that reactivation during REM sleep did nothing, so Muse marks the claim that it helped as unsupported. On the mock it may only be marked partial, or even pass. Follow the checklist to confirm a source, see its quote on the page, draft with Muse, open Check and export to Word.

Success looks like this: the app window opens on Getting started, the sample files appear in the Library, and the demo draft's cite markers start checking straight away.

Your data lives in `~/.groundwork/`. Set `RC_DATA_DIR` to keep it somewhere else. Your source files stay where they are; the library keeps its own index in that folder. If something goes wrong, see Troubleshooting in the [user guide](docs/USER_GUIDE.md).

### Windows installer

```bash
cd backend && .venv/Scripts/pip install pyinstaller
cd ../desktop && npm run dist
```

This writes `desktop/release/Groundwork-Setup-<version>.exe`, with the backend bundled, so testers need neither Python nor Node. It installs for the current user without admin rights. It isn't signed, so Windows warns about an unknown publisher: click **More info → Run anyway**.

## Development

```bash
cd desktop && npm run typecheck
npm run smoke
cd ../backend && .venv/Scripts/python -m pytest
```

- `npm run smoke` builds the app, launches Electron, and checks the token check and the backend restart.
- `npm run web` in `desktop/` serves the UI alone in a browser; it talks to a backend on `127.0.0.1:8765` with no token, so start one with `uvicorn app.main:app --port 8765` from `backend/`.
- The backend log is `~/.groundwork/logs/backend.log`. If the backend exits, the app restarts it.
- How the code fits together is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
