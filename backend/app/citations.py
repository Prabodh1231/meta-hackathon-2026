"""Find a model-supplied quote in the source text, tolerating whitespace, case, curly
quotes and small OCR/extraction differences, and return its exact character span."""

import re
import unicodedata
from difflib import SequenceMatcher

from .text_utils import densest_run

_CHAR_MAP = {
    "“": '"', "”": '"', "‘": "'", "’": "'",
    "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-", "­": "",
}
# A word hyphenated across a line break in PDF text: "consoli-\ndation" reads as "consolidation".
_LINE_HYPHEN = re.compile(r"(?<=\w)[-‐­][ \t]*\r?\n\s*(?=\w)")


def _normalize(text: str) -> tuple[str, list[int]]:
    """Lowercase, collapse whitespace, join words hyphenated across line breaks and map
    typographic characters and ligatures, keeping for every output character the index of
    the input character it came from."""
    out: list[str] = []
    index: list[int] = []
    prev_space = True
    joins = iter([(m.start(), m.end()) for m in _LINE_HYPHEN.finditer(text)] + [(len(text) + 1, 0)])
    join = next(joins)
    for i, ch in enumerate(text):
        if i >= join[0]:
            if i < join[1]:
                continue
            join = next(joins)
        if ch.isspace():
            if not prev_space:
                out.append(" ")
                index.append(i)
                prev_space = True
            continue
        mapped = _CHAR_MAP.get(ch)
        if mapped is None:
            mapped = unicodedata.normalize("NFKC", ch) if ord(ch) > 127 else ch  # "ﬃ" -> "ffi"
        for c in mapped.lower():
            out.append(c)
            index.append(i)
        prev_space = False
    return "".join(out), index


def locate_quote(
    quote: str, text: str, min_ratio: float = 0.85, fuzzy: bool = True
) -> tuple[int, int, float] | None:
    """Return (start, end, match_ratio) of `quote` within `text`, or None.
    `fuzzy=False` skips the slow approximate pass (for scanning many pages)."""
    q = quote.strip().strip("\"'“”").strip()
    if not q:
        return None
    i = text.find(q)
    if i >= 0:
        return i, i + len(q), 1.0

    nt, idx = _normalize(text)
    nq, _ = _normalize(q)
    nq = nq.strip()
    if not nq or not nt:
        return None
    j = nt.find(nq)
    if j >= 0:
        return idx[j], idx[j + len(nq) - 1] + 1, 1.0
    if not fuzzy:
        return None

    blocks = [b for b in SequenceMatcher(None, nt, nq, autojunk=False).get_matching_blocks() if b.size >= 3]
    # One passage, not pieces scattered across the page: the best-covered stretch no longer
    # than half again the quote.
    blocks = densest_run(blocks, lambda b: b.a, len(nq) * 1.5)
    matched = sum(b.size for b in blocks)
    if not blocks or matched / len(nq) < min_ratio:
        return None
    s, e = blocks[0].a, blocks[-1].a + blocks[-1].size
    return idx[s], idx[e - 1] + 1, matched / len(nq)


VERDICT_STATUS = {"supported": "verified", "partial": "weak", "unsupported": "unsupported"}
