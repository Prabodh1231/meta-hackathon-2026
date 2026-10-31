"""Literature review matrices: one row per paper, one column per question (sample, setting,
method, findings, limitations, or the user's own), every cell a short answer resting on a verbatim
quote that has been found in the paper, or marked not reported.

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
MAX_ROWS = 80
MAX_COLUMNS = 12
PASSAGES_PER_COLUMN = 3
MAX_PASSAGES = 16
WORKERS = 8  # rows read at once, as many as files during an import
DEFAULT_SYNTHESIS = ("Compare these studies: where their findings agree and where they differ, and how their "
                     "samples, settings and methods might explain the differences.")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:30] or "column"


def normalize_columns(columns: list[dict] | None) -> list[dict]:
    """Columns as stored: unique keys, a label each, at most MAX_COLUMNS."""
    if columns is None:
        return [dict(c) for c in DEFAULT_COLUMNS]
    if not columns:
        raise ValueError("A matrix needs at least one column")
    if len(columns) > MAX_COLUMNS:
        raise ValueError(f"At most {MAX_COLUMNS} columns")
    defaults = {c["key"]: c for c in DEFAULT_COLUMNS}
    out, keys = [], set()
    for c in columns:
        label = str(c.get("label") or "").strip()[:60]
        if not label:
            raise ValueError("Every column needs a name")
        key = str(c.get("key") or "").strip() or _slug(label)
        base, n = key, 2
        while key in keys:
            key, n = f"{base}_{n}", n + 1
        keys.add(key)
        instruction = str(c.get("instruction") or "").strip()[:300]
        query = str(c.get("query") or "").strip()[:200] or (defaults[key]["query"] if key in defaults else "")
        out.append({"key": key, "label": label, "instruction": instruction, "query": query})
    return out


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
                "SELECT d.id, d.title, d.authors, d.year, d.kind FROM matrix_rows r JOIN documents d ON d.id = r.doc_id "
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
                           "kind": r["kind"], "label": short_label(doc), "cells": by_doc.get(r["id"], {})})
        return {
            "id": m["id"], "name": m["name"], "columns": json.loads(m["columns"]), "rows": papers,
            "gaps": json.loads(m["gaps"]) if m["gaps"] else None,
            "pending": sum(1 for c in cells if c["status"] == "pending"), "cells": len(cells),
            "updated_at": m["updated_at"],
        }

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
        for d in doc_ids:
            self._queue(mid, d)
        return self.get(mid)

    def _add_rows(self, mid: int, doc_ids: list[int], cols: list[dict], start: int) -> None:
        self.lib.conn.executemany("INSERT OR IGNORE INTO matrix_rows (matrix_id, doc_id, position) VALUES (?, ?, ?)",
                                  [(mid, d, start + i) for i, d in enumerate(doc_ids)])
        self.lib.conn.executemany("INSERT OR IGNORE INTO matrix_cells (matrix_id, doc_id, col) VALUES (?, ?, ?)",
                                  [(mid, d, c["key"]) for d in doc_ids for c in cols])

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
                for c in cols:
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
        table = "\n".join(
            f"{r['label']} ({r['title'][:90]}): " + " | ".join(
                f"{c['label']}: {(r['cells'].get(c['key']) or {}).get('answer') or 'not reported'}" for c in m["columns"])
            for r in m["rows"])
        gaps = self.lib.provider.find_gaps(m["name"], table)
        gaps = [{"title": str(g.get("title", "")).strip(), "detail": str(g.get("detail", "")).strip()} for g in gaps][:6]
        with self.lib.lock, self.lib.conn:
            self.lib.conn.execute("UPDATE matrices SET gaps = ? WHERE id = ?", (json.dumps(gaps), mid))
        return self.get(mid)

    def synthesis(self, mid: int, instruction: str = "", columns: list[str] | None = None) -> dict:
        """Sentences comparing the studies, written from the matrix's quotes and citing them."""
        m = self.get(mid)
        keep = set(columns) if columns else {c["key"] for c in m["columns"]}
        labels = {c["key"]: c["label"] for c in m["columns"]}
        passages = []
        for r in m["rows"]:
            for key in labels:
                cell = r["cells"].get(key) or {}
                if key in keep and cell.get("status") == "found" and cell.get("chunk_id"):
                    passages.append(Passage(f"P{len(passages) + 1}", cell["chunk_id"], f"{r['label']}, {labels[key]}",
                                            cell["quote"]))
        if not passages:
            raise ValueError("The matrix has no verified quotes to write from yet")
        return self.lib.draft_from((instruction or DEFAULT_SYNTHESIS).strip(), "", passages[:80])

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
        for c in m["columns"]:
            header += [c["label"], f"{c['label']}: evidence"]
        rows = []
        for r in m["rows"]:
            line = [r["label"], r["title"], str(r["year"] or "")]
            for c in m["columns"]:
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
