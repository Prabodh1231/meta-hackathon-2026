"""Highlights and sticky notes made while reading a paper in the app, and fetching them while writing.

A highlight is text the reader selected on one page of a PDF, kept word for word with the page it
is on and, when it can be found in the page's stored text, its offsets there, which make it a
citation like any other: the chunk is looked up when it's cited, so a paper added again (new chunk
ids) keeps its highlights. A note is the reader's own idea about it, never treated as a source.

Fetch ranks every highlight and note by how close its words are to the paragraph being written:
BM25-style keyword scoring over the highlight's text and the reader's note, on this computer,
with no model. Writing from highlights is the one step that asks Muse: the highlighted
passages become the passages a draft is written and cited from.
"""

import math
from collections import Counter

from .citations import locate_quote
from .library import short_label
from .providers import Passage
from .text_utils import tokenize

MAX_TEXT = 4000  # characters of one highlight; a selection longer than that is a few pages
MAX_NOTE = 2000
VERIFIED = "Your highlight, quoted word for word from the page."


def keyword_scores(context: str, texts: list[str]) -> list[float]:
    """BM25-style scores of each text for the paragraph being written: rare words of the
    paragraph count most, and a word repeated in one highlight counts with diminishing
    returns, so a long note can't win by saying the word over and over."""
    query = list(dict.fromkeys(tokenize(context)))
    if not query or not texts:
        return [0.0] * len(texts)
    docs = [Counter(tokenize(t)) for t in texts]
    lengths = [sum(d.values()) for d in docs]
    average = sum(lengths) / len(lengths) or 1.0
    df = {w: sum(w in d for d in docs) for w in query}
    scores = []
    for counts, length in zip(docs, lengths):
        score = 0.0
        for word in query:
            tf = counts.get(word, 0)
            if not tf:
                continue
            idf = math.log(1 + (len(docs) - df[word] + 0.5) / (df[word] + 0.5))
            score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * length / average))
        scores.append(round(score, 4))
    return scores


class Highlights:
    def __init__(self, lib):
        self.lib = lib

    def _row(self, r) -> dict:
        return {"id": r["id"], "doc_id": r["doc_id"], "page": r["page"], "text": r["text"], "note": r["note"],
                "start": r["start"], "end": r["end"], "created_at": r["created_at"], "updated_at": r["updated_at"]}

    def _get(self, hid: int) -> dict:
        with self.lib.lock:
            r = self.lib.conn.execute("SELECT * FROM highlights WHERE id = ?", (hid,)).fetchone()
        if not r:
            raise LookupError(f"Highlight {hid} not found")
        return self._row(r)

    def for_document(self, doc_id: int) -> list[dict]:
        self.lib.get_document(doc_id)
        with self.lib.lock:
            rows = self.lib.conn.execute("SELECT * FROM highlights WHERE doc_id = ? ORDER BY page, start, id", (doc_id,)).fetchall()
        return [self._row(r) for r in rows]

    def create(self, doc_id: int, page: int, text: str, note: str = "") -> dict:
        text, note = " ".join(text.split()), note.strip()
        if not text:
            raise ValueError("Select some text to highlight")
        if len(text) > MAX_TEXT:
            raise ValueError("That selection is too long to highlight; select a passage on one page")
        if len(note) > MAX_NOTE:
            raise ValueError(f"A note can be up to {MAX_NOTE} characters")
        self.lib.get_document(doc_id)
        with self.lib.lock, self.lib.conn:
            row = self.lib.conn.execute("SELECT text FROM pages WHERE doc_id = ? AND page = ?", (doc_id, page)).fetchone()
            if not row:
                raise LookupError(f"Page {page} not found")
            # pdf.js and the stored text differ in spacing and ligatures; locate_quote allows for that.
            loc = locate_quote(text, row["text"])
            hid = self.lib.conn.execute(
                'INSERT INTO highlights (doc_id, page, text, note, start, "end") VALUES (?, ?, ?, ?, ?, ?)',
                (doc_id, page, text, note, loc[0] if loc else None, loc[1] if loc else None),
            ).lastrowid
        return self._get(hid)

    def update(self, hid: int, note: str) -> dict:
        note = note.strip()
        if len(note) > MAX_NOTE:
            raise ValueError(f"A note can be up to {MAX_NOTE} characters")
        with self.lib.lock, self.lib.conn:
            if not self.lib.conn.execute(
                    "UPDATE highlights SET note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (note, hid)).rowcount:
                raise LookupError(f"Highlight {hid} not found")
        return self._get(hid)

    def delete(self, hid: int) -> None:
        with self.lib.lock, self.lib.conn:
            if not self.lib.conn.execute("DELETE FROM highlights WHERE id = ?", (hid,)).rowcount:
                raise LookupError(f"Highlight {hid} not found")

    def citation(self, h: dict) -> dict | None:
        """The highlight as a citation chip's data, or None when it isn't in the page's stored text."""
        if h["start"] is None:
            return None
        with self.lib.lock:
            ch = self.lib.conn.execute(
                'SELECT id FROM chunks WHERE doc_id = ? AND page = ? AND start <= ? ORDER BY start DESC LIMIT 1',
                (h["doc_id"], h["page"], h["start"])).fetchone()
            page_text = self.lib.conn.execute(
                "SELECT text FROM pages WHERE doc_id = ? AND page = ?", (h["doc_id"], h["page"])).fetchone()
        if not ch or not page_text:
            return None
        quote = page_text["text"][h["start"]:h["end"]]
        c = self.lib.verify_citation(quote, ch["id"], quote, judge=False)
        if c["start"] is None:
            return None
        # The sentence inserted is the quote itself, so it is backed by definition.
        return {**c, "status": "verified", "reason": VERIFIED}

    def fetch(self, context: str = "", limit: int = 20) -> list[dict]:
        """Highlights and notes for what is being written: closest to `context` first, or the
        newest first without one. Each comes with its paper's label and, when it can be cited,
        its citation."""
        with self.lib.lock:
            rows = [self._row(r) for r in self.lib.conn.execute("SELECT * FROM highlights ORDER BY id DESC")]
        if not rows:
            return []
        context = " ".join(context.split())[-2000:]
        scores = [None] * len(rows)
        if context:
            # The reader's note counts too: it says why the passage was kept, in their words.
            scores = keyword_scores(context, [(h["text"] + "\n" + h["note"]).strip() for h in rows])
            order = sorted(range(len(rows)), key=lambda i: -scores[i])
            rows, scores = [rows[i] for i in order], [scores[i] for i in order]
        out = []
        docs: dict[int, dict] = {}
        for h, score in list(zip(rows, scores))[:limit]:
            doc = docs.get(h["doc_id"]) or docs.setdefault(h["doc_id"], self.lib.get_document(h["doc_id"]))
            cite = self.citation(h)
            out.append({**h, "score": score, "doc_title": doc["title"],
                        "label": cite["label"] if cite else short_label(doc, page=h["page"]), "citation": cite})
        return out

    def write(self, ids: list[int], context: str = "", instruction: str = "") -> dict:
        """Sentences for the draft written by Muse from these highlights (their notes guide it), each
        citing the highlight it rests on. Checked like the Assistant's: the app verifies each one."""
        picked = [self._get(i) for i in dict.fromkeys(ids)]
        passages, notes = [], []
        for h in picked:
            cite = self.citation(h)
            if not cite:
                continue
            pid = f"P{len(passages) + 1}"
            passages.append(Passage(pid, cite["chunk_id"], cite["label"], cite["quote"]))
            if h["note"]:
                notes.append(f"- On [{pid}]: {h['note']}")
        if not passages:
            raise ValueError("None of these highlights could be found in the paper's text, so they can't be cited")
        task = instruction.strip() or ("Write a few sentences for my draft from these passages I highlighted, "
                                       "following on from what I have written so far.")
        if notes:
            task += "\nMy notes while reading (my own ideas, not sources):\n" + "\n".join(notes)
        return self.lib.draft_from(task, context, passages)

