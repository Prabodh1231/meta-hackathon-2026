"""The knowledge base: ingestion, search, topics, cited drafting and verification."""

import json
import logging
import os
import re
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from . import db, docx_import, draft_review, dupfiles, openaccess, paper_meta
from .citations import VERDICT_STATUS, locate_quote
from .citegraph import build_graph, focus, keyword_links, missing_works
from .refparse import Reference, match_reference, parse_references
from .embeddings import Embedder, from_blob, make_embedder, to_blob
from .ingest import ParsedDocument, chunk_page, is_supported, parse_file, parse_url
from .providers import LLMProvider, Passage, make_provider
from .references import format_references
from .retrieval import Reranker, fts_query, make_reranker, reciprocal_rank_fusion
from .settings import Settings
from .text_utils import sentence_spans
from .topics import choose_k, jaccard, kmeans

log = logging.getLogger(__name__)

# Preferences set in the Settings panel: allowed values per key, first one is the default.
USER_SETTINGS_CHOICES = {
    "theme": ("system", "light", "dark"),
    "citation_style": ("apa", "mla", "ieee"),
}
USER_SETTINGS_DEFAULTS = {k: v[0] for k, v in USER_SETTINGS_CHOICES.items()}


_FROM_SETTINGS = object()

# Filing a paper into a folder: below this many papers the library has no average to compare
# against, so every paper is read by the model. Papers the embeddings rank under the library's
# average for a folder are never sent to the model, and keep at most this score.
MIN_DOCS_FOR_RELATIVE = 8
UNCHECKED_CAP = 30


INGEST_WORKERS = 4
MIN_OWN_KEYWORDS = 3  # a paper's printed keyword list this long replaces the model's tags
MAX_KEYWORD_TAGS = 8
MIN_TEXT_HITS = 3  # chunks of a paper that must mention a searched topic for it to count as about it

# Draft versions: an automatic snapshot when the newest version is this old, and one of the
# draft as it was before an edit that changes at least LARGE_EDIT_PCT of a draft this long.
AUTO_VERSION_MINUTES = 10
LARGE_EDIT_PCT = 25
LARGE_EDIT_MIN_WORDS = 50
MAX_AUTO_VERSIONS = 40
# Duplication: share of a draft sentence's word 3-grams found in one library passage.
SOURCE_MATCH = 0.5  # closely matches the source
SOURCE_COPIED = 0.85  # copied nearly word for word
# Duplicate files: documents whose mean chunk embeddings are this close are compared in detail.
# Only picks candidates; shared passages and metadata decide what's shown.
DUP_DOC_COS = 0.9


class Library:
    def __init__(self, settings: Settings, provider: LLMProvider | None = None, embedder: Embedder | None = None,
                 reranker: "Reranker | None | object" = _FROM_SETTINGS, open_access: openaccess.OpenAccess | None = None):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        self.settings = settings
        self.conn = db.connect(settings.db_path)
        self.lock = threading.RLock()
        self._embed_lock = threading.Lock()  # one GPU/model call at a time while files ingest in parallel
        self.provider = provider or make_provider(settings)
        self.embedder = embedder or make_embedder(settings.embedder, settings.data_dir / "models")
        self.reranker = (
            make_reranker(settings.reranker, settings.data_dir / "models") if reranker is _FROM_SETTINGS else reranker
        )
        self.open_access = open_access or openaccess.OpenAccess(settings.contact_email)
        self._ids: np.ndarray | None = None  # in-memory vector index, rebuilt lazily
        self._docs: np.ndarray | None = None
        self._mat: np.ndarray | None = None
        self._name_vectors: dict[tuple[str, str], np.ndarray] = {}  # (embedder id, folder name) -> vector
        self._reembed_if_needed()
        self._backfill_keywords()

    # ---------- ingestion ----------

    def ingest_path(self, path: str) -> list[dict]:
        p = Path(path).expanduser()
        if not path.strip() or not p.exists():
            raise LookupError(f"No such file or folder: {p}")
        return self.ingest_paths([path])

    @staticmethod
    def expand_paths(paths: list[str]) -> tuple[list[Path], list[dict]]:
        """The files to read for these files and folders (searched recursively), each once, and
        a failed result for each path that doesn't exist."""
        files: list[Path] = []
        missing: list[dict] = []
        for path in paths:
            if not str(path).strip():  # Path("") is the working directory: never read that by accident
                missing.append({"source": "", "ok": False, "error": "Empty path"})
                continue
            p = Path(path).expanduser()
            if not p.exists():
                missing.append({"source": str(p), "ok": False, "error": "No such file or folder"})
            elif p.is_file():
                files.append(p)
            else:
                files += sorted(f for f in p.rglob("*") if f.is_file() and is_supported(f))
        return list({str(f.resolve()): f for f in files}.values()), missing  # the same file picked twice, once

    def ingest_file(self, f: Path, on_stage=None) -> dict:
        """Read and store one file. `on_stage("reading" | "analysing" | "filing")` reports progress."""
        try:
            if on_stage:
                on_stage("reading")
            parsed = parse_file(f, self.provider.transcribe_image)
            return {"source": str(f), "ok": True, "document": self._store(parsed, str(f.resolve()), on_stage)}
        except Exception as exc:
            log.exception("Failed to ingest %s", f)
            return {"source": str(f), "ok": False, "error": str(exc)}

    def ingest_paths(self, paths: list[str]) -> list[dict]:
        """Files and folders added in one go, so they share the worker pool instead of one file
        waiting for the last. A missing path is reported, not raised. (The app uses IngestJobs,
        which does the same in the background and reports each file's progress.)"""
        files, missing = self.expand_paths(paths)
        # Each file spends most of its time waiting on Muse (about 3 s per call), so a few at once
        # cut a folder's time by roughly the worker count. map() keeps the results in file order.
        with ThreadPoolExecutor(max_workers=min(INGEST_WORKERS, max(len(files), 1))) as pool:
            return list(pool.map(self.ingest_file, files)) + missing

    def ingest_url(self, url: str) -> dict:
        return self._store(parse_url(url), url)

    def fill_missing(self, doc_ids: list[int] | None = None) -> dict:
        """Try again the model calls that failed when documents were added (all such documents,
        or those in `doc_ids`). Only fills what is still empty, and never a field the user
        corrected. Returns how many documents are now complete and how many still aren't."""
        with self.lock:
            rows = [dict(r) for r in self.conn.execute(
                "SELECT id, title, authors, year, venue, doi, missing, edited_fields FROM documents WHERE missing != '[]'")]
        if doc_ids is not None:
            wanted = set(doc_ids)
            rows = [r for r in rows if r["id"] in wanted]

        def one(r: dict) -> bool:
            owed, edited = json.loads(r["missing"]), set(json.loads(r["edited_fields"]))
            with self.lock:
                pages = [p["text"] for p in self.conn.execute("SELECT text FROM pages WHERE doc_id = ? ORDER BY page", (r["id"],))]
            full = "\n\n".join(pages)
            updates: dict = {}
            still: list[str] = []
            new_tags: list[str] = []
            title = r["title"]
            if "metadata" in owed:
                try:
                    meta = self.provider.extract_metadata(pages[0] if pages and pages[0].strip() else full)
                    if meta.get("title") and "title" in owed and "title" not in edited:
                        updates["title"] = title = meta["title"]
                    if meta.get("authors") and not json.loads(r["authors"]) and "authors" not in edited:
                        updates["authors"] = json.dumps(meta["authors"])
                    for key in ("year", "venue", "doi"):
                        if meta.get(key) and not r[key] and key not in edited:
                            updates[key] = meta[key]
                except Exception:
                    log.exception("Metadata extraction failed again for document %s", r["id"])
                    still += [m for m in ("metadata", "title") if m in owed]
            if "summary" in owed:
                try:
                    updates["summary"] = self.provider.summarize(title, full)
                except Exception:
                    log.exception("Summary failed again for document %s", r["id"])
                    still.append("summary")
            if "tags" in owed:
                try:
                    new_tags = self.provider.tag_document(title, full)
                except Exception:
                    log.exception("Tagging failed again for document %s", r["id"])
                    still.append("tags")
            updates["missing"] = json.dumps(still)
            with self.lock, self.conn:
                if not self.conn.execute("SELECT 1 FROM documents WHERE id = ?", (r["id"],)).fetchone():
                    return True  # removed meanwhile
                cols = ", ".join(f"{k} = ?" for k in updates)
                self.conn.execute(f"UPDATE documents SET {cols} WHERE id = ?", (*updates.values(), r["id"]))
                self.conn.executemany("INSERT OR IGNORE INTO tags (doc_id, tag) VALUES (?, ?)", [(r["id"], t) for t in new_tags])
            return not still

        if not rows:
            return {"filled": 0, "still_missing": 0}
        with ThreadPoolExecutor(max_workers=min(INGEST_WORKERS, len(rows))) as pool:
            done = list(pool.map(one, rows))
        return {"filled": sum(done), "still_missing": len(done) - sum(done)}

    def _store(self, parsed: ParsedDocument, source: str, on_stage=None) -> dict:
        full_text = "\n\n".join(parsed.pages)
        if not full_text.strip():
            raise ValueError("No text could be extracted")
        meta = {"title": "", "authors": [], "year": None, "venue": "", "doi": "", "url": ""}
        # Authors print keywords and JEL codes on the first pages: read them directly. A paper with
        # its own keywords needs no model call to be tagged.
        keywords, jel_codes = paper_meta.extract("\n\n".join(parsed.pages[:2]))
        own_keywords = len(keywords) >= MIN_OWN_KEYWORDS
        chunks = [
            (page_no, s, e, text[s:e])
            for page_no, text in enumerate(parsed.pages, start=1)
            for s, e in chunk_page(text)
        ]

        def embed_chunks() -> np.ndarray:
            with self._embed_lock:
                return self.embedder.embed([c[3] for c in chunks]) if chunks else np.zeros((0, 1))

        # Metadata, summary, tags and embeddings don't depend on each other, so all of them run
        # at once: a file takes about one model call's time instead of three in a row. The summary
        # and tags only use the title as a heading, so the file's own title (or name) does.
        # A failed model call (rate limit, timeout, Muse down) doesn't lose the file: it's stored
        # with that part left out and listed in `missing`, for fill_missing() to try again.
        if on_stage:
            on_stage("analysing")
        hint = parsed.metadata.get("title") or Path(source).stem
        missing: list[str] = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            meta_job = pool.submit(self.provider.extract_metadata, parsed.pages[0] or full_text)
            summary_job = pool.submit(self.provider.summarize, hint, full_text)
            tags_job = None if own_keywords else pool.submit(self.provider.tag_document, hint, full_text)
            embed_job = pool.submit(embed_chunks)
            try:
                meta.update({k: v for k, v in meta_job.result().items() if v})
            except Exception:
                log.exception("Metadata extraction failed for %s", source)
                missing.append("metadata")
            try:
                summary = summary_job.result()
            except Exception:
                log.exception("Summary failed for %s", source)
                summary = ""
                missing.append("summary")
            tags: list[str] = keywords[:MAX_KEYWORD_TAGS]
            if not own_keywords:
                try:
                    tags = tags_job.result()
                except Exception:
                    log.exception("Tagging failed for %s", source)
                    tags = []
                    missing.append("tags")
            vectors = embed_job.result()
        meta.update({k: v for k, v in parsed.metadata.items() if v})  # file metadata wins when present
        title = meta["title"] or Path(source).stem
        if "metadata" in missing and not meta["title"]:
            missing.append("title")  # only the file name for now

        fields = {
            "kind": parsed.kind, "title": title, "authors": json.dumps(meta["authors"]), "year": meta["year"],
            "venue": meta["venue"], "doi": meta["doi"], "url": meta["url"], "summary": summary,
            "page_count": len(parsed.pages), "page_numbering": parsed.page_numbering,
            "keywords": json.dumps(keywords), "jel_codes": json.dumps(jel_codes),
        }
        with self.lock, self.conn:
            existing = self.conn.execute(
                "SELECT id, edited_fields, missing FROM documents WHERE source = ?", (source,)
            ).fetchone()
            if existing:
                # Re-adding a file refreshes its content in place: the id (which citations in
                # drafts point to), topic, tags and any metadata the user corrected all survive.
                doc_id = existing["id"]
                for key in json.loads(existing["edited_fields"]):
                    fields.pop(key, None)
                # A call that failed this time keeps what the last reading found, if it found it.
                had_missing = set(json.loads(existing["missing"]))
                owed = {"summary": ["summary"], "title": ["title"],
                        "metadata": [k for k in ("authors", "year", "venue", "doi", "url") if not parsed.metadata.get(k)]}
                for item in [m for m in missing if m in owed and m not in had_missing]:
                    missing.remove(item)
                    for key in owed[item]:
                        fields.pop(key, None)
                if "tags" in missing and self.conn.execute("SELECT 1 FROM tags WHERE doc_id = ?", (doc_id,)).fetchone():
                    missing.remove("tags")  # tags aren't replaced on re-adding, and it has some
                fields["missing"] = json.dumps(missing)
                cols = ", ".join(f"{k} = ?" for k in fields)
                self.conn.execute(f"UPDATE documents SET {cols} WHERE id = ?", (*fields.values(), doc_id))
                self.conn.execute("DELETE FROM pages WHERE doc_id = ?", (doc_id,))
                self.conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
                self.conn.execute("DELETE FROM doc_refs WHERE doc_id = ?", (doc_id,))
                self.conn.execute("UPDATE documents SET refs_parsed = 0 WHERE id = ?", (doc_id,))
            else:
                fields["missing"] = json.dumps(missing)
                cols = ", ".join(fields)
                [doc_id] = self._allocate_ids("documents", 1)
                self.conn.execute(
                    f"INSERT INTO documents (id, source, {cols}) VALUES (?, ?, {', '.join('?' * len(fields))})",
                    (doc_id, source, *fields.values()),
                )
                self.conn.executemany(
                    "INSERT OR IGNORE INTO tags (doc_id, tag) VALUES (?, ?)", [(doc_id, t) for t in tags]
                )
            labels = parsed.page_labels or [None] * len(parsed.pages)
            self.conn.executemany(
                "INSERT INTO pages (doc_id, page, text, label) VALUES (?, ?, ?, ?)",
                [(doc_id, i, t, lbl) for i, (t, lbl) in enumerate(zip(parsed.pages, labels), start=1)],
            )
            self.conn.executemany(
                "INSERT INTO chunks (id, doc_id, page, start, end, text, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    (cid, doc_id, pg, s, e, t, to_blob(v))
                    for cid, (pg, s, e, t), v in zip(self._allocate_ids("chunks", len(chunks)), chunks, vectors)
                ],
            )
            self._invalidate_index()
        if on_stage:
            on_stage("filing")
        try:
            self.classify_document(doc_id)
        except Exception:  # the document is stored and searchable; folders can be filled in later
            log.exception("Folder classification failed for %s", source)
        return self.get_document(doc_id)

    def _allocate_ids(self, table: str, n: int) -> list[int]:
        """Fresh ids that are never reused. SQLite hands a deleted max rowid to the next
        insert, so a citation saved in a draft could silently point at a different document
        or chunk. Call inside the inserting transaction."""
        key = f"next_id:{table}"
        highest = self.conn.execute(f"SELECT MAX(id) FROM {table}").fetchone()[0] or 0
        start = max(int(db.get_meta(self.conn, key) or 1), highest + 1)
        db.set_meta(self.conn, key, str(start + n))
        return list(range(start, start + n))

    def _reembed_if_needed(self) -> None:
        with self.lock, self.conn:
            stored = db.get_meta(self.conn, "embedder")
            if stored and stored != self.embedder.id:
                log.info("Embedder changed (%s -> %s); re-embedding all chunks", stored, self.embedder.id)
                rows = self.conn.execute("SELECT id, text FROM chunks").fetchall()
                for i in range(0, len(rows), 256):
                    batch = rows[i : i + 256]
                    vecs = self.embedder.embed([r["text"] for r in batch])
                    self.conn.executemany(
                        "UPDATE chunks SET embedding = ? WHERE id = ?",
                        [(to_blob(v), r["id"]) for r, v in zip(batch, vecs)],
                    )
            db.set_meta(self.conn, "embedder", self.embedder.id)

    def _backfill_keywords(self) -> None:
        """Once, for a library from before keywords were read: take them from the stored pages (local, no model call)."""
        with self.lock, self.conn:
            if db.get_meta(self.conn, "keywords_backfill") == "1":
                return
            for row in self.conn.execute("SELECT id FROM documents").fetchall():
                text = "\n\n".join(r["text"] for r in self.conn.execute(
                    "SELECT text FROM pages WHERE doc_id = ? ORDER BY page LIMIT 2", (row["id"],)))
                keywords, jel_codes = paper_meta.extract(text)
                self.conn.execute(
                    "UPDATE documents SET keywords = ?, jel_codes = ? WHERE id = ?",
                    (json.dumps(keywords), json.dumps(jel_codes), row["id"]),
                )
            db.set_meta(self.conn, "keywords_backfill", "1")

    # ---------- citation network ----------

    def _parse_references(self) -> None:
        """Read the reference list of every paper not yet read (local, no model call)."""
        with self.lock, self.conn:
            for row in self.conn.execute("SELECT id FROM documents WHERE refs_parsed = 0").fetchall():
                text = "\n".join(r["text"] for r in self.conn.execute(
                    "SELECT text FROM pages WHERE doc_id = ? ORDER BY page", (row["id"],)))
                refs = parse_references(text)
                self.conn.executemany(
                    "INSERT OR REPLACE INTO doc_refs (doc_id, idx, raw, number, year, doi, title, first_author) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [(row["id"], i, r.raw, r.number, r.year, r.doi, r.title, r.first_author) for i, r in enumerate(refs)],
                )
                self.conn.execute("UPDATE documents SET refs_parsed = 1 WHERE id = ?", (row["id"],))

    def _terms(self, doc_id: int, keywords: str) -> set[str]:
        tags = [r["tag"] for r in self.conn.execute("SELECT tag FROM tags WHERE doc_id = ?", (doc_id,))]
        return {t.strip().lower() for t in [*json.loads(keywords), *tags] if t.strip()}

    def _topic_matches(self, query: str) -> dict[int, dict]:
        """Papers about a topic, strongest evidence first: the authors' keywords, title, tags and
        summary name it, or the body text mentions it in several places."""
        tokens = [t.lower() for t in re.findall(r"[\w-]{2,}", query)]
        if not tokens:
            return {}
        found: dict[int, dict] = {}
        for r in self.conn.execute("SELECT id, title, summary, keywords FROM documents"):
            fields = {
                "keywords": " ".join(json.loads(r["keywords"])), "title": r["title"], "summary": r["summary"],
                "tags": " ".join(t["tag"] for t in self.conn.execute("SELECT tag FROM tags WHERE doc_id = ?", (r["id"],))),
            }
            why = [name for name, text in fields.items() if all(t in text.lower() for t in tokens)]
            if why:
                found[r["id"]] = {"why": why, "hits": 0}
        match = " ".join('"' + t.replace('"', "") + '"' for t in tokens)
        try:
            rows = self.conn.execute(
                "SELECT c.doc_id AS doc_id, COUNT(*) AS n FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid "
                "WHERE chunks_fts MATCH ? GROUP BY c.doc_id", (match,)).fetchall()
        except Exception:  # an unparseable query matches nothing in the text
            rows = []
        for r in rows:
            if r["n"] >= MIN_TEXT_HITS:
                found.setdefault(r["doc_id"], {"why": [], "hits": 0})["hits"] = r["n"]
                if "text" not in found[r["doc_id"]]["why"]:
                    found[r["doc_id"]]["why"].append("text")
        return found

    def _graph_inputs(self) -> tuple[list[dict], dict[int, list[Reference]]]:
        """Every paper, and every paper's reference list (a list index is the entry's idx)."""
        self._parse_references()
        docs = [
            {"id": r["id"], "title": r["title"], "authors": json.loads(r["authors"]), "year": r["year"], "doi": r["doi"]}
            for r in self.conn.execute("SELECT id, title, authors, year, doi FROM documents ORDER BY id")
        ]
        refs: dict[int, list[Reference]] = defaultdict(list)
        for r in self.conn.execute("SELECT * FROM doc_refs ORDER BY doc_id, idx"):
            refs[r["doc_id"]].append(Reference(r["raw"], r["number"], r["year"], r["doi"], r["title"], r["first_author"]))
        return docs, refs

    def missing_works(self, query: str = "", limit: int = 100) -> dict:
        """What the papers about a topic (every paper, with no topic) cite that the library lacks,
        ranked by how many of them cite it."""
        with self.lock:
            docs, refs = self._graph_inputs()
            matches = self._topic_matches(query) if query.strip() else None
        citing = {d["id"] for d in docs} if matches is None else set(matches)
        works = missing_works(docs, refs, citing)
        titles = {d["id"]: d["title"] for d in docs}
        for w in works[:limit]:
            w["citers"] = [{"id": i, "title": titles[i]} for i in w["citers"]]
        return {
            "query": query.strip(), "papers": len(citing), "with_refs": sum(1 for i in citing if refs.get(i)),
            "total": len(works), "cited_twice": sum(1 for w in works if w["cited_by"] >= 2), "works": works[:limit],
        }

    def citation_graph(self, query: str = "") -> dict:
        with self.lock:
            docs, refs = self._graph_inputs()
            terms = {r["id"]: self._terms(r["id"], r["keywords"]) for r in self.conn.execute("SELECT id, keywords FROM documents")}
            matches = self._topic_matches(query) if query.strip() else None
        graph = build_graph(docs, refs)
        if matches is None:
            graph["keyword"] = keyword_links(terms, min_shared=2)
            return graph
        graph = focus(graph, set(matches), keyword_links({i: terms[i] for i in matches}))
        for n in graph["nodes"]:
            if n["kind"] == "paper":
                n["match"] = matches[n["doc_id"]]
        graph["query"] = query.strip()
        return graph

    # ---------- cited papers ----------

    def _refs_and_docs(self, doc_id: int) -> tuple[dict, list[Reference], list[dict]]:
        with self.lock:
            self._parse_references()
            doc = self.get_document(doc_id)
            refs = [Reference(r["raw"], r["number"], r["year"], r["doi"], r["title"], r["first_author"])
                    for r in self.conn.execute("SELECT * FROM doc_refs WHERE doc_id = ? ORDER BY idx", (doc_id,))]
            docs = [{"id": r["id"], "title": r["title"], "authors": json.loads(r["authors"]), "year": r["year"], "doi": r["doi"]}
                    for r in self.conn.execute("SELECT id, title, authors, year, doi FROM documents")]
        return doc, refs, docs

    def cited_works(self, doc_id: int) -> dict:
        """A paper's reference list, each entry with the library document it matches, if any."""
        doc, refs, docs = self._refs_and_docs(doc_id)
        entries = []
        for i, ref in enumerate(refs):
            m = match_reference(ref, docs, doc["year"], doc_id)
            entries.append({
                "idx": i, "raw": ref.raw, "number": ref.number, "title": ref.title, "first_author": ref.first_author,
                "year": ref.year, "doi": ref.doi, "in_library": m.doc_id if m else None, "searchable": openaccess.searchable(ref),
            })
        return {"doc_id": doc_id, "title": doc["title"], "references": entries}

    def fetch_cited_work(self, doc_id: int, idx: int) -> dict:
        """Find a free copy of one entry in a paper's reference list and add it to the library."""
        doc, refs, docs = self._refs_and_docs(doc_id)
        if not 0 <= idx < len(refs):
            raise LookupError(f"Reference {idx} not found")
        ref = refs[idx]
        m = match_reference(ref, docs, doc["year"], doc_id)
        if m:  # already here, perhaps fetched for another paper's reference list
            return {"status": "in_library", "doc_id": m.doc_id}
        got = self.open_access.fetch(ref, self.settings.data_dir / "papers")
        out = {"status": got.status, "url": got.url, "reason": got.reason, "found_in": got.work.source if got.work else ""}
        if got.status != "downloaded":
            return out
        [res] = self.ingest_path(str(got.path))
        if not res["ok"]:
            got.path.unlink(missing_ok=True)
            return {**out, "status": "failed", "reason": f"Downloaded, but couldn't be read: {res['error']}"}
        added = res["document"]
        # The index matched the work by DOI or by title and year, so its title is the right one; a
        # PDF's own title is often a file name ("Microsoft Word - final3.docx"), which would also
        # keep the next look-up from seeing the paper is already here. DOI, year and URL fill gaps.
        known = {"url": got.url, "doi": got.work.doi, "year": got.work.year}
        fill = {k: v for k, v in known.items() if v and not added[k]}
        if got.work.title:
            fill["title"] = got.work.title
        if fill:
            with self.lock, self.conn:
                cols = ", ".join(f"{k} = ?" for k in fill)
                self.conn.execute(f"UPDATE documents SET {cols} WHERE id = ?", (*fill.values(), added["id"]))
        return {**out, "doc_id": added["id"], "document": self.get_document(added["id"])}

    # ---------- documents ----------

    def _doc_dicts(self, rows: list) -> list[dict]:
        """Documents as the API returns them. Tags, folders and page labels are read in one
        query each for all of `rows`, not three per document. Call under the lock."""
        if not rows:
            return []
        ids = [r["id"] for r in rows]
        scope = f"IN ({','.join('?' * len(ids))})"
        tags: dict[int, list[str]] = defaultdict(list)
        for r in self.conn.execute(f"SELECT doc_id, tag FROM tags WHERE doc_id {scope} ORDER BY tag", ids):
            tags[r["doc_id"]].append(r["tag"])
        folders: dict[int, list[dict]] = defaultdict(list)
        for r in self.conn.execute(
            "SELECT df.doc_id, f.id, f.name, df.state, s.score FROM doc_folders df JOIN folders f ON f.id = df.folder_id "
            "LEFT JOIN folder_scores s ON s.doc_id = df.doc_id AND s.folder_id = df.folder_id "
            f"WHERE df.doc_id {scope} AND df.state != 'rejected' ORDER BY f.name COLLATE NOCASE",
            ids,
        ):
            folders[r["doc_id"]].append({k: r[k] for k in ("id", "name", "state", "score")})
        numbered = [r["id"] for r in rows if r["page_numbering"] != "index"]
        labels: dict[int, list[str]] = defaultdict(list)
        if numbered:
            for r in self.conn.execute(
                f"SELECT doc_id, label FROM pages WHERE doc_id IN ({','.join('?' * len(numbered))}) "
                "AND label IS NOT NULL ORDER BY doc_id, page", numbered,
            ):
                if r["label"].isdigit():
                    labels[r["doc_id"]].append(r["label"])
        out = []
        for row in rows:
            d = dict(row)
            d["authors"] = json.loads(d["authors"])
            d["edited_fields"] = json.loads(d["edited_fields"])
            d["keywords"] = json.loads(d["keywords"])
            d["missing"] = json.loads(d["missing"])
            d["jel_codes"] = [{"code": c, "area": paper_meta.jel_area(c)} for c in json.loads(d["jel_codes"])]
            d["tags"] = tags[d["id"]]
            d["folders"] = folders[d["id"]]
            d["label"] = short_label(d)
            d["page_range"] = page_range(labels[d["id"]])
            out.append(d)
        return out

    def _doc_dict(self, row) -> dict:
        return self._doc_dicts([row])[0]

    def list_documents(self) -> list[dict]:
        with self.lock:
            rows = self.conn.execute("SELECT * FROM documents ORDER BY added_at DESC, id DESC").fetchall()
            return self._doc_dicts(rows)

    def get_document(self, doc_id: int) -> dict:
        with self.lock:
            row = self.conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
            if not row:
                raise LookupError(f"Document {doc_id} not found")
            return self._doc_dict(row)

    def update_document(self, doc_id: int, fields: dict) -> dict:
        doc = self.get_document(doc_id)
        metadata = {"title", "authors", "year", "venue", "doi", "url"}
        updates = {k: (json.dumps(v) if k == "authors" else v) for k, v in fields.items() if k in metadata | {"topic_id"}}
        edited = set(doc["edited_fields"]) | (metadata & updates.keys())
        if edited != set(doc["edited_fields"]):
            updates["edited_fields"] = json.dumps(sorted(edited))
        with self.lock, self.conn:
            if updates:
                cols = ", ".join(f"{k} = ?" for k in updates)
                self.conn.execute(f"UPDATE documents SET {cols} WHERE id = ?", (*updates.values(), doc_id))
            if "tags" in fields:
                self.conn.execute("DELETE FROM tags WHERE doc_id = ?", (doc_id,))
                self.conn.executemany(
                    "INSERT OR IGNORE INTO tags (doc_id, tag) VALUES (?, ?)",
                    [(doc_id, t.strip().lower()) for t in fields["tags"] if t.strip()],
                )
        return self.get_document(doc_id)

    def delete_document(self, doc_id: int) -> None:
        with self.lock, self.conn:
            if not self.conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,)).rowcount:
                raise LookupError(f"Document {doc_id} not found")
            self._invalidate_index()

    # ---------- duplicate files ----------

    def _file_info(self, source: str) -> dict:
        """Whether a document's source is a file on disk, its size and SHA-256. The hash is cached
        while the file's size and modification time stay the same."""
        if re.match(r"^https?://", source, re.I):
            return {"is_file": False, "exists": False, "size": None, "sha256": None, "real": None}
        path = Path(source)
        try:
            st = path.stat()
            if not path.is_file():
                raise OSError
        except OSError:
            return {"is_file": True, "exists": False, "size": None, "sha256": None, "real": None}
        with self.lock:
            row = self.conn.execute("SELECT size, mtime, sha256 FROM file_hashes WHERE path = ?", (source,)).fetchone()
        if row and row["size"] == st.st_size and row["mtime"] == st.st_mtime:
            sha = row["sha256"]
        else:
            sha = dupfiles.file_sha256(source)
            with self.lock, self.conn:
                self.conn.execute(
                    "INSERT INTO file_hashes (path, size, mtime, sha256) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE "
                    "SET size = excluded.size, mtime = excluded.mtime, sha256 = excluded.sha256",
                    (source, st.st_size, st.st_mtime, sha),
                )
        return {"is_file": True, "exists": True, "size": st.st_size, "sha256": sha,
                "real": os.path.normcase(os.path.realpath(source))}

    def find_duplicate_files(self, cited: list[int] | None = None) -> dict:
        """Groups of library documents that duplicate each other, labelled by how strong the
        evidence is, each with the copy we suggest keeping and the space removing the others
        would free. A recommendation only: nothing is removed here. `cited` are the documents
        the draft cites, which are preferred as the copy to keep."""
        cited_ids = set(cited or [])
        with self.lock:
            rows = [dict(r) for r in self.conn.execute(
                "SELECT id, source, kind, title, authors, year, doi, venue, page_count, added_at, edited_fields "
                "FROM documents ORDER BY id")]
            texts: dict[int, list[str]] = defaultdict(list)
            for r in self.conn.execute("SELECT doc_id, text FROM pages ORDER BY doc_id, page"):
                texts[r["doc_id"]].append(r["text"])
            in_folders: dict[int, list[tuple[str, str]]] = defaultdict(list)
            for r in self.conn.execute(
                "SELECT df.doc_id, f.name, df.state FROM doc_folders df JOIN folders f ON f.id = df.folder_id "
                "WHERE df.state != 'rejected' ORDER BY f.name COLLATE NOCASE"
            ):
                in_folders[r["doc_id"]].append((r["name"], r["state"]))

        docs: dict[int, dict] = {}
        for r in rows:
            text = dupfiles.normalize_text("\n".join(texts[r["id"]]))
            docs[r["id"]] = {
                **{k: r[k] for k in ("id", "source", "kind", "title", "year", "doi", "venue", "page_count", "added_at")},
                "authors": json.loads(r["authors"]),
                "folders": [name for name, _ in in_folders[r["id"]]],
                "user_folders": sum(state == "user" for _, state in in_folders[r["id"]]),
                "edited": len(json.loads(r["edited_fields"])),
                "cited": r["id"] in cited_ids,
                **self._file_info(r["source"]),
                "text": text if len(text) >= dupfiles.MIN_TEXT_CHARS else "",
            }

        # Documents already shown as identical (same bytes or same text) form clusters, so they
        # aren't listed again as "likely the same" and their freed space is counted once.
        parent = {i: i for i in docs}

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        def union(members):
            for m in members[1:]:
                parent[find(m["id"])] = find(members[0]["id"])

        groups = []
        by_sha: dict[str, list[dict]] = defaultdict(list)
        for d in docs.values():
            if d["sha256"]:
                by_sha[d["sha256"]].append(d)
        for sha, members in by_sha.items():
            if len(members) > 1:
                reasons = [f"SHA-256 {sha[:16]}… matches"]
                if len({m["real"] for m in members}) < len(members):
                    reasons.append("Some entries point to the same file on disk, so removing them frees no space")
                groups.append(self._dup_group("exact_file", members, reasons, 100))
                union(members)

        by_text: dict[str, list[dict]] = defaultdict(list)
        for d in docs.values():
            if d["text"]:
                by_text[dupfiles.text_sha256(d["text"])].append(d)
        for members in by_text.values():
            # Skip when every member is the same file: that's already an exact duplicate.
            if len(members) > 1 and len({m["sha256"] or m["id"] for m in members}) > 1:
                groups.append(self._dup_group("same_text", members, ["Extracted text is identical after normalizing formatting"], 100))
                union(members)

        # Near matches: pairs that share a DOI, have alike titles, or whose text embeddings are
        # very close are candidates; metadata and shared passages then decide.
        pairs: set[tuple[int, int]] = set()
        by_doi: dict[str, list[int]] = defaultdict(list)
        for d in docs.values():
            if dupfiles.norm_doi(d["doi"]):
                by_doi[dupfiles.norm_doi(d["doi"])].append(d["id"])
        for ids in by_doi.values():
            pairs |= {(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]}
        words = {i: set(dupfiles.norm_title(d["title"]).split()) for i, d in docs.items()}
        ids = sorted(docs)
        for n, a in enumerate(ids):
            for b in ids[n + 1:]:
                wa, wb = words[a], words[b]
                if wa and wb and len(wa & wb) >= 0.6 * max(len(wa), len(wb)):
                    pairs.add((a, b))
        with self.lock:
            self._load_index()
            chunk_docs, mat = self._docs, self._mat
        if len(chunk_docs):
            doc_ids = np.unique(chunk_docs)
            vecs = np.stack([mat[chunk_docs == d].mean(axis=0) for d in doc_ids])
            vecs /= np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-9
            for i, j in np.argwhere(np.triu(vecs @ vecs.T, 1) >= DUP_DOC_COS):
                a, b = int(doc_ids[i]), int(doc_ids[j])
                if a in docs and b in docs:
                    pairs.add((min(a, b), max(a, b)))

        grams: dict[int, set[int]] = {}

        def text_grams(d):
            if d["id"] not in grams:
                grams[d["id"]] = dupfiles.shingles(d["text"])
            return grams[d["id"]]

        for a, b in sorted(pairs):
            if find(a) == find(b):
                continue
            da, db = docs[a], docs[b]
            shared = dupfiles.overlap(text_grams(da), text_grams(db)) if da["text"] and db["text"] else None
            verdict = dupfiles.classify_pair(dupfiles.compare_metadata(da, db), shared)
            if verdict:
                kind, reasons = verdict
                groups.append(self._dup_group(kind, [da, db], reasons, None if shared is None else round(100 * shared)))

        order = list(dupfiles.KINDS)
        groups.sort(key=lambda g: (order.index(g["kind"]), -g["recoverable"]))

        clusters: dict[int, list[dict]] = defaultdict(list)
        for d in docs.values():
            clusters[find(d["id"])].append(d)
        identical = sum(self._freed(members, dupfiles.suggest_keep(members, "exact_file")[0])
                        for members in clusters.values() if len(members) > 1)
        # Space from also removing the copy not kept in each "likely the same" pair, each file once.
        extra: dict[str, int] = {}
        for g in groups:
            if g["kind"] == "likely_same":
                for d in g["docs"]:
                    full = docs[d["id"]]
                    if d["id"] != g["keep"] and full["exists"] and len(clusters[find(d["id"])]) == 1:
                        extra[full["real"]] = full["size"]
        return {
            "groups": groups,
            "counts": {k: sum(g["kind"] == k for g in groups) for k in dupfiles.KINDS},
            "recoverable": {"identical": identical, "likely_same": sum(extra.values())},
            "scanned": len(docs),
            "files": sum(d["exists"] for d in docs.values()),
            "missing": sum(d["is_file"] and not d["exists"] for d in docs.values()),
            "web": sum(not d["is_file"] for d in docs.values()),
            "no_text": sum(not d["text"] for d in docs.values()),
        }

    @staticmethod
    def _freed(members: list[dict], keep: int) -> int:
        """Bytes freed by removing every member except `keep`; entries pointing at one file count once."""
        kept = next(m for m in members if m["id"] == keep)
        seen = {kept["real"]}
        freed = 0
        for m in members:
            if m["exists"] and m["real"] not in seen:
                seen.add(m["real"])
                freed += m["size"]
        return freed

    def _dup_group(self, kind: str, members: list[dict], reasons: list[str], similarity: int | None) -> dict:
        keep, why = dupfiles.suggest_keep(members, kind)
        public = ("id", "title", "source", "kind", "authors", "year", "doi", "venue", "page_count", "added_at",
                  "folders", "cited", "is_file", "exists", "size")
        return {
            "kind": kind,
            "label": dupfiles.KINDS[kind],
            "explanation": dupfiles.EXPLAIN[kind],
            "reasons": reasons,
            "similarity": similarity,
            "keep": keep,
            "keep_reason": why,
            "recoverable": self._freed(members, keep),
            "docs": [{k: m[k] for k in public} for m in members],
        }

    def get_page(self, doc_id: int, page: int) -> dict:
        with self.lock:
            row = self.conn.execute(
                "SELECT p.text, p.label, d.page_numbering FROM pages p JOIN documents d ON d.id = p.doc_id "
                "WHERE p.doc_id = ? AND p.page = ?",
                (doc_id, page),
            ).fetchone()
        if not row:
            raise LookupError(f"Page {page} of document {doc_id} not found")
        return {"doc_id": doc_id, "page": page, "text": row["text"], "label": row["label"],
                "page_numbering": row["page_numbering"]}

    # ---------- search ----------

    def _invalidate_index(self) -> None:
        self._ids = self._docs = self._mat = None

    def _load_index(self) -> None:
        if self._ids is not None:
            return
        rows = self.conn.execute("SELECT id, doc_id, embedding FROM chunks WHERE embedding IS NOT NULL").fetchall()
        self._ids = np.array([r["id"] for r in rows], dtype=np.int64)
        self._docs = np.array([r["doc_id"] for r in rows], dtype=np.int64)
        # One buffer for every vector: much faster than a small array per chunk on a large library.
        self._mat = (np.frombuffer(b"".join(r["embedding"] for r in rows), dtype=np.float32).reshape(len(rows), -1)
                     if rows else np.zeros((0, 1), np.float32))

    def search(self, query: str, k: int = 8, doc_ids: list[int] | None = None,
               mode: str = "auto", rerank: bool = True) -> list[dict]:
        """Best chunks for a query.

        Candidates come from embeddings ("dense"), BM25 ("keyword") or both merged by
        reciprocal rank fusion ("hybrid"); the reranker, when loaded and `rerank` is set,
        then reorders them. "auto" is hybrid, reranked when a reranker is loaded: on the
        14,000-chunk eval (eval/README.md) fusion beat embeddings alone even without one
        (R@1 0.37 vs 0.27), though it trailed slightly on the 40-passage set."""
        if mode == "auto":
            mode = "hybrid"
        use_reranker = rerank and self.reranker is not None
        pool = max(k * 3, 24) if use_reranker else k
        if mode == "dense":
            ranked = self._dense(query, pool, doc_ids)
        elif mode == "keyword":
            ranked = self._keyword(query, pool, doc_ids)
        elif mode == "hybrid":
            wide = max(pool, 40)
            ranked = reciprocal_rank_fusion(
                [cid for cid, _ in self._dense(query, wide, doc_ids)],
                [cid for cid, _ in self._keyword(query, wide, doc_ids)],
            )[:pool]
        else:
            raise ValueError(f"Unknown search mode {mode!r}")
        if use_reranker and ranked:
            ranked = self._rerank(query, ranked)
        return [h for h in (self._hit(cid, score) for cid, score in ranked[:k]) if h]

    def _rerank(self, query: str, ranked: list[tuple[int, float]]) -> list[tuple[int, float]]:
        with self.lock:
            texts = {
                r["id"]: r["text"]
                for r in self.conn.execute(
                    f"SELECT id, text FROM chunks WHERE id IN ({','.join('?' * len(ranked))})",
                    [cid for cid, _ in ranked],
                )
            }
        ids = [cid for cid, _ in ranked if cid in texts]
        scores = self.reranker.score(query, [texts[cid] for cid in ids])
        return sorted(zip(ids, scores), key=lambda kv: -kv[1])

    def _dense(self, query: str, n: int, doc_ids: list[int] | None) -> list[tuple[int, float]]:
        # Embed before taking the lock: the model call is the slow part, and holding the lock
        # through it would stall every other request (saves, library listing) meanwhile.
        vec = self.embedder.embed([query])[0]
        with self.lock:
            self._load_index()
            if not len(self._ids):
                return []
            scores = self._mat @ vec
            if doc_ids:
                scores = np.where(np.isin(self._docs, doc_ids), scores, -np.inf)
            return [(int(self._ids[i]), float(scores[i])) for i in np.argsort(-scores)[:n] if np.isfinite(scores[i])]

    def _keyword(self, query: str, n: int, doc_ids: list[int] | None) -> list[tuple[int, float]]:
        match = fts_query(query)
        if not match:
            return []
        scope = f" AND c.doc_id IN ({','.join('?' * len(doc_ids))})" if doc_ids else ""
        with self.lock:
            rows = self.conn.execute(
                "SELECT c.id, bm25(chunks_fts) AS s FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid "
                f"WHERE chunks_fts MATCH ?{scope} ORDER BY s LIMIT ?",
                (match, *(doc_ids or []), n),
            ).fetchall()
        return [(r["id"], -r["s"]) for r in rows]  # FTS5's bm25() is lower-is-better

    def _hit(self, chunk_id: int, score: float) -> dict | None:
        with self.lock:
            row = self.conn.execute(
                "SELECT c.*, d.title, d.authors, d.year, d.kind, d.page_numbering, p.label AS page_label "
                "FROM chunks c JOIN documents d ON d.id = c.doc_id "
                "LEFT JOIN pages p ON p.doc_id = c.doc_id AND p.page = c.page WHERE c.id = ?",
                (chunk_id,),
            ).fetchone()
        if not row:
            return None
        hit = dict(row)
        hit.pop("embedding")
        hit["authors"] = json.loads(hit["authors"])
        hit["score"] = score
        # The model sees this label, so it cites printed page numbers too.
        hit["label"] = short_label(hit, page=hit["page"], page_label=hit["page_label"])
        return hit

    # ---------- topics ----------

    def list_topics(self) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT t.*, COUNT(d.id) AS doc_count FROM topics t LEFT JOIN documents d ON d.topic_id = t.id "
                "GROUP BY t.id ORDER BY doc_count DESC, t.label"
            ).fetchall()
            return [dict(r) for r in rows]

    def rebuild_topics(self) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT doc_id, embedding, length(text) AS n FROM chunks WHERE embedding IS NOT NULL"
            ).fetchall()
            by_doc: dict[int, list[tuple[np.ndarray, int]]] = {}
            for r in rows:
                by_doc.setdefault(r["doc_id"], []).append((from_blob(r["embedding"]), r["n"]))
            if not by_doc:
                return []
            doc_ids = sorted(by_doc)
            # Weight by chunk length so a short appendix or caption can't pull a document's topic.
            x = np.stack([
                np.average([v for v, _ in by_doc[d]], axis=0, weights=[n for _, n in by_doc[d]])
                for d in doc_ids
            ])
            x /= np.linalg.norm(x, axis=1, keepdims=True) + 1e-9
            labels = kmeans(x, choose_k(len(doc_ids)))

            old = {
                t["id"]: (t, {r["id"] for r in self.conn.execute("SELECT id FROM documents WHERE topic_id = ?", (t["id"],))})
                for t in self.conn.execute("SELECT * FROM topics").fetchall()
            }
            clusters = [[doc_ids[i] for i in np.flatnonzero(labels == c)] for c in sorted(set(labels.tolist()))]

        # Name clusters outside the lock: with a real provider this is a network call each.
        named = []
        for members in clusters:
            match = max(old.values(), key=lambda o: jaccard(o[1], set(members)), default=None)
            if match and match[0]["user_named"] and jaccard(match[1], set(members)) >= 0.5:
                named.append((members, match[0]["label"], match[0]["description"], 1))
                continue
            samples = [f"{d['title']}\n{d['summary']}" for d in (self.get_document(m) for m in members[:10])]
            info = self.provider.name_topic(samples)
            named.append((members, info.get("label") or "Untitled topic", info.get("description", ""), 0))

        with self.lock, self.conn:
            self.conn.execute("DELETE FROM topics")
            for members, label, desc, user_named in named:
                tid = self.conn.execute(
                    "INSERT INTO topics (label, description, user_named) VALUES (?, ?, ?)", (label, desc, user_named)
                ).lastrowid
                self.conn.executemany("UPDATE documents SET topic_id = ? WHERE id = ?", [(tid, m) for m in members])
        return self.list_topics()

    def rename_topic(self, topic_id: int, label: str, description: str | None = None) -> dict:
        with self.lock, self.conn:
            cur = self.conn.execute(
                "UPDATE topics SET label = ?, description = COALESCE(?, description), user_named = 1 WHERE id = ?",
                (label.strip(), description, topic_id),
            )
            if not cur.rowcount:
                raise LookupError(f"Topic {topic_id} not found")
        return next(t for t in self.list_topics() if t["id"] == topic_id)

    def merge_topics(self, source_ids: list[int], into_id: int) -> list[dict]:
        sources = [s for s in source_ids if s != into_id]
        with self.lock, self.conn:
            if not self.conn.execute("SELECT 1 FROM topics WHERE id = ?", (into_id,)).fetchone():
                raise LookupError(f"Topic {into_id} not found")
            marks = ",".join("?" * len(sources))
            if sources:
                self.conn.execute(f"UPDATE documents SET topic_id = ? WHERE topic_id IN ({marks})", (into_id, *sources))
                self.conn.execute(f"DELETE FROM topics WHERE id IN ({marks})", sources)
        return self.list_topics()

    # ---------- virtual folders ----------

    def list_folders(self) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT f.id, f.name, f.similarity, COUNT(df.doc_id) AS doc_count FROM folders f "
                "LEFT JOIN doc_folders df ON df.folder_id = f.id AND df.state != 'rejected' "
                "GROUP BY f.id ORDER BY f.name COLLATE NOCASE"
            ).fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def _folder_name(name: str) -> str:
        name = " ".join(str(name).split())[:40]
        if not name:
            raise ValueError("A folder needs a name")
        return name

    @staticmethod
    def _similarity(value: int) -> int:
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 100:
            raise ValueError("Similarity must be a whole number from 0 to 100")
        return value

    def create_folder(self, name: str, similarity: int = 50) -> list[dict]:
        """A folder the user defines by subject. Every document is scored against it and the
        ones at or above `similarity` percent are filed in."""
        name, similarity = self._folder_name(name), self._similarity(similarity)
        with self.lock, self.conn:
            if self.conn.execute("SELECT 1 FROM folders WHERE name = ?", (name,)).fetchone():
                raise ValueError(f"A folder called {name!r} already exists")
            folder_id = self.conn.execute(
                "INSERT INTO folders (name, similarity) VALUES (?, ?)", (name, similarity)
            ).lastrowid
        self._score_folder(folder_id)
        with self.lock, self.conn:
            self._apply_scores()
        return self.list_folders()

    def update_folder(self, folder_id: int, name: str | None = None, similarity: int | None = None) -> list[dict]:
        """Rename a folder and/or move its similarity threshold. A new name is a new subject, so
        its documents are scored again; a new threshold only re-files from the scores kept."""
        with self.lock:
            row = self.conn.execute("SELECT name FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if not row:
            raise LookupError(f"Folder {folder_id} not found")
        name = self._folder_name(name) if name is not None else None
        similarity = self._similarity(similarity) if similarity is not None else None
        retitled = name is not None and name.lower() != row["name"].lower()
        with self.lock, self.conn:
            if name is not None:
                clash = self.conn.execute("SELECT id FROM folders WHERE name = ?", (name,)).fetchone()
                if clash and clash["id"] != folder_id:
                    raise ValueError(f"A folder called {name!r} already exists")
                self.conn.execute("UPDATE folders SET name = ? WHERE id = ?", (name, folder_id))
            if similarity is not None:
                self.conn.execute("UPDATE folders SET similarity = ? WHERE id = ?", (similarity, folder_id))
            if retitled:
                self.conn.execute("DELETE FROM folder_scores WHERE folder_id = ?", (folder_id,))
        self._score_folder(folder_id)  # scores the documents that have none yet
        with self.lock, self.conn:
            self._apply_scores()
        return self.list_folders()

    @staticmethod
    def _blend(sims: np.ndarray) -> np.ndarray:
        """(chunks, folders) cosines -> one cosine per folder: half the mean of the three closest
        chunks, half the mean of all of them."""
        return 0.5 * np.sort(sims, axis=0)[-3:].mean(axis=0) + 0.5 * sims.mean(axis=0)

    def _folder_vectors(self, names: list[str]) -> np.ndarray:
        """Embeddings of folder names, kept per embedder since the same few get scored against every paper."""
        missing = [n for n in dict.fromkeys(names) if (self.embedder.id, n) not in self._name_vectors]
        if missing:
            with self._embed_lock:
                vectors = self.embedder.embed(missing)
            for name, vec in zip(missing, vectors):
                self._name_vectors[(self.embedder.id, name)] = vec
        return np.stack([self._name_vectors[(self.embedder.id, n)] for n in names])

    def _relative_fit(self, names: list[str]) -> dict[int, np.ndarray]:
        """First pass, from the chunk embeddings already stored: for each document, how far above
        or below the library's average it sits for each folder, in standard deviations (z).
        Raw cosines can't be read as percentages (a finance library scores every finance paper
        high for every finance folder), but the ranking they give is reliable. Call under the lock."""
        self._load_index()
        if not len(self._ids):
            return {}
        sims = self._mat @ self._folder_vectors(names).T  # (chunks, folders)
        order = np.argsort(self._docs, kind="stable")
        groups = np.split(order, np.flatnonzero(np.diff(self._docs[order])) + 1)
        cosine = np.stack([self._blend(sims[g]) for g in groups])
        spread = cosine.std(axis=0)
        z = (cosine - cosine.mean(axis=0)) / np.where(spread > 0, spread, 1.0)
        return {int(self._docs[g[0]]): z[i] for i, g in enumerate(groups)}

    def _ask_model(self, doc_id: int, names: list[str]) -> dict[str, int]:
        with self.lock:
            doc = self.get_document(doc_id)
            text = "\n\n".join(r["text"] for r in self.conn.execute(
                "SELECT text FROM pages WHERE doc_id = ? ORDER BY page LIMIT 4", (doc_id,)))
        signals = []  # what the authors printed is the strongest hint of the subject
        if doc["keywords"]:
            signals.append("Keywords: " + "; ".join(doc["keywords"]))
        if doc["jel_codes"]:
            signals.append("JEL: " + "; ".join(f"{j['code']} ({j['area']})" for j in doc["jel_codes"]))
        text = "\n".join(signals) + ("\n\n" if signals else "") + text
        return self.provider.score_folders(doc["title"], doc["summary"], text, names)  # network call: no lock

    def _score(self, doc_ids: list[int] | None = None, folder_ids: list[int] | None = None) -> None:
        """Score documents (all by default) against folders (all by default) and keep the scores.

        Two stages. Embeddings rank every document for every folder at no cost. Muse then judges
        the pairs that could plausibly be a match (above the library's average for that folder),
        which is where its reading of the content beats an embedding. The rest keep a low score
        from the embedding alone, capped so an unchecked paper only joins at a very low threshold.
        Small libraries skip the first stage: there is no average to speak of, and few papers to read."""
        with self.lock:
            folders = self.conn.execute("SELECT id, name FROM folders ORDER BY id").fetchall()
            if folder_ids is not None:
                folders = [f for f in folders if f["id"] in folder_ids]
            known = [r["id"] for r in self.conn.execute("SELECT id FROM documents ORDER BY id")]
            targets = known if doc_ids is None else [d for d in doc_ids if d in set(known)]
            if not folders or not targets:
                return
            names = [f["name"] for f in folders]
            fit = self._relative_fit(names) if len(known) >= MIN_DOCS_FOR_RELATIVE else {}

        def one(doc_id: int) -> None:
            z = fit.get(doc_id)
            ask = [i for i in range(len(names)) if z is None or z[i] >= 0]
            verdict: dict[str, int] = {}
            if ask:
                try:
                    verdict = self._ask_model(doc_id, [names[i] for i in ask])
                except Exception:  # fall back to the embedding ranking for this document
                    log.exception("Folder scoring failed for document %s", doc_id)
            rows = []
            for i, f in enumerate(folders):
                if names[i] in verdict:
                    score = verdict[names[i]]
                elif z is not None:
                    score = int(round(min(max(50 + 25 * z[i], 0), 100)))
                    if i not in ask:
                        score = min(score, UNCHECKED_CAP)
                else:
                    continue
                rows.append((doc_id, f["id"], score))
            with self.lock, self.conn:
                if self.conn.execute("SELECT 1 FROM documents WHERE id = ?", (doc_id,)).fetchone():
                    self.conn.executemany(
                        "INSERT OR REPLACE INTO folder_scores (doc_id, folder_id, score) VALUES (?, ?, ?)", rows
                    )

        with ThreadPoolExecutor(max_workers=min(INGEST_WORKERS, len(targets))) as pool:
            list(pool.map(one, targets))

    def _score_folder(self, folder_id: int) -> None:
        """Score every document that has no score for this folder yet."""
        with self.lock:
            ids = [r["id"] for r in self.conn.execute(
                "SELECT id FROM documents WHERE id NOT IN (SELECT doc_id FROM folder_scores WHERE folder_id = ?)",
                (folder_id,),
            )]
        self._score(ids, [folder_id])

    def _apply_scores(self) -> None:
        """File each document in the folders whose threshold its score reaches. Only 'auto'
        placements change: ones the user added or removed are left as they decided, and so is
        a placement with no score yet (from before scores were kept) until it is scored."""
        self.conn.execute(
            "DELETE FROM doc_folders WHERE state = 'auto' AND EXISTS ("
            "SELECT 1 FROM folder_scores s JOIN folders f ON f.id = s.folder_id "
            "WHERE s.doc_id = doc_folders.doc_id AND s.folder_id = doc_folders.folder_id AND s.score < f.similarity)"
        )
        self.conn.execute(
            "INSERT OR IGNORE INTO doc_folders (doc_id, folder_id, state) "
            "SELECT s.doc_id, s.folder_id, 'auto' FROM folder_scores s JOIN folders f ON f.id = s.folder_id "
            "WHERE s.score >= f.similarity"
        )

    def classify_document(self, doc_id: int) -> dict:
        """(Re)score one document against every folder and file it where it clears the threshold."""
        self._score([doc_id])
        with self.lock, self.conn:
            self._apply_scores()
        return self.get_document(doc_id)

    def classify_all(self) -> list[dict]:
        self._score()
        with self.lock, self.conn:
            self._apply_scores()
        return self.list_folders()

    def set_folder_membership(self, doc_id: int, folder_id: int, member: bool) -> dict:
        """The user's correction: put a document in a folder, or say it doesn't belong there."""
        with self.lock, self.conn:
            self.get_document(doc_id)
            if not self.conn.execute("SELECT 1 FROM folders WHERE id = ?", (folder_id,)).fetchone():
                raise LookupError(f"Folder {folder_id} not found")
            self.conn.execute(  # 'rejected' stays put when scores change, so the match doesn't come back
                "INSERT INTO doc_folders (doc_id, folder_id, state) VALUES (?, ?, ?) "
                "ON CONFLICT(doc_id, folder_id) DO UPDATE SET state = excluded.state",
                (doc_id, folder_id, "user" if member else "rejected"),
            )
        return self.get_document(doc_id)

    def add_to_folder_named(self, doc_id: int, name: str) -> dict:
        with self.lock:
            row = self.conn.execute("SELECT id FROM folders WHERE name = ?", (self._folder_name(name),)).fetchone()
        if not row:
            raise LookupError(f"No folder called {name!r}. Create it first with New folder.")
        return self.set_folder_membership(doc_id, row["id"], True)

    def delete_folder(self, folder_id: int) -> list[dict]:
        """Removes the folder only; its documents stay in the library."""
        with self.lock, self.conn:
            if not self.conn.execute("DELETE FROM folders WHERE id = ?", (folder_id,)).rowcount:
                raise LookupError(f"Folder {folder_id} not found")
        return self.list_folders()

    # ---------- writing with citations ----------

    def draft(self, instruction: str, context: str = "", doc_ids: list[int] | None = None,
              k: int = 8, verify: bool = False) -> dict:
        # Retrieve on the instruction alone: the document so far is usually longer and would
        # drown out the question. Context only reaches the model, for continuity and voice.
        hits = self.search(instruction, k=k, doc_ids=doc_ids)
        passages = [Passage(f"P{i + 1}", h["id"], h["label"], h["text"]) for i, h in enumerate(hits)]
        if not passages:
            return {"sentences": [], "passages": []}
        by_pid = {p.pid: p for p in passages}
        sentences = []
        for s in self.provider.draft(instruction, context, passages):
            text = (s.get("text") or "").strip()
            if not text:
                continue
            cites = []
            for c in s.get("citations") or []:
                p = by_pid.get(str(c.get("passage", "")).strip("[] "))
                if p:  # silently drop citations to passage ids the model invented
                    cites.append(self.verify_citation(text, p.chunk_id, c.get("quote", ""), judge=verify))
            sentences.append({"text": text, "citations": cites})
        return {
            "sentences": sentences,
            "passages": [{"pid": p.pid, "chunk_id": p.chunk_id, "label": p.label} for p in passages],
        }

    def verify_citation(self, claim: str, chunk_id: int, quote: str, judge: bool = True) -> dict:
        with self.lock:
            ch = self.conn.execute("SELECT * FROM chunks WHERE id = ?", (chunk_id,)).fetchone()
            if not ch:
                raise LookupError(f"Chunk {chunk_id} not found")
            page_row = self.conn.execute(
                "SELECT text, label FROM pages WHERE doc_id = ? AND page = ?", (ch["doc_id"], ch["page"])
            ).fetchone()
        page_text = page_row["text"]
        doc = self.get_document(ch["doc_id"])

        loc = locate_quote(quote, ch["text"])
        if loc:
            start, end, ratio = ch["start"] + loc[0], ch["start"] + loc[1], loc[2]
        else:
            loc = locate_quote(quote, page_text)
            start, end, ratio = loc if loc else (None, None, 0.0)

        result = {
            "chunk_id": chunk_id, "doc_id": ch["doc_id"], "page": ch["page"], "page_label": page_row["label"],
            "quote": quote, "start": start, "end": end, "match": round(ratio, 3),
            "label": short_label(doc, page=ch["page"], page_label=page_row["label"]),
            "status": "pending", "reason": "",
        }
        if start is None:
            result.update(status="quote_not_found", reason="The quoted text does not appear in the cited source.")
        elif judge:
            # Judge against the located passage plus surrounding text on the page.
            window = page_text[max(0, start - 1500) : end + 1500]
            verdict = self.provider.judge_support(claim, window)
            result.update(status=VERDICT_STATUS[verdict["verdict"]], reason=verdict.get("reason", ""))
        return result

    def suggest_citations(self, claim: str, doc_ids: list[int] | None = None, limit: int = 4) -> list[dict]:
        """Sources for a sentence the user wrote. Finds the passages closest to the claim,
        picks the best-matching sentence in each as the quote, then runs the same support
        check as drafted citations. Supported sources come first; an empty or all-red
        result means the library doesn't back this claim yet."""
        claim = " ".join(claim.split())
        if not claim:
            raise ValueError("Select a sentence to cite")
        hits = self.search(claim, k=limit * 2, doc_ids=doc_ids)
        sentences = [
            (h, h["text"][s:e]) for h in hits for s, e in sentence_spans(h["text"]) if e - s >= 25
        ]
        if not sentences:
            return []
        if self.reranker:  # reads claim and sentence together: better at "which sentence says this"
            scores = self.reranker.score(claim, [q for _, q in sentences])
        else:
            vecs = self.embedder.embed([claim] + [q for _, q in sentences])
            scores = vecs[1:] @ vecs[0]
        best: dict[tuple[int, str], tuple[float, dict, str]] = {}  # one entry per (doc, quote)
        for (hit, quote), score in zip(sentences, scores):
            key = (hit["doc_id"], quote)
            if key not in best or score > best[key][0]:
                best[key] = (float(score), hit, quote)
        per_chunk: dict[int, tuple[float, dict, str]] = {}  # best sentence per chunk
        for score, hit, quote in best.values():
            if hit["id"] not in per_chunk or score > per_chunk[hit["id"]][0]:
                per_chunk[hit["id"]] = (score, hit, quote)
        top = sorted(per_chunk.values(), key=lambda c: -c[0])[:limit]
        # Each check is a model call, so only the top few candidates are judged.
        results = [{**self.verify_citation(claim, hit["id"], quote), "score": round(score, 4)} for score, hit, quote in top]
        rank = {"verified": 0, "weak": 1, "unsupported": 2, "quote_not_found": 3}
        return sorted(results, key=lambda r: (rank.get(r["status"], 4), -r["score"]))

    def resolve_citations(self, items: list[tuple[int, int, str]]) -> list[dict | None]:
        """resolve_citation for each (doc_id, page, quote), in order. A draft's chips mostly
        cite a few documents, so each document's pages are read once for all of them, and a
        chip repeated in the draft is looked up once."""
        cache: dict = {}
        done: dict[tuple[int, int, str], dict | None] = {}
        for item in items:
            if item not in done:
                done[item] = self.resolve_citation(*item, _cache=cache)
        return [done[item] for item in items]

    def resolve_citation(self, doc_id: int, page: int, quote: str, _cache: dict | None = None) -> dict | None:
        """Re-find a saved citation's quote in the library as it is now. Citations in drafts
        store character offsets and a chunk id, which go stale when a file is re-added (new
        extraction, new chunks) or was removed and added again (new document id).

        Searches the cited page, then the rest of the same document. Only if that document
        no longer exists does it look elsewhere, by exact or normalized match, so a citation
        is never silently moved to a different source that happens to contain similar text.
        Returns the citation's current location, or None if the quote can't be found."""
        cache = {} if _cache is None else _cache
        with self.lock:
            if doc_id not in cache:  # the document's pages, or None if it's gone
                exists = self.conn.execute("SELECT 1 FROM documents WHERE id = ?", (doc_id,)).fetchone()
                cache[doc_id] = self.conn.execute(
                    "SELECT doc_id, page, text, label FROM pages WHERE doc_id = ? ORDER BY page", (doc_id,)
                ).fetchall() if exists else None
            if cache[doc_id] is not None:
                rows = sorted(cache[doc_id], key=lambda r: r["page"] != page)  # the cited page first
                fuzzy = True
            else:
                if "*" not in cache:
                    cache["*"] = self.conn.execute(
                        "SELECT doc_id, page, text, label FROM pages ORDER BY doc_id, page").fetchall()
                rows = cache["*"]
                fuzzy = False
        for row in rows:
            loc = locate_quote(quote, row["text"], fuzzy=fuzzy)
            if not loc:
                continue
            start, end, ratio = loc
            with self.lock:
                chunk = self.conn.execute(
                    "SELECT id FROM chunks WHERE doc_id = ? AND page = ? AND start < ? AND end > ? "
                    "ORDER BY (start <= ? AND end >= ?) DESC, min(end, ?) - max(start, ?) DESC LIMIT 1",
                    (row["doc_id"], row["page"], end, start, start, end, end, start),
                ).fetchone()
            if not chunk:
                continue
            doc = self.get_document(row["doc_id"])
            return {
                "doc_id": row["doc_id"], "chunk_id": chunk["id"], "page": row["page"], "page_label": row["label"],
                "start": start, "end": end, "match": round(ratio, 3),
                "label": short_label(doc, page=row["page"], page_label=row["label"]),
            }
        return None

    def references(self, doc_ids: list[int], style: str) -> dict:
        docs = [self.get_document(d) for d in dict.fromkeys(doc_ids)]
        return {"style": style, "entries": format_references(docs, style)}

    # ---------- user settings ----------

    def get_settings(self) -> dict:
        with self.lock:
            stored = json.loads(db.get_meta(self.conn, "settings") or "{}")
        return {**USER_SETTINGS_DEFAULTS, **{k: v for k, v in stored.items() if k in USER_SETTINGS_DEFAULTS}}

    def update_settings(self, changes: dict) -> dict:
        for key, value in changes.items():
            allowed = USER_SETTINGS_CHOICES.get(key)
            if allowed is None:
                raise ValueError(f"Unknown setting {key!r}")
            if value not in allowed:
                raise ValueError(f"{key} must be one of {', '.join(allowed)}")
        merged = {**self.get_settings(), **changes}
        with self.lock, self.conn:
            db.set_meta(self.conn, "settings", json.dumps(merged))
        return merged

    # ---------- drafts ----------

    def list_drafts(self) -> list[dict]:
        """Every draft, most recently edited first, with its word count (not its content)."""
        with self.lock:
            rows = self.conn.execute("SELECT id, title, content, updated_at FROM drafts ORDER BY updated_at DESC, id DESC").fetchall()
        return [{"id": r["id"], "title": r["title"], "updated_at": r["updated_at"],
                 "words": draft_review.word_count(draft_review.plain_text(r["content"]))} for r in rows]

    def create_draft(self, title: str = "Untitled", content: str = "") -> dict:
        with self.lock, self.conn:
            draft_id = self.conn.execute("INSERT INTO drafts (title, content) VALUES (?, '')", (title,)).lastrowid
        if content:
            return self.save_draft(draft_id, title, content)  # also takes its first version
        return self.get_draft(draft_id)

    def delete_draft(self, draft_id: int) -> None:
        """Delete a draft and its version history."""
        with self.lock, self.conn:
            if not self.conn.execute("DELETE FROM drafts WHERE id = ?", (draft_id,)).rowcount:
                raise LookupError(f"Draft {draft_id} not found")
            self.conn.execute("DELETE FROM draft_versions WHERE draft_id = ?", (draft_id,))

    @staticmethod
    def convert_docx(filename: str, data: bytes) -> dict:
        """A Word document as editor content, its title and what was converted, without saving anything."""
        try:
            doc, title, stats = docx_import.to_editor(data)
        except Exception as exc:  # not a .docx, or a damaged one
            raise ValueError(f"Couldn't read {filename or 'that file'} as a Word document (.docx): {exc}") from exc
        if not doc["content"]:
            raise ValueError(f"{filename or 'That document'} has no text to import.")
        return {"content": doc, "title": title or Path(filename).stem or "Imported draft", "imported": stats}

    def import_docx(self, filename: str, data: bytes) -> dict:
        """Open a Word document as a new draft. Returns the draft and what was converted."""
        converted = self.convert_docx(filename, data)
        return {"draft": self.create_draft(converted["title"], json.dumps(converted["content"])),
                "imported": converted["imported"]}

    def get_draft(self, draft_id: int) -> dict:
        with self.lock:
            row = self.conn.execute("SELECT * FROM drafts WHERE id = ?", (draft_id,)).fetchone()
        if not row:
            return {"id": draft_id, "title": "Untitled", "content": "", "updated_at": None}
        return dict(row)

    def save_draft(self, draft_id: int, title: str, content: str, snapshot: bool = True) -> dict:
        previous = self.get_draft(draft_id)
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO drafts (id, title, content, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, "
                "updated_at = CURRENT_TIMESTAMP",
                (draft_id, title, content),
            )
        if snapshot:
            self._auto_versions(draft_id, previous, title, content)
        return self.get_draft(draft_id)

    # ---------- draft versions ----------

    def _auto_versions(self, draft_id: int, previous: dict, title: str, content: str) -> None:
        """Snapshots taken while writing: the draft as it was before a large edit (a pasted draft,
        a deleted section), and the current draft when the last version is getting old."""
        old_text, new_text = draft_review.plain_text(previous["content"]), draft_review.plain_text(content)
        if old_text == new_text:
            return
        latest = self._latest_version(draft_id)
        if (draft_review.word_count(old_text) >= LARGE_EDIT_MIN_WORDS
                and (latest is None or latest["text"] != old_text)
                and draft_review.change_pct(old_text, new_text) >= LARGE_EDIT_PCT):
            self._add_version(draft_id, "auto", "Before a large edit", previous["title"], previous["content"])
            latest = self._latest_version(draft_id)
        if not new_text.strip():
            return
        with self.lock:
            fresh = latest is not None and self.conn.execute(
                "SELECT 1 FROM draft_versions WHERE id = ? AND created_at > datetime('now', ?)",
                (latest["id"], f"-{AUTO_VERSION_MINUTES} minutes"),
            ).fetchone()
        if not fresh and (latest is None or latest["text"] != new_text):
            self._add_version(draft_id, "auto", "", title, content)

    def _latest_version(self, draft_id: int) -> dict | None:
        with self.lock:
            row = self.conn.execute(
                "SELECT id, text FROM draft_versions WHERE draft_id = ? ORDER BY id DESC LIMIT 1", (draft_id,)
            ).fetchone()
        return dict(row) if row else None

    def _add_version(self, draft_id: int, kind: str, label: str, title: str, content: str) -> int:
        text = draft_review.plain_text(content)
        latest = self._latest_version(draft_id)
        change = draft_review.change_pct(latest["text"], text) if latest else 100
        with self.lock, self.conn:
            vid = self.conn.execute(
                "INSERT INTO draft_versions (draft_id, kind, label, title, content, text, words, change) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (draft_id, kind, label.strip()[:120], title, content, text, draft_review.word_count(text), change),
            ).lastrowid
            # Keep the newest automatic snapshots; milestones stay until the user deletes them.
            self.conn.execute(
                "DELETE FROM draft_versions WHERE draft_id = ? AND kind = 'auto' AND id NOT IN "
                "(SELECT id FROM draft_versions WHERE draft_id = ? AND kind = 'auto' ORDER BY id DESC LIMIT ?)",
                (draft_id, draft_id, MAX_AUTO_VERSIONS),
            )
        return vid

    def list_versions(self, draft_id: int) -> dict:
        """Versions newest first, numbered in the order they were taken, with how much the draft
        has changed since the newest one."""
        with self.lock:
            rows = self.conn.execute(
                "SELECT id, kind, label, title, words, change, created_at, text FROM draft_versions "
                "WHERE draft_id = ? ORDER BY id", (draft_id,)
            ).fetchall()
            numbers = {r["id"]: n for n, r in enumerate(
                self.conn.execute("SELECT id FROM draft_versions WHERE draft_id = ? ORDER BY id", (draft_id,)), 1)}
        current = draft_review.plain_text(self.get_draft(draft_id)["content"])
        versions = [{k: r[k] for k in r.keys() if k != "text"} | {"number": numbers[r["id"]]} for r in rows]
        return {
            "versions": versions[::-1],
            "current_words": draft_review.word_count(current),
            "current_change": draft_review.change_pct(rows[-1]["text"], current) if rows else None,
        }

    def _version(self, draft_id: int, version_id: int) -> dict:
        with self.lock:
            row = self.conn.execute(
                "SELECT * FROM draft_versions WHERE draft_id = ? AND id = ?", (draft_id, version_id)
            ).fetchone()
        if not row:
            raise LookupError(f"No version {version_id}")
        return dict(row)

    def get_version(self, draft_id: int, version_id: int) -> dict:
        v = self._version(draft_id, version_id)
        v.pop("text")
        return v

    def create_version(self, draft_id: int, label: str, title: str, content: str) -> dict:
        vid = self._add_version(draft_id, "milestone", label or "Saved version", title, content)
        return self.get_version(draft_id, vid)

    def rename_version(self, draft_id: int, version_id: int, label: str) -> dict:
        """Naming an automatic snapshot keeps it: it becomes a milestone and is never pruned."""
        self._version(draft_id, version_id)
        with self.lock, self.conn:
            self.conn.execute("UPDATE draft_versions SET label = ?, kind = 'milestone' WHERE id = ?",
                              (label.strip()[:120], version_id))
        return self.get_version(draft_id, version_id)

    def delete_version(self, draft_id: int, version_id: int) -> None:
        self._version(draft_id, version_id)
        with self.lock, self.conn:
            self.conn.execute("DELETE FROM draft_versions WHERE id = ?", (version_id,))

    def compare_version(self, draft_id: int, version_id: int, content: str | dict | None = None,
                        against: int | None = None) -> dict:
        """What changed from a version to `against` (another version), or else to `content`
        (the editor's unsaved document), or else to the saved draft."""
        old = self._version(draft_id, version_id)["content"]
        if against is not None:
            new = self._version(draft_id, against)["content"]
        elif content is not None:
            new = content
        else:
            new = self.get_draft(draft_id)["content"]
        return draft_review.compare(old, new)

    def restore_version(self, draft_id: int, version_id: int) -> dict:
        """Make a version the current draft, keeping the draft as it was as a snapshot first."""
        v = self._version(draft_id, version_id)
        current = self.get_draft(draft_id)
        if draft_review.plain_text(current["content"]) != v["text"]:
            name = v["label"] or f"version from {v['created_at']} UTC"
            self._add_version(draft_id, "auto", f"Before restoring “{name}”", current["title"], current["content"])
        return self.save_draft(draft_id, v["title"], v["content"], snapshot=False)

    # ---------- duplication ----------

    def check_duplicates(self, content: str | dict) -> dict:
        """Passages of a draft that repeat each other, or that match text in the library closely
        (copied or lightly edited from a source), with the share of the draft each covers."""
        bs = draft_review.blocks(content)
        sents = draft_review.draft_sentences(bs)
        internal = draft_review.internal_duplicates(bs)
        total = sum(len(s.tokens) for s in sents)
        checked = [k for k, s in enumerate(sents) if len(s.tokens) >= draft_review.MIN_SENTENCE_WORDS]

        # Candidate chunks per sentence: keyword hits catch copied wording, embeddings catch
        # rewordings the keywords miss. Overlap of word n-grams then decides.
        candidates: dict[int, set[int]] = {k: {cid for cid, _ in self._keyword(sents[k].text, 5, None)}
                                           for k in checked}
        vecs = self.embedder.embed([sents[k].text for k in checked]) if checked else None  # outside the lock
        with self.lock:
            self._load_index()
            if len(self._ids) and checked:
                top = min(3, len(self._ids))
                for k, scores in zip(checked, vecs @ self._mat.T):
                    candidates[k] |= {int(self._ids[i]) for i in np.argpartition(-scores, top - 1)[:top]}
            ids = sorted(set().union(*candidates.values())) if candidates else []
            chunk_text = {
                r["id"]: r["text"]
                for r in self.conn.execute(f"SELECT id, text FROM chunks WHERE id IN ({','.join('?' * len(ids))})", ids)
            } if ids else {}
        chunk_grams = {cid: draft_review.shingles(draft_review.words(t)) for cid, t in chunk_text.items()}

        matches = []
        flagged: dict[int, bool] = {}  # sentence index -> cited
        for k in checked:
            s = sents[k]
            grams = draft_review.shingles(s.tokens)
            best, score = None, 0.0
            for cid in candidates[k]:
                c = draft_review.containment(grams, chunk_grams.get(cid, set()))
                if c > score:
                    best, score = cid, c
            if best is None or score < SOURCE_MATCH:
                continue
            hit = self._hit(best, score)
            if not hit:
                continue
            span = draft_review.matched_span(s.text, hit["text"])
            a, b = span or (0, len(hit["text"]))
            cited = hit["doc_id"] in s.cited_docs
            flagged[k] = cited
            matches.append({
                "sentence": s.text, "block": s.block, "similarity": draft_review.pct(score),
                "level": "copied" if score >= SOURCE_COPIED else "close", "cited": cited,
                "doc_id": hit["doc_id"], "chunk_id": best, "page": hit["page"], "page_label": hit["page_label"],
                "label": hit["label"], "title": hit["title"],
                "start": hit["start"] + a, "end": hit["start"] + b, "quote": hit["text"][a:b],
            })

        repeated = set(internal["repeated"])
        share = lambda ks: draft_review.pct(sum(len(sents[k].tokens) for k in ks) / total) if total else 0  # noqa: E731
        per_block: dict[int, list[int]] = defaultdict(lambda: [0, 0])
        for k, s in enumerate(sents):
            per_block[s.block][0] += len(s.tokens)
            if k in flagged or k in repeated:
                per_block[s.block][1] += len(s.tokens)
        return {
            "words": total,
            "sentences_checked": len(checked),
            "overall": share(set(flagged) | repeated),
            "sources": share(flagged),
            "uncited": share(k for k, cited in flagged.items() if not cited),
            "internal": share(repeated),
            "source_matches": sorted(matches, key=lambda m: (m["cited"], -m["similarity"])),
            "repeated_sentences": internal["sentences"],
            "repeated_paragraphs": internal["paragraphs"],
            "paragraphs": [{"block": b, "words": w, "flagged": draft_review.pct(f / w), "text": bs[b].text[:200]}
                           for b, (w, f) in sorted(per_block.items()) if f],
        }


def page_range(labels: list[str]) -> str:
    """Printed page range, e.g. '341–355', for references, from a document's numeric page
    labels in page order. Empty when there are none: the PDF index isn't the published pagination."""
    if not labels:
        return ""
    return labels[0] if labels[0] == labels[-1] else f"{labels[0]}–{labels[-1]}"


def _surname(name: str) -> str:
    """'Chen, Wei' and 'Wei Chen' -> 'Chen'."""
    name = name.strip()
    if "," in name:
        return name.split(",")[0].strip()
    parts = name.split()
    return parts[-1] if parts else ""


def short_label(doc: dict, page: int | None = None, page_label: str | None = None) -> str:
    """'Smith et al. 2021, p. 342' style label for citation chips.

    `page` is the PDF page index; `page_label` the printed page number, when known."""
    authors = doc.get("authors") or []
    if isinstance(authors, str):
        authors = json.loads(authors)
    authors = [a for a in authors if isinstance(a, str) and _surname(a)]
    if authors:
        who = _surname(authors[0]) + (
            " et al." if len(authors) > 2 else f" & {_surname(authors[1])}" if len(authors) == 2 else ""
        )
    else:
        title = doc.get("title") or "Untitled"
        who = title if len(title) <= 40 else title[:37] + "..."
    year = doc.get("year")
    label = f"{who} {year}" if year and str(year) not in who else who
    if page is None:
        return label
    if doc.get("kind") == "pptx":
        label += f", slide {page}"
    elif doc.get("kind") == "pdf":
        if page_label:
            label += f", p. {page_label}"
        elif doc.get("page_numbering", "index") == "index":
            label += f", p. {page}"  # no printed numbers anywhere: the PDF index is the best we have
        else:
            # Unnumbered page (cover, front matter) in a printed-numbered document: say so,
            # or it would collide with the real p. 1.
            label += f", PDF p. {page}"
    return label
