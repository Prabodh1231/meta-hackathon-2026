"""Find a model-supplied quote in the source text, tolerating whitespace, case, curly
quotes and small OCR/extraction differences, and return its exact character span."""

from difflib import SequenceMatcher

_CHAR_MAP = {
    "“": '"', "”": '"', "‘": "'", "’": "'",
    "–": "-", "—": "-", "­": "",
    "ﬁ": "fi", "ﬂ": "fl",
}


def _normalize(text: str) -> tuple[str, list[int]]:
    """Lowercase, collapse whitespace and map typographic characters, keeping for every
    output character the index of the input character it came from."""
    out: list[str] = []
    index: list[int] = []
    prev_space = True
    for i, ch in enumerate(text):
        if ch.isspace():
            if not prev_space:
                out.append(" ")
                index.append(i)
                prev_space = True
            continue
        for c in _CHAR_MAP.get(ch, ch).lower():
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
    matched = sum(b.size for b in blocks)
    if not blocks or matched / len(nq) < min_ratio:
        return None
    s, e = blocks[0].a, blocks[-1].a + blocks[-1].size
    if e - s > len(nq) * 1.5:  # pieces scattered across the page, not one passage
        return None
    return idx[s], idx[e - 1] + 1, matched / len(nq)


VERDICT_STATUS = {"supported": "verified", "partial": "weak", "unsupported": "unsupported"}
