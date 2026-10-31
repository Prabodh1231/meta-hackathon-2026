"""Literature review matrices: one row per paper, one column per question (sample, setting,
method, findings, limitations, or the user's own), every cell a short answer resting on a verbatim
quote that has been found in the paper, or marked not reported. Detail columns sit beside them: the
paper's own record (year, journal, citations, abstract…, from the scholarly indexes), shown as it
is in the library, never read by the model.

A row is read with one model call: for each column the paper's own best passages are found with
search restricted to that paper (plus its opening, where abstracts say most), and the model
answers every column from them, quoting the passage it used. The quote is then located in the
paper, which gives the cell its page and highlight; a quote that can't be found is kept but
marked unverified. Rows are read in the background, several at once, and a row left half-read
(the app closed) is picked up again when the backend starts.
"""

import csv
import io
import json
import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor

from .citations import VERDICT_STATUS
from .export_docx import export_docx
from .providers import Passage

log = logging.getLogger(__name__)

# The columns systematic reviewers use. `query` is what each column's passages are searched with.
DEFAULT_COLUMNS = [
    {"key": "sample", "label": "Sample",
     "instruction": "Who or what was studied: participants, firms, countries or data, how many, and how they were chosen.",
     "query": "sample participants respondents observations data collected survey firms countries n ="},
    {"key": "setting", "label": "Setting",
     "instruction": "Where and when: country or region, sector or context, and the period covered.",
     "query": "country region setting context period years data from conducted in"},
    {"key": "method", "label": "Method",
     "instruction": "Research design and how the data were analysed (e.g. survey with SEM, panel regression, RCT).",
     "query": "method methodology research design model estimation regression analysis approach"},
    {"key": "findings", "label": "Findings",
     "instruction": "The main results, with direction and size where the paper gives them.",
     "query": "results findings we find show significant effect conclusion evidence"},
    {"key": "limitations", "label": "Limitations",
     "instruction": "Limitations the authors themselves acknowledge.",
     "query": "limitations limitation future research caveat shortcoming constraint generalisability"},
]
# Detail columns: the paper's record. Their keys start with "@" so they never clash with a question's.
DETAIL_FIELDS = {
    "authors": "Authors", "year": "Year", "published": "Published", "venue": "Journal", "volume": "Volume (issue)",
    "pages": "Pages", "publisher": "Publisher", "doi": "DOI", "cited_by_count": "Cited", "abstract": "Abstract",
    "keywords": "Keywords", "jel_codes": "JEL codes",
}
DEFAULT_DETAILS = ("year", "venue", "cited_by_count")
MAX_ROWS = 80
MAX_COLUMNS = 12  # questions: each costs a model call's worth of reading per paper; details are free
PASSAGES_PER_COLUMN = 3
MAX_PASSAGES = 16
WORKERS = 8  # rows read at once, as many as files during an import
DEFAULT_SYNTHESIS = ("Compare these studies: where their findings agree and where they differ, and how their "
                     "samples, settings and methods might explain the differences.")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:30] or "column"


def detail_column(field: str) -> dict:
    return {"key": f"@{field}", "kind": "detail", "field": field, "label": DETAIL_FIELDS[field], "instruction": "", "query": ""}


def default_columns() -> list[dict]:
    """What a new matrix starts with: the reviewers' questions, then a few details."""
    return [{**c, "kind": "question"} for c in DEFAULT_COLUMNS] + [detail_column(f) for f in DEFAULT_DETAILS]


def questions(columns: list[dict]) -> list[dict]:
    return [c for c in columns if c.get("kind") != "detail"]


def details(columns: list[dict]) -> list[dict]:
    return [c for c in columns if c.get("kind") == "detail"]


def normalize_columns(columns: list[dict] | None) -> list[dict]:
    """Columns as stored: unique keys, a label each, at most MAX_COLUMNS questions."""
    if columns is None:
        return default_columns()
    if not columns:
        raise ValueError("A matrix needs at least one column")
    if len([c for c in columns if c.get("kind") != "detail" and not str(c.get("key") or "").startswith("@")]) > MAX_COLUMNS:
        raise ValueError(f"At most {MAX_COLUMNS} question columns")
    defaults = {c["key"]: c for c in DEFAULT_COLUMNS}
    out, keys = [], set()
    for c in columns:
        if c.get("kind") == "detail" or str(c.get("key") or "").startswith("@"):
            field = str(c.get("field") or str(c.get("key") or "")[1:])
            if field not in DETAIL_FIELDS:
                raise ValueError(f"Unknown paper detail {field!r}")
            if f"@{field}" not in keys:
                keys.add(f"@{field}")
                out.append(detail_column(field))
            continue
        label = str(c.get("label") or "").strip()[:60]
        if not label:
            raise ValueError("Every column needs a name")
        key = str(c.get("key") or "").strip().lstrip("@") or _slug(label)
        base, n = key, 2
        while key in keys:
            key, n = f"{base}_{n}", n + 1
        keys.add(key)
        instruction = str(c.get("instruction") or "").strip()[:300]
        query = str(c.get("query") or "").strip()[:200] or (defaults[key]["query"] if key in defaults else "")
        out.append({"key": key, "kind": "question", "label": label, "instruction": instruction, "query": query})
    return out


def _detail_values(row) -> dict:
    """A paper's record as detail columns show it (lists stay lists, numbers numbers)."""
    return {
        "authors": json.loads(row["authors"]), "year": row["year"], "published": row["published"], "venue": row["venue"],
        "volume": row["volume"] + (f"({row['issue']})" if row["issue"] else "") if row["volume"] else
                  (f"({row['issue']})" if row["issue"] else ""),
        "pages": row["page_span"], "publisher": row["publisher"], "doi": row["doi"], "cited_by_count": row["cited_by_count"],
        "abstract": row["abstract"], "keywords": json.loads(row["keywords"]), "jel_codes": json.loads(row["jel_codes"]),
    }


def detail_text(field: str, value) -> str:
    """A detail as text, for exports and for the model."""
    if value is None:
        return ""
    if isinstance(value, list):
        return ("; " if any("," in str(v) for v in value) else ", ").join(str(v) for v in value)
    return str(value)


MAX_TABLE = 60000  # characters of matrix text sent to the model


def _snapshot(m: dict, keys: list[str] | None = None) -> list[dict]:
    """The matrix's rows as plain values, for the model and for keeping with a finding."""
    cols = [c for c in m["columns"] if keys is None or c["key"] in keys]
    out = []
    for r in m["rows"]:
        values = []
        for c in cols:
            if c["kind"] == "detail":
                values.append({"key": c["key"], "label": c["label"], "quote": "",
                               "value": detail_text(c["field"], r["details"][c["field"]])[:600]})
            else:
                cell = r["cells"].get(c["key"]) or {}
                found = cell.get("status") in ("found", "unverified")
                values.append({"key": c["key"], "label": c["label"], "value": cell.get("answer") or "",
                               "quote": (cell.get("quote") or "") if found else ""})
        out.append({"doc_id": r["doc_id"], "label": r["label"], "title": r["title"], "values": values})
    return out


def _table_text(rows: list[dict], quotes: bool = False) -> str:
    """One line per study. With `quotes`, each answer is followed by the quote it rests on."""
    def val(v: dict) -> str:
        text = v["value"] or ("unknown" if v["key"].startswith("@") else "not reported")
        return f'{text} ["{v["quote"][:400]}"]' if quotes and v["quote"] else text
    return "\n".join(f"{r['label']} ({r['title'][:90]}): " + " | ".join(f"{v['label']}: {val(v)}" for v in r["values"])
                     for r in rows)


def union_snapshot(parts: list[tuple[int, str, list[dict]]]) -> list[dict]:
    """Rows of several matrices ((id, name, snapshot) each) as one list, each paper once. With more
    than one matrix, each value's key and label say which matrix it comes from."""
    if len(parts) == 1:
        return parts[0][2]
    out: dict[int, dict] = {}
    for mid, name, rows in parts:
        for r in rows:
            values = [{**v, "key": f"{mid}:{v['key']}", "label": f"{name} · {v['label']}"} for v in r["values"]]
            if r["doc_id"] in out:
                out[r["doc_id"]]["values"].extend(values)
            else:
                out[r["doc_id"]] = {**r, "values": values}
    return list(out.values())


def _content(rows: list[dict]) -> list:
    """What a snapshot says, without names that can change (a paper's label, a column's label)."""
    return [(r["doc_id"], [(v["key"], v["value"], v["quote"]) for v in r["values"]]) for r in rows]


class Matrices:
    def __init__(self, lib, workers: int = WORKERS):
        self.lib = lib
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="matrix")
        self._reading: set[tuple[int, int]] = set()  # (matrix, document) rows queued or being read
        self._mu = threading.Lock()
        self._resume()

    # ---------- storage ----------

    def _matrix(self, mid: int):
        row = self.lib.conn.execute("SELECT * FROM matrices WHERE id = ?", (mid,)).fetchone()
        if not row:
            raise LookupError(f"Matrix {mid} not found")
        return row

    def summaries(self) -> list[dict]:
        with self.lib.lock:
            rows = self.lib.conn.execute(
                "SELECT m.id, m.name, m.columns, m.updated_at, "
                "(SELECT COUNT(*) FROM matrix_rows r WHERE r.matrix_id = m.id) AS papers, "
                "(SELECT COUNT(*) FROM matrix_cells c WHERE c.matrix_id = m.id AND c.status = 'pending') AS pending "
                "FROM matrices m ORDER BY m.updated_at DESC, m.id DESC").fetchall()
        return [{"id": r["id"], "name": r["name"], "columns": len(json.loads(r["columns"])), "papers": r["papers"],
                 "pending": r["pending"], "updated_at": r["updated_at"]} for r in rows]

    def get(self, mid: int) -> dict:
        from .library import short_label

        with self.lib.lock:
            m = self._matrix(mid)
            rows = self.lib.conn.execute(
                "SELECT d.id, d.title, d.authors, d.year, d.kind, d.published, d.venue, d.volume, d.issue, d.page_span, "
                "d.publisher, d.doi, d.cited_by_count, d.abstract, d.keywords, d.jel_codes "
                "FROM matrix_rows r JOIN documents d ON d.id = r.doc_id "
                "WHERE r.matrix_id = ? ORDER BY r.position, d.id", (mid,)).fetchall()
            cells = self.lib.conn.execute(
                'SELECT doc_id, col, status, answer, quote, chunk_id, page, start, "end", label, edited, error '
                "FROM matrix_cells WHERE matrix_id = ?", (mid,)).fetchall()
        by_doc: dict[int, dict] = {}
        for c in cells:
            by_doc.setdefault(c["doc_id"], {})[c["col"]] = {k: c[k] for k in c.keys() if k not in ("doc_id", "col")}
        papers = []
        for r in rows:
            doc = {"title": r["title"], "authors": json.loads(r["authors"]), "year": r["year"]}
            papers.append({"doc_id": r["id"], "title": r["title"], "authors": doc["authors"], "year": r["year"],
                           "kind": r["kind"], "label": short_label(doc), "cells": by_doc.get(r["id"], {}),
                           "details": _detail_values(r)})
        columns = [{"kind": "question", **c} for c in json.loads(m["columns"])]  # matrices from before details
        return {
            "id": m["id"], "name": m["name"], "columns": columns, "rows": papers,
            "gaps": self._gaps_with_ids(m, papers, columns),
            "pending": sum(1 for c in cells if c["status"] == "pending"), "cells": len(cells),
            "updated_at": m["updated_at"],
        }

    def _gaps_with_ids(self, m, papers: list[dict], columns: list[dict]) -> list[dict] | None:
        """The latest gaps, each with the id of its saved finding. Gaps found before findings were
        kept are saved now, with the matrix as it is (the closest there is to what they came from)."""
        gaps = json.loads(m["gaps"]) if m["gaps"] else None
        if not gaps or all("id" in g for g in gaps):
            return gaps
        snap = _snapshot({"columns": columns, "rows": papers})
        with self.lib.lock, self.lib.conn:
            for g in gaps:
                if "id" not in g:
                    g["id"] = self._save_finding(m["id"], m["name"], "gap", g["title"], g["detail"], [], None, snap)
            self.lib.conn.execute("UPDATE matrices SET gaps = ? WHERE id = ?", (json.dumps(gaps), m["id"]))
        return gaps

    def papers_for(self, folder_id: int | None = None, topic: str = "") -> list[dict]:
        """Papers to build a matrix from: a folder's, or those about a topic (best evidence first)."""
        with self.lib.lock:
            if folder_id is not None:
                ids = [r["doc_id"] for r in self.lib.conn.execute(
                    "SELECT doc_id FROM doc_folders WHERE folder_id = ? AND state != 'rejected'", (folder_id,))]
            elif topic.strip():
                found = self.lib._topic_matches(topic)
                ids = sorted(found, key=lambda d: (-len(found[d]["why"]), -found[d]["hits"]))
            else:
                raise ValueError("Choose a folder or type a topic")
            docs = {d["id"]: d for d in self.lib._doc_dicts(self.lib.conn.execute(
                f"SELECT * FROM documents WHERE id IN ({','.join('?' * len(ids))})", ids).fetchall())} if ids else {}
        # Two copies of one paper would be two identical rows: keep the first of each title.
        out, seen = [], set()
        for i in ids:
            d = docs.get(i)
            key = re.sub(r"[^a-z0-9]+", "", (d or {}).get("title", "").lower())
            if d and key not in seen:
                seen.add(key)
                out.append({"id": i, "title": d["title"], "authors": d["authors"], "year": d["year"], "kind": d["kind"]})
        return out

    def create(self, name: str, doc_ids: list[int], columns: list[dict] | None = None) -> dict:
        name = name.strip()[:120]
        if not name:
            raise ValueError("Give the matrix a name")
        doc_ids = list(dict.fromkeys(int(d) for d in doc_ids))
        if not doc_ids:
            raise ValueError("Choose at least one paper")
        if len(doc_ids) > MAX_ROWS:
            raise ValueError(f"At most {MAX_ROWS} papers in one matrix")
        cols = normalize_columns(columns)
        with self.lib.lock, self.lib.conn:
            known = {r["id"] for r in self.lib.conn.execute(
                f"SELECT id FROM documents WHERE id IN ({','.join('?' * len(doc_ids))})", doc_ids)}
            doc_ids = [d for d in doc_ids if d in known]
            if not doc_ids:
                raise ValueError("None of those papers is in the library")
            mid = self.lib.conn.execute("INSERT INTO matrices (name, columns) VALUES (?, ?)",
                                        (name, json.dumps(cols))).lastrowid
            self._add_rows(mid, doc_ids, cols, start=0)
        if questions(cols):
            for d in doc_ids:
                self._queue(mid, d)
        return self.get(mid)

    def _add_rows(self, mid: int, doc_ids: list[int], cols: list[dict], start: int) -> None:
        self.lib.conn.executemany("INSERT OR IGNORE INTO matrix_rows (matrix_id, doc_id, position) VALUES (?, ?, ?)",
                                  [(mid, d, start + i) for i, d in enumerate(doc_ids)])
        self.lib.conn.executemany("INSERT OR IGNORE INTO matrix_cells (matrix_id, doc_id, col) VALUES (?, ?, ?)",
                                  [(mid, d, c["key"]) for d in doc_ids for c in questions(cols)])

    def update(self, mid: int, name: str | None = None, columns: list[dict] | None = None,
               add_doc_ids: list[int] | None = None, remove_doc_ids: list[int] | None = None) -> dict:
        requeue: set[int] = set()
        with self.lib.lock, self.lib.conn:
            m = self._matrix(mid)
            old = {c["key"]: c for c in json.loads(m["columns"])}
            cols = list(old.values())
            if name is not None:
                if not name.strip():
                    raise ValueError("Give the matrix a name")
                self.lib.conn.execute("UPDATE matrices SET name = ? WHERE id = ?", (name.strip()[:120], mid))
            if columns is not None:
                cols = normalize_columns(columns)
                docs = [r["doc_id"] for r in self.lib.conn.execute("SELECT doc_id FROM matrix_rows WHERE matrix_id = ?", (mid,))]
                keys = {c["key"] for c in cols}
                gone = [k for k in old if k not in keys]
                if gone:
                    self.lib.conn.execute(f"DELETE FROM matrix_cells WHERE matrix_id = ? AND col IN ({','.join('?' * len(gone))})",
                                          [mid, *gone])
                for c in questions(cols):
                    before = old.get(c["key"])
                    if before is None:  # a new column: read it for every paper
                        self.lib.conn.executemany("INSERT OR IGNORE INTO matrix_cells (matrix_id, doc_id, col) VALUES (?, ?, ?)",
                                                  [(mid, d, c["key"]) for d in docs])
                        requeue.update(docs)
                    elif (before.get("instruction"), before.get("query")) != (c["instruction"], c["query"]):
                        # The question changed: read it again, except where the user wrote the answer.
                        self.lib.conn.execute("UPDATE matrix_cells SET status = 'pending' WHERE matrix_id = ? AND col = ? AND edited = 0",
                                              (mid, c["key"]))
                        requeue.update(docs)
                self.lib.conn.execute("UPDATE matrices SET columns = ? WHERE id = ?", (json.dumps(cols), mid))
            if remove_doc_ids:
                for d in remove_doc_ids:
                    self.lib.conn.execute("DELETE FROM matrix_rows WHERE matrix_id = ? AND doc_id = ?", (mid, d))
                    self.lib.conn.execute("DELETE FROM matrix_cells WHERE matrix_id = ? AND doc_id = ?", (mid, d))
            if add_doc_ids:
                have = self.lib.conn.execute("SELECT COUNT(*), COALESCE(MAX(position), -1) FROM matrix_rows WHERE matrix_id = ?",
                                             (mid,)).fetchone()
                known = {r["id"] for r in self.lib.conn.execute(
                    f"SELECT id FROM documents WHERE id IN ({','.join('?' * len(add_doc_ids))})", add_doc_ids)}
                new = [d for d in dict.fromkeys(add_doc_ids) if d in known]
                if have[0] + len(new) > MAX_ROWS:
                    raise ValueError(f"At most {MAX_ROWS} papers in one matrix")
                self._add_rows(mid, new, cols, start=have[1] + 1)
                if questions(cols):
                    requeue.update(new)
            self._touch(mid)
        for d in requeue:
            self._queue(mid, d)
        return self.get(mid)

    def delete(self, mid: int) -> None:
        with self.lib.lock, self.lib.conn:
            if not self.lib.conn.execute("DELETE FROM matrices WHERE id = ?", (mid,)).rowcount:
                raise LookupError(f"Matrix {mid} not found")

    def set_cell(self, mid: int, doc_id: int, col: str, answer: str) -> dict:
        """The user's own answer. The quote stays as the evidence it had; an empty answer means not reported."""
        answer = answer.strip()[:2000]
        with self.lib.lock, self.lib.conn:
            self._matrix(mid)
            n = self.lib.conn.execute(
                "UPDATE matrix_cells SET answer = ?, edited = 1, error = '', updated_at = CURRENT_TIMESTAMP, "
                "status = CASE WHEN ? = '' THEN 'not_reported' WHEN status IN ('pending', 'error', 'not_reported') "
                "THEN 'unverified' ELSE status END WHERE matrix_id = ? AND doc_id = ? AND col = ?",
                (answer, answer, mid, doc_id, col)).rowcount
            if not n:
                raise LookupError("No such cell")
            self._touch(mid)
        return self.get(mid)

    def rerun(self, mid: int, doc_id: int | None = None, col: str | None = None) -> dict:
        """Read cells again: one, a paper's row, a column, or the whole matrix. The user's own answers too."""
        where, args = ["matrix_id = ?"], [mid]
        if doc_id is not None:
            where.append("doc_id = ?")
            args.append(doc_id)
        if col is not None:
            where.append("col = ?")
            args.append(col)
        with self.lib.lock, self.lib.conn:
            self._matrix(mid)
            self.lib.conn.execute(f"UPDATE matrix_cells SET status = 'pending', edited = 0, error = '' WHERE {' AND '.join(where)}", args)
            docs = [r["doc_id"] for r in self.lib.conn.execute(
                f"SELECT DISTINCT doc_id FROM matrix_cells WHERE {' AND '.join(where)}", args)]
        for d in docs:
            self._queue(mid, d)
        return self.get(mid)

    def _touch(self, mid: int) -> None:
        self.lib.conn.execute("UPDATE matrices SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (mid,))

    # ---------- reading papers ----------

    def _resume(self) -> None:
        with self.lib.lock:
            rows = self.lib.conn.execute(
                "SELECT DISTINCT matrix_id, doc_id FROM matrix_cells WHERE status = 'pending'").fetchall()
        for r in rows:
            self._queue(r["matrix_id"], r["doc_id"])

    def _queue(self, mid: int, doc_id: int) -> None:
        with self._mu:
            if (mid, doc_id) in self._reading:
                return
            self._reading.add((mid, doc_id))
        self.pool.submit(self._read_row_safely, mid, doc_id)

    def _read_row_safely(self, mid: int, doc_id: int) -> None:
        try:
            while self._read_row(mid, doc_id):  # cells set pending while it was reading
                pass
        except Exception as exc:
            log.exception("Matrix %s: reading document %s failed", mid, doc_id)
            with self.lib.lock, self.lib.conn:
                self.lib.conn.execute(
                    "UPDATE matrix_cells SET status = 'error', error = ? WHERE matrix_id = ? AND doc_id = ? AND status = 'pending'",
                    (str(exc)[:300], mid, doc_id))
        finally:
            with self._mu:
                self._reading.discard((mid, doc_id))

    def _read_row(self, mid: int, doc_id: int) -> bool:
        """Fill a paper's pending cells. True when more became pending meanwhile (read again)."""
        with self.lib.lock:
            m = self.lib.conn.execute("SELECT columns FROM matrices WHERE id = ?", (mid,)).fetchone()
            if not m:
                return False
            pending = {r["col"] for r in self.lib.conn.execute(
                "SELECT col FROM matrix_cells WHERE matrix_id = ? AND doc_id = ? AND status = 'pending'", (mid, doc_id))}
            doc = self.lib.conn.execute("SELECT title FROM documents WHERE id = ?", (doc_id,)).fetchone()
            first = self.lib.conn.execute("SELECT id FROM chunks WHERE doc_id = ? ORDER BY page, start LIMIT 1",
                                          (doc_id,)).fetchone()
        cols = [c for c in json.loads(m["columns"]) if c["key"] in pending]
        if not cols or not doc:
            return False
        passages = self._passages(doc_id, cols, first["id"] if first else None)
        if not passages:
            self._write(mid, doc_id, {c["key"]: {"status": "not_reported"} for c in cols})
            return False
        by_pid = {p.pid: p for p in passages}
        answers = {}
        for item in self.lib.provider.extract_matrix_row(doc["title"], cols, passages):
            key = str(item.get("column") or "").strip()
            match = next((c["key"] for c in cols if key.lower() in (c["key"].lower(), c["label"].lower())), None)
            if match and match not in answers:
                answers[match] = item
        found = {}
        for c in cols:
            item = answers.get(c["key"]) or {}
            answer, quote = str(item.get("answer") or "").strip(), str(item.get("quote") or "").strip()
            if not answer or answer.lower().rstrip(".") in ("not reported", "n/a", "none", "not stated"):
                found[c["key"]] = {"status": "not_reported"}
                continue
            p = by_pid.get(str(item.get("passage") or "").strip("[] "))
            if not p or not quote:
                found[c["key"]] = {"status": "unverified", "answer": answer, "quote": quote}
                continue
            v = self.lib.verify_citation(answer, p.chunk_id, quote, judge=False)
            found[c["key"]] = {
                "status": "found" if v["start"] is not None else "unverified", "answer": answer, "quote": quote,
                "chunk_id": p.chunk_id, "page": v["page"], "start": v["start"], "end": v["end"], "label": v["label"],
            }
        return self._write(mid, doc_id, found)

    def _passages(self, doc_id: int, cols: list[dict], first_chunk: int | None) -> list[Passage]:
        """The paper's passages that best answer these columns, and its opening (abstracts say most)."""
        chunk_ids: list[int] = [first_chunk] if first_chunk else []
        for c in cols:
            q = " ".join(x for x in (c.get("query"), c["label"], c.get("instruction")) if x)
            for h in self.lib.search(q, k=PASSAGES_PER_COLUMN, doc_ids=[doc_id]):
                if h["id"] not in chunk_ids:
                    chunk_ids.append(h["id"])
        chunk_ids = chunk_ids[:MAX_PASSAGES]
        if not chunk_ids:
            return []
        hits = [self.lib._hit(cid, 0.0) for cid in chunk_ids]
        return [Passage(f"P{i + 1}", h["id"], h["label"], h["text"]) for i, h in enumerate(h for h in hits if h)]

    def _write(self, mid: int, doc_id: int, found: dict[str, dict]) -> bool:
        with self.lib.lock, self.lib.conn:
            for key, f in found.items():
                # Only cells still waiting: one the user edited meanwhile keeps their answer.
                self.lib.conn.execute(
                    'UPDATE matrix_cells SET status = ?, answer = ?, quote = ?, chunk_id = ?, page = ?, start = ?, "end" = ?, '
                    "label = ?, error = '', updated_at = CURRENT_TIMESTAMP "
                    "WHERE matrix_id = ? AND doc_id = ? AND col = ? AND status = 'pending'",
                    (f["status"], f.get("answer", ""), f.get("quote", ""), f.get("chunk_id"), f.get("page"),
                     f.get("start"), f.get("end"), f.get("label", ""), mid, doc_id, key))
            self._touch(mid)
            left = self.lib.conn.execute(
                "SELECT COUNT(*) FROM matrix_cells WHERE matrix_id = ? AND doc_id = ? AND status = 'pending'",
                (mid, doc_id)).fetchone()[0]
        return bool(left) and set(found) != set()  # something new was asked for while this row was read

    # ---------- what the matrix shows ----------

    def gaps(self, mid: int) -> dict:
        """Ask the model what the studies leave out or disagree on, from the table itself."""
        m = self.get(mid)
        if m["pending"]:
            raise ValueError("Wait for the matrix to finish reading its papers")
        snap = _snapshot(m)
        gaps = self.lib.provider.find_gaps(m["name"], _table_text(snap))
        gaps = [{"title": str(g.get("title", "")).strip(), "detail": str(g.get("detail", "")).strip()} for g in gaps][:6]
        with self.lib.lock, self.lib.conn:
            for g in gaps:  # each kept, so it can go into a draft and be checked against this matrix later
                g["id"] = self._save_finding(mid, m["name"], "gap", g["title"], g["detail"], [], None, snap)
            self.lib.conn.execute("UPDATE matrices SET gaps = ? WHERE id = ?", (json.dumps(gaps), mid))
        return self.get(mid)

    def synthesis(self, mid: int, instruction: str = "", columns: list[str] | None = None) -> dict:
        """Sentences comparing the studies, written from the matrix's quotes and citing them."""
        m = self.get(mid)
        keep = set(columns) if columns else {c["key"] for c in m["columns"]}
        labels = {c["key"]: c["label"] for c in questions(m["columns"])}
        # The papers' details (year, journal, citations…) go in as background: there's no quote to cite for them.
        shown = [c for c in details(m["columns"]) if c["key"] in keep and c["field"] != "abstract"]
        context = "\n".join(
            f"{r['label']}: " + "; ".join(f"{c['label']}: {detail_text(c['field'], r['details'][c['field']])}"
                                          for c in shown if detail_text(c["field"], r["details"][c["field"]]))
            for r in m["rows"]) if shown else ""
        passages = []
        for r in m["rows"]:
            for key in labels:
                cell = r["cells"].get(key) or {}
                if key in keep and cell.get("status") == "found" and cell.get("chunk_id"):
                    passages.append(Passage(f"P{len(passages) + 1}", cell["chunk_id"], f"{r['label']}, {labels[key]}",
                                            cell["quote"]))
        if not passages:
            raise ValueError("The matrix has no verified quotes to write from yet")
        task = (instruction or DEFAULT_SYNTHESIS).strip()
        if context.strip():  # background for the comparison, in the task: the draft's context is text already written
            task += f"\n\nAbout the studies, from their records (use them, but cite only the passages):\n{context}"
        result = self.lib.draft_from(task, "", passages[:80])
        result["finding"] = None
        if result["sentences"]:  # kept, so its sentences can be checked against the matrix once in a draft
            keys = [c["key"] for c in m["columns"] if c["key"] in keep]
            with self.lib.lock, self.lib.conn:
                result["finding"] = self._save_finding(
                    mid, m["name"], "synthesis", instruction.strip(), " ".join(s["text"] for s in result["sentences"]),
                    result["sentences"], keys, _snapshot(m, keys))
        return result

    # ---------- findings: gaps and passages kept for the draft ----------

    def _save_finding(self, mid: int, name: str, kind: str, title: str, text: str, sentences: list,
                      keys: list[str] | None, snap: list[dict], matrix_ids: list[int] | None = None) -> int:
        """Call holding the library lock, in a transaction. The same gap or passage, from the same
        rows, is kept once: running Find gaps again on an unchanged matrix adds nothing."""
        cols = keys if keys is not None else [v["key"] for v in (snap[0]["values"] if snap else [])]
        same = self.lib.conn.execute(
            "SELECT id FROM matrix_findings WHERE matrix_id = ? AND kind = ? AND title = ? AND text = ? AND snapshot = ?",
            (mid, kind, title, text, json.dumps(snap))).fetchone()
        if same:
            return same["id"]
        return self.lib.conn.execute(
            "INSERT INTO matrix_findings (matrix_id, matrix_name, kind, title, text, sentences, columns, snapshot, "
            "matrix_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (mid, name, kind, title, text, json.dumps(sentences), json.dumps(cols), json.dumps(snap),
             json.dumps(matrix_ids or [mid]))).lastrowid

    def _finding_row(self, fid: int):
        with self.lib.lock:
            row = self.lib.conn.execute("SELECT * FROM matrix_findings WHERE id = ?", (fid,)).fetchone()
        if not row:
            raise LookupError("This finding was deleted")
        return row

    def _ids(self, row) -> list[int]:
        ids = json.loads(row["matrix_ids"] or "[]")
        return ids if row["kind"] == "proposal" else [row["matrix_id"]]

    def _current(self, row) -> list[dict] | None:
        """The finding's columns of its matrix (a proposal's matrices) as it is now; None once a
        matrix it came from was deleted."""
        ids = self._ids(row)
        if not ids or None in ids:
            return None
        try:
            if row["kind"] == "proposal":
                return union_snapshot([(m["id"], m["name"], _snapshot(m)) for m in (self.get(i) for i in ids)])
            return _snapshot(self.get(ids[0]), json.loads(row["columns"]))
        except LookupError:
            return None

    def _names(self, row) -> str:
        """The finding's matrix name (names, for a proposal) as it is now, or as kept."""
        try:
            return ", ".join(self._matrix(i)["name"] for i in self._ids(row))
        except (LookupError, TypeError):
            return row["matrix_name"]

    def _summary(self, row, current: list[dict] | None, matrix_name: str | None = None) -> dict:
        snap = json.loads(row["snapshot"])
        return {
            "id": row["id"], "kind": row["kind"], "matrix_id": row["matrix_id"],
            "matrix_name": matrix_name or row["matrix_name"], "title": row["title"], "text": row["text"],
            "created_at": row["created_at"], "papers": len(snap),
            "matrix_changed": current is not None and _content(current) != _content(snap),
        }

    def findings(self, mid: int) -> list[dict]:
        """A matrix's kept gaps and passages, newest first."""
        m = self.get(mid)
        with self.lib.lock:
            rows = self.lib.conn.execute(  # proposals live in their drafts
                "SELECT * FROM matrix_findings WHERE matrix_id = ? AND kind != 'proposal' ORDER BY id DESC",
                (mid,)).fetchall()
        out = []
        for row in rows:
            current = _snapshot(m, json.loads(row["columns"]))
            out.append(self._summary(row, current, m["name"]))
        return out

    def finding(self, fid: int) -> dict:
        """One finding with what it rests on: the matrix rows as they were, and its sentences."""
        row = self._finding_row(fid)
        current = self._current(row)
        return {**self._summary(row, current, self._names(row) if current is not None else None),
                "matrix_exists": current is not None, "matrix_ids": [i for i in self._ids(row) if i is not None],
                "sentences": json.loads(row["sentences"]), "snapshot": json.loads(row["snapshot"])}

    def delete_finding(self, fid: int) -> None:
        with self.lib.lock, self.lib.conn:
            if not self.lib.conn.execute("DELETE FROM matrix_findings WHERE id = ?", (fid,)).rowcount:
                raise LookupError("This finding was already deleted")

    def check_finding(self, fid: int, claim: str) -> dict:
        """Is a sentence written from a finding (a gap, or a passage written from the matrix) backed
        by the matrix? Checked against the matrix as it is now, or, once the matrix is deleted or
        while it is being read again, against the copy kept with the finding."""
        claim = " ".join(claim.split())
        if not claim:
            raise ValueError("There's no sentence to check")
        row = self._finding_row(fid)
        current = self._current(row)
        rows, against = json.loads(row["snapshot"]), "saved"
        if current is not None and not any(self.get(i)["pending"] for i in self._ids(row)):
            rows, against = current, "matrix"
        table = _table_text(rows, quotes=True)
        if len(table) > MAX_TABLE:  # a large matrix: its answers, without the quotes behind them
            table = _table_text(rows)
        name = self._names(row) if current is not None else row["matrix_name"]
        verdict = self.lib.provider.judge_against_matrix(claim, name, table)
        return {"status": VERDICT_STATUS[verdict["verdict"]], "reason": str(verdict.get("reason", "")).strip(),
                "against": against,
                "matrix_changed": current is not None and _content(current) != _content(json.loads(row["snapshot"]))}

    def table_doc(self, mid: int, columns: list[str] | None = None, heading: bool = False) -> dict:
        """The matrix as editor content: a table whose cells cite their quotes (citation chips),
        for the draft and for Word export."""
        m = self.get(mid)
        cols = [c for c in m["columns"] if not columns or c["key"] in columns]

        def para(*content):
            return {"type": "paragraph", "content": [n for n in content if n]}

        def text(t):
            return {"type": "text", "text": t} if t else None

        header = {"type": "tableRow", "content": [
            {"type": "tableHeader", "content": [para(text(label))]} for label in ["Study", *[c["label"] for c in cols]]]}
        rows = [header]
        for r in m["rows"]:
            cells = [{"type": "tableCell", "content": [para(text(r["label"] or r["title"][:60]))]}]
            for c in cols:
                if c["kind"] == "detail":
                    cells.append({"type": "tableCell", "content": [para(text(detail_text(c["field"], r["details"][c["field"]])))]})
                    continue
                cell = r["cells"].get(c["key"]) or {}
                if cell.get("status") == "not_reported":
                    content = para(text("Not reported"))
                elif cell.get("answer"):
                    chip = None
                    if cell.get("chunk_id"):
                        found = cell["status"] == "found"
                        chip = {"type": "citation", "attrs": {
                            "cid": f"m{mid}-{r['doc_id']}-{c['key']}", "chunkId": cell["chunk_id"], "docId": r["doc_id"],
                            "page": cell["page"] or 1, "start": cell["start"], "end": cell["end"], "quote": cell["quote"],
                            "claim": cell["answer"], "label": cell["label"],
                            "status": "pending" if found else "quote_not_found",
                            "reason": "" if found else "The quote wasn't found in the paper.",
                        }}
                    content = para(text(cell["answer"] + (" " if chip else "")), chip)
                else:
                    content = para()
                cells.append({"type": "tableCell", "content": [content]})
            rows.append({"type": "tableRow", "content": cells})
        blocks = [{"type": "table", "content": rows}]
        if heading:
            blocks.insert(0, {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": m["name"]}]})
        return {"type": "doc", "content": blocks}

    # ---------- export ----------

    def _flat(self, mid: int) -> tuple[list[str], list[list[str]]]:
        """Header and rows for a spreadsheet: each column's answer, then its evidence (page and quote)."""
        m = self.get(mid)
        header = ["Study", "Title", "Year"]
        cols = [c for c in m["columns"] if not (c["kind"] == "detail" and c["field"] == "year")]  # Year is already there
        for c in cols:
            header += [c["label"]] if c["kind"] == "detail" else [c["label"], f"{c['label']}: evidence"]
        rows = []
        for r in m["rows"]:
            line = [r["label"], r["title"], str(r["year"] or "")]
            for c in cols:
                if c["kind"] == "detail":
                    line.append(detail_text(c["field"], r["details"][c["field"]]))
                    continue
                cell = r["cells"].get(c["key"]) or {}
                status = cell.get("status")
                answer = "Not reported" if status == "not_reported" else cell.get("answer") or ""
                where = cell.get("label", "").split(", ")[-1] if cell.get("label") else ""
                evidence = f"{where}: “{cell['quote']}”" if cell.get("quote") else ""
                if status == "unverified" and evidence:
                    evidence += " (quote not found in the paper)"
                line += [answer, evidence]
            rows.append(line)
        return header, rows

    def export(self, mid: int, fmt: str, style: str = "apa") -> tuple[bytes, str, str]:
        """(file bytes, media type, file extension)."""
        m = self.get(mid)
        if fmt == "csv":
            header, rows = self._flat(mid)
            out = io.StringIO()
            csv.writer(out).writerows([header, *rows])
            return ("﻿" + out.getvalue()).encode("utf-8"), "text/csv", "csv"  # BOM: Excel reads it as UTF-8
        if fmt == "xlsx":
            from openpyxl import Workbook
            from openpyxl.styles import Alignment, Font, PatternFill

            header, rows = self._flat(mid)
            wb = Workbook()
            ws = wb.active
            ws.title = re.sub(r"[\[\]:*?/\\]", " ", m["name"])[:31] or "Matrix"
            ws.append(header)
            for line in rows:
                ws.append(line)
            for cell in ws[1]:
                cell.font = Font(bold=True)
                cell.fill = PatternFill("solid", fgColor="E4EAE2")
            for col in ws.iter_cols(min_row=1):
                letter = col[0].column_letter
                is_evidence = str(col[0].value).endswith(": evidence")
                ws.column_dimensions[letter].width = 20 if letter in "AC" else 45 if is_evidence else 32
                for cell in col:
                    cell.alignment = Alignment(wrap_text=True, vertical="top")
                    if is_evidence and cell.row > 1:
                        cell.font = Font(italic=True, color="56665B")
            ws.freeze_panes = "B2"
            out = io.BytesIO()
            wb.save(out)
            return out.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"
        if fmt == "docx":
            data = export_docx(self.lib, self.table_doc(mid, heading=True), style, m["name"], flag_pending=False,
                               landscape=len(m["columns"]) > 3)
            return data, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"
        raise ValueError("format must be csv, xlsx or docx")
