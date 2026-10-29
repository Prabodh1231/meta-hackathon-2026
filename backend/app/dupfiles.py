"""Finding duplicate files in the library, to recommend cleanup. Nothing here deletes anything.

Four kinds of match, from strongest to weakest evidence:
- exact_file: the files' SHA-256 hashes match, so they are byte-for-byte identical.
- same_text: the files differ, but their extracted text is identical once harmless formatting
  (spacing, line breaks, hyphenation, quote styles, letter case) is normalized. Layout, images,
  annotations and embedded metadata may still differ, so this never claims the files are identical.
- likely_same: the same paper in different files, e.g. a preprint and the published version:
  same DOI, or matching title and authors, or nearly all of one text inside the other.
- similar: related papers worth a look (shared passages, near-identical titles) whose metadata
  says they are different papers.

A paper filed in several virtual folders is one document pointing at one file, so it is never
compared with itself: each library document is considered once.
"""

import hashlib
import re
import unicodedata
from difflib import SequenceMatcher

from .refparse import norm as norm_title

SHINGLE = 5  # words per n-gram when measuring how much text two documents share
MIN_TEXT_CHARS = 200  # shorter texts (a scan with no OCR, an empty page) can't be compared by text

TITLE_MATCH = 0.9  # titles this alike (and at least MIN_TITLE_WORDS long) name the same paper
MIN_TITLE_WORDS = 3
TITLE_SIMILAR = 0.8
TEXT_SAME = 0.8  # share of the shorter text found in the other: the same paper, another version
TEXT_SIMILAR = 0.3  # shares whole passages: worth a look

KINDS = {
    "exact_file": "Exact file duplicate",
    "same_text": "Same text detected",
    "likely_same": "Likely same paper/version",
    "similar": "Similar paper",
}

EXPLAIN = {
    "exact_file": "These files are byte-for-byte identical (their SHA-256 hashes match). Keeping one loses nothing.",
    "same_text": "These files appear to contain identical text, ignoring spacing, line breaks, hyphenation, quote "
                 "styles and letter case. The files themselves differ, so layout, images, annotations or embedded "
                 "metadata may not be the same. Check before removing one.",
    "likely_same": "Probably the same paper in different files, such as a preprint and the published version, or "
                   "two exports. The text is not identical, so compare them before removing one.",
    "similar": "Related papers that share text or a near-identical title, but the details suggest they are "
               "different papers. Usually you keep both.",
}

_QUOTES = str.maketrans({
    "‘": "'", "’": "'", "‚": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "″": '"',
    "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-",
})  # NFKC already turns non-breaking and other odd spaces into plain ones


def file_sha256(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def normalize_text(text: str) -> str:
    """Text with harmless formatting differences removed: Unicode forms and ligatures, soft
    hyphens, words hyphenated across line breaks, curly quotes and dash variants, letter case
    and all runs of whitespace."""
    t = unicodedata.normalize("NFKC", text).replace("­", "")
    t = re.sub(r"(\w)-[ \t]*\r?\n\s*(\w)", r"\1\2", t)  # "consoli-\ndation" -> "consolidation"
    t = t.translate(_QUOTES)
    return re.sub(r"\s+", " ", t).strip().lower()


def text_sha256(normalized: str) -> str:
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def shingles(normalized: str, n: int = SHINGLE) -> set[int]:
    words = re.findall(r"\w+", normalized)
    if len(words) < n:
        return {hash(tuple(words))} if words else set()
    return {hash(tuple(words[i:i + n])) for i in range(len(words) - n + 1)}


def overlap(a: set, b: set) -> float:
    """Share of the smaller set found in the larger: 1.0 when one text is contained in the other."""
    return len(a & b) / min(len(a), len(b)) if a and b else 0.0


def norm_doi(doi: str) -> str:
    d = (doi or "").strip().lower()
    d = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:\s*)", "", d)
    return d.rstrip(".")


def _surname(author: str) -> str:
    a = norm_title(author)
    if "," in author:  # "Chen, Alice"
        return norm_title(author.split(",")[0])
    return a.split()[-1] if a else ""


def compare_metadata(a: dict, b: dict) -> dict:
    da, db = norm_doi(a.get("doi", "")), norm_doi(b.get("doi", ""))
    ta, tb = norm_title(a.get("title", "")), norm_title(b.get("title", ""))
    sa = {_surname(x) for x in a.get("authors") or []} - {""}
    sb = {_surname(x) for x in b.get("authors") or []} - {""}
    return {
        "same_doi": bool(da) and da == db,
        "doi_conflict": bool(da) and bool(db) and da != db,
        "doi": (da, db),
        "title_sim": SequenceMatcher(None, ta, tb).ratio() if ta and tb else 0.0,
        "title_words": min(len(ta.split()), len(tb.split())),
        "shared_authors": sorted(sa & sb),
        "authors_known": bool(sa) and bool(sb),
        "years": (a.get("year"), b.get("year")),
    }


def classify_pair(meta: dict, text_overlap: float | None) -> tuple[str, list[str]] | None:
    """'likely_same' or 'similar' with the reasons, or None when the pair isn't worth showing.
    `text_overlap` is None when either text is too short to compare."""
    reasons = []
    if meta["same_doi"]:
        reasons.append(f"Same DOI ({meta['doi'][0]})")
    if meta["doi_conflict"]:
        reasons.append(f"Different DOIs ({meta['doi'][0]} and {meta['doi'][1]})")
    title_match = meta["title_sim"] >= TITLE_MATCH and meta["title_words"] >= MIN_TITLE_WORDS
    if title_match:
        reasons.append("Titles match" if meta["title_sim"] > 0.99 else f"Titles {round(100 * meta['title_sim'])}% alike")
    elif meta["title_sim"] >= TITLE_SIMILAR:
        reasons.append(f"Similar titles ({round(100 * meta['title_sim'])}% alike)")
    if meta["shared_authors"]:
        reasons.append("Shared authors: " + ", ".join(a.title() for a in meta["shared_authors"]))
    elif meta["authors_known"]:
        reasons.append("No authors in common")
    ya, yb = meta["years"]
    if ya and yb and ya != yb:
        reasons.append(f"Years differ ({min(ya, yb)} and {max(ya, yb)})")
    if text_overlap is not None and text_overlap >= 0.05:
        reasons.append(f"{round(100 * text_overlap)}% of the shorter text appears in the other")

    authors_ok = bool(meta["shared_authors"]) or not meta["authors_known"]
    text = text_overlap or 0.0
    if not meta["doi_conflict"] and (
        meta["same_doi"] or (title_match and authors_ok) or text >= TEXT_SAME
    ):
        return "likely_same", reasons
    if text >= TEXT_SIMILAR or meta["title_sim"] >= TITLE_SIMILAR:
        return "similar", reasons
    return None


def suggest_keep(docs: list[dict], kind: str) -> tuple[int, str]:
    """Which copy to keep, and why. Prefers, in order: the one the draft cites, one whose file is
    still there, the one you've organised (folders added by hand, corrected details), for a
    different version the published one (has a DOI or venue), and finally the first imported."""
    def score(d):
        return (
            d["cited"],
            d["exists"] or not d["is_file"],
            d["user_folders"] + d["edited"],
            kind in ("likely_same", "similar") and bool(d["doi"] or d["venue"]),
            -d["id"],
        )

    best = max(docs, key=score)
    others = [d for d in docs if d is not best]
    if best["cited"] and not all(d["cited"] for d in others):
        why = "your draft cites it"
    elif (best["exists"] or not best["is_file"]) and any(d["is_file"] and not d["exists"] for d in others):
        why = "the other file is missing"
    elif best["user_folders"] + best["edited"] > max(d["user_folders"] + d["edited"] for d in others):
        why = "you've organised or corrected it"
    elif kind in ("likely_same", "similar") and (best["doi"] or best["venue"]) and not all(d["doi"] or d["venue"] for d in others):
        why = "it looks like the published version"
    else:
        why = "it was imported first"
    return best["id"], why
