"""The knowledge base: ingestion, search, topics, cited drafting and verification."""

import json
import logging
import threading
from pathlib import Path

import numpy as np

from . import db
from .citations import VERDICT_STATUS, locate_quote
from .embeddings import Embedder, from_blob, make_embedder, to_blob
from .ingest import ParsedDocument, chunk_page, is_supported, parse_file, parse_url
from .providers import LLMProvider, Passage, make_provider
from .references import format_references
from .settings import Settings
from .topics import choose_k, jaccard, kmeans

log = logging.getLogger(__name__)


class Library:
    def __init__(self, settings: Settings, provider: LLMProvider | None = None, embedder: Embedder | None = None):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        self.settings = settings
        self.conn = db.connect(settings.db_path)
        self.lock = threading.RLock()
        self.provider = provider or make_provider(settings)
        self.embedder = embedder or make_embedder(settings.embedder, settings.data_dir / "models")
        self._ids: np.ndarray | None = None  # in-memory vector index, rebuilt lazily
        self._docs: np.ndarray | None = None
        self._mat: np.ndarray | None = None
        self._reembed_if_needed()

    # ---------- ingestion ----------

    def ingest_path(self, path: str) -> list[dict]:
        p = Path(path).expanduser()
        if not p.exists():
            raise LookupError(f"No such file or folder: {p}")
        files = [p] if p.is_file() else sorted(f for f in p.rglob("*") if f.is_file() and is_supported(f))
        results = []
        for f in files:
            try:
                parsed = parse_file(f, self.provider.transcribe_image)
                results.append({"source": str(f), "ok": True, "document": self._store(parsed, str(f.resolve()))})
            except Exception as exc:
                log.exception("Failed to ingest %s", f)
                results.append({"source": str(f), "ok": False, "error": str(exc)})
        return results

    def ingest_url(self, url: str) -> dict:
        return self._store(parse_url(url), url)

    def _store(self, parsed: ParsedDocument, source: str) -> dict:
        full_text = "\n\n".join(parsed.pages)
        if not full_text.strip():
            raise ValueError("No text could be extracted")
        meta = {"title": "", "authors": [], "year": None, "venue": "", "doi": "", "url": ""}
        try:
            meta.update({k: v for k, v in self.provider.extract_metadata(parsed.pages[0] or full_text).items() if v})
        except Exception:
            log.exception("Metadata extraction failed for %s", source)
        meta.update({k: v for k, v in parsed.metadata.items() if v})  # file metadata wins when present
        title = meta["title"] or Path(source).stem
        summary = self.provider.summarize(title, full_text)
        tags = self.provider.tag_document(title, full_text)

        chunks = [
            (page_no, s, e, text[s:e])
            for page_no, text in enumerate(parsed.pages, start=1)
            for s, e in chunk_page(text)
        ]
        vectors = self.embedder.embed([c[3] for c in chunks]) if chunks else np.zeros((0, 1))

        fields = {
            "kind": parsed.kind, "title": title, "authors": json.dumps(meta["authors"]), "year": meta["year"],
            "venue": meta["venue"], "doi": meta["doi"], "url": meta["url"], "summary": summary,
            "page_count": len(parsed.pages), "page_numbering": parsed.page_numbering,
        }
        with self.lock, self.conn:
            existing = self.conn.execute(
                "SELECT id, edited_fields FROM documents WHERE source = ?", (source,)
            ).fetchone()
            if existing:
                # Re-adding a file refreshes its content in place: the id (which citations in
                # drafts point to), topic, tags and any metadata the user corrected all survive.
                doc_id = existing["id"]
                for key in json.loads(existing["edited_fields"]):
                    fields.pop(key, None)
                cols = ", ".join(f"{k} = ?" for k in fields)
                self.conn.execute(f"UPDATE documents SET {cols} WHERE id = ?", (*fields.values(), doc_id))
                self.conn.execute("DELETE FROM pages WHERE doc_id = ?", (doc_id,))
                self.conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
            else:
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

    # ---------- documents ----------

    def _doc_dict(self, row) -> dict:
        d = dict(row)
        d["authors"] = json.loads(d["authors"])
        d["edited_fields"] = json.loads(d["edited_fields"])
        d["tags"] = [r["tag"] for r in self.conn.execute("SELECT tag FROM tags WHERE doc_id = ? ORDER BY tag", (d["id"],))]
        d["label"] = short_label(d)
        d["page_range"] = self._page_range(d["id"], d["page_numbering"])
        return d

    def _page_range(self, doc_id: int, numbering: str) -> str:
        """Printed page range, e.g. '341–355', for references. Empty when only the PDF
        index is known: those numbers aren't the published pagination."""
        if numbering == "index":
            return ""
        nums = [
            r["label"]
            for r in self.conn.execute(
                "SELECT label FROM pages WHERE doc_id = ? AND label IS NOT NULL ORDER BY page", (doc_id,)
            )
            if r["label"].isdigit()
        ]
        if not nums:
            return ""
        return nums[0] if nums[0] == nums[-1] else f"{nums[0]}–{nums[-1]}"

    def list_documents(self) -> list[dict]:
        with self.lock:
            rows = self.conn.execute("SELECT * FROM documents ORDER BY added_at DESC, id DESC").fetchall()
            return [self._doc_dict(r) for r in rows]

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
        self._mat = np.stack([from_blob(r["embedding"]) for r in rows]) if rows else np.zeros((0, 1), np.float32)

    def search(self, query: str, k: int = 8, doc_ids: list[int] | None = None) -> list[dict]:
        with self.lock:
            self._load_index()
            if not len(self._ids):
                return []
            scores = self._mat @ self.embedder.embed([query])[0]
            if doc_ids:
                scores = np.where(np.isin(self._docs, doc_ids), scores, -np.inf)
            order = [i for i in np.argsort(-scores)[:k] if np.isfinite(scores[i])]
            hits = []
            for i in order:
                row = self.conn.execute(
                    "SELECT c.*, d.title, d.authors, d.year, d.kind, d.page_numbering, p.label AS page_label "
                    "FROM chunks c JOIN documents d ON d.id = c.doc_id "
                    "LEFT JOIN pages p ON p.doc_id = c.doc_id AND p.page = c.page WHERE c.id = ?",
                    (int(self._ids[i]),),
                ).fetchone()
                hit = dict(row)
                hit.pop("embedding")
                hit["authors"] = json.loads(hit["authors"])
                hit["score"] = float(scores[i])
                # The model sees this label, so it cites printed page numbers too.
                hit["label"] = short_label(hit, page=hit["page"], page_label=hit["page_label"])
                hits.append(hit)
            return hits

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

    def resolve_citation(self, doc_id: int, page: int, quote: str) -> dict | None:
        """Re-find a saved citation's quote in the library as it is now. Citations in drafts
        store character offsets and a chunk id, which go stale when a file is re-added (new
        extraction, new chunks) or was removed and added again (new document id).

        Searches the cited page, then the rest of the same document. Only if that document
        no longer exists does it look elsewhere, by exact or normalized match, so a citation
        is never silently moved to a different source that happens to contain similar text.
        Returns the citation's current location, or None if the quote can't be found."""
        with self.lock:
            doc_exists = self.conn.execute("SELECT 1 FROM documents WHERE id = ?", (doc_id,)).fetchone()
            if doc_exists:
                rows = self.conn.execute(
                    "SELECT doc_id, page, text, label FROM pages WHERE doc_id = ? ORDER BY page != ?, page",
                    (doc_id, page),
                ).fetchall()
                fuzzy = True
            else:
                rows = self.conn.execute("SELECT doc_id, page, text, label FROM pages ORDER BY doc_id, page").fetchall()
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

    # ---------- drafts ----------

    def get_draft(self, draft_id: int) -> dict:
        with self.lock:
            row = self.conn.execute("SELECT * FROM drafts WHERE id = ?", (draft_id,)).fetchone()
        if not row:
            return {"id": draft_id, "title": "Untitled", "content": "", "updated_at": None}
        return dict(row)

    def save_draft(self, draft_id: int, title: str, content: str) -> dict:
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO drafts (id, title, content, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, "
                "updated_at = CURRENT_TIMESTAMP",
                (draft_id, title, content),
            )
        return self.get_draft(draft_id)


def short_label(doc: dict, page: int | None = None, page_label: str | None = None) -> str:
    """'Smith et al. 2021, p. 342' style label for citation chips.

    `page` is the PDF page index; `page_label` the printed page number, when known."""
    authors = doc.get("authors") or []
    if isinstance(authors, str):
        authors = json.loads(authors)
    if authors:
        last = authors[0].split(",")[0].strip() if "," in authors[0] else authors[0].split()[-1]
        who = last + (" et al." if len(authors) > 2 else f" & {authors[1].split()[-1]}" if len(authors) == 2 else "")
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
