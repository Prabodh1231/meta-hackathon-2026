"""Find a model-supplied quote in the source text, tolerating whitespace, case, curly
quotes and small OCR/extraction differences, and return its exact character span.

Tolerance stops at meaning: a near match that drops or adds a "not", changes a number, or
turns "significant" into "insignificant" is not the source's text, however few letters
differ, so it isn't returned as found (see `meaning_change`)."""

import re
import unicodedata
from collections import Counter
from difflib import SequenceMatcher

from .text_utils import densest_run

_CHAR_MAP = {
    "“": '"', "”": '"', "‘": "'", "’": "'",
    "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-", "­": "",
}
# A word hyphenated across a line break in PDF text: "consoli-\ndation" reads as "consolidation".
# Letters only: digits broken there are a range ("2004-\n12"), not one number.
_LINE_HYPHEN = re.compile(r"(?<=[^\W\d_])[-‐­][ \t]*\r?\n\s*(?=[^\W\d_])")
# A range broken across a line break keeps its dash: "2004-\n12" reads as "2004-12".
_RANGE_BREAK = re.compile(r"(?<=\d[-‐–])[ \t]*\r?\n\s*(?=\d)")

# Words that reverse what a sentence says. Words ending in "n't" count too.
_NEGATIONS = frozenset("not no never none neither nor without cannot nothing nobody nowhere non".split())
# Prefixes that make a word its opposite: significant / insignificant, likely / unlikely.
_NEGATING_PREFIXES = ("non", "un", "in", "im", "ir", "il", "dis")
_WORDS = re.compile(r"[a-z]+(?:'[a-z]+)?")
_NUMBERS = re.compile(r"\d+(?:[.,]\d+)*")
# How far a match that starts or ends inside a word is widened to take the whole word.
_WORD_REACH = 24


def _normalize(text: str) -> tuple[str, list[int]]:
    """Lowercase, collapse whitespace, join words hyphenated across line breaks and map
    typographic characters and ligatures, keeping for every output character the index of
    the input character it came from."""
    out: list[str] = []
    index: list[int] = []
    prev_space = True
    breaks = [*_LINE_HYPHEN.finditer(text), *_RANGE_BREAK.finditer(text)]
    joins = iter(sorted((m.start(), m.end()) for m in breaks) + [(len(text) + 1, 0)])
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


def _negations(words: list[str]) -> int:
    return sum(1 for w in words if w in _NEGATIONS or w.endswith("n't"))


def meaning_change(quote: str, source: str) -> str:
    """What a quote changes in the source text it nearly matches, both already normalized:
    "a negation" (a "not" or "never" left out or added), "a number" (one the quote has and
    the source doesn't), "a word's prefix" (significant for insignificant), or "" when it
    changes none of these. A number only the source has (a footnote marker the quote
    leaves out) is no change."""
    quote_words, source_words = _WORDS.findall(quote), _WORDS.findall(source)
    if _negations(quote_words) != _negations(source_words):
        return "a negation"
    if Counter(_NUMBERS.findall(quote)) - Counter(_NUMBERS.findall(source)):
        return "a number"
    ops = SequenceMatcher(None, quote_words, source_words, autojunk=False).get_opcodes()
    for tag, i1, i2, j1, j2 in ops:
        if tag != "replace" or i2 - i1 != j2 - j1:
            continue
        for a, b in zip(quote_words[i1:i2], source_words[j1:j2]):
            longer, shorter = (a, b) if len(a) > len(b) else (b, a)
            if longer.endswith(shorter) and longer[: len(longer) - len(shorter)] in _NEGATING_PREFIXES:
                return "a word's prefix"
    return ""


def _mid_word(text: str, start: int, end: int) -> bool:
    """Whether text[start:end] begins or ends inside a word ("significant" in "insignificant")."""
    return (0 < start < len(text) and text[start].isalnum() and text[start - 1].isalnum()) or (
        0 < end < len(text) and text[end - 1].isalnum() and text[end].isalnum())


def _find_whole(text: str, needle: str) -> int:
    """The first place `needle` occurs in `text` as whole words, or -1."""
    i = text.find(needle)
    while i >= 0 and _mid_word(text, i, i + len(needle)):
        i = text.find(needle, i + 1)
    return i


def _widen(text: str, start: int, end: int) -> tuple[int, int]:
    """A span that starts or ends inside a word, widened to the whole word, so the check in
    `meaning_change` sees "insignificant" and not just its tail. A run of letters longer than
    `_WORD_REACH` is not a word, and the span is left as it was on that side."""
    lo = start
    if 0 < start < len(text) and text[start].isalnum() and text[start - 1].isalnum():
        while lo > 0 and text[lo - 1].isalnum() and start - lo < _WORD_REACH:
            lo -= 1
        if lo > 0 and text[lo - 1].isalnum():
            lo = start
    hi = end
    if 0 < end < len(text) and text[end - 1].isalnum() and text[end].isalnum():
        while hi < len(text) and text[hi].isalnum() and hi - end < _WORD_REACH:
            hi += 1
        if hi < len(text) and text[hi].isalnum():
            hi = end
    return lo, hi


def _negation_before(text: str, start: int) -> int | None:
    """Where a negation ends right before text[start] ("did not | reduce mortality",
    "non-|significant"): the negation's start, or None. A quote that begins there leaves out
    the word that reverses it, though every word it has is the source's."""
    m = _NEGATION_BEFORE.search(text, max(0, start - 40), start)
    if not m:
        return None
    word = m.group(1).lower().replace("’", "'")
    return m.start(1) if word in _NEGATIONS or word.endswith("n't") else None


_NEGATION_BEFORE = re.compile(r"(?<![\w'’])([A-Za-z]+(?:['’][A-Za-z]+)?)(?:\s+|-)$")


def _match(quote: str, text: str, min_ratio: float, fuzzy: bool) -> tuple[int, int, float, str] | None:
    """(start, end, match_ratio, meaning change) of the source text `quote` best matches,
    or None when nothing matches closely enough. The meaning change is "" for a match the
    quote can stand for; otherwise see `meaning_change` and `_negation_before`, and start is
    then where the source's words begin, the negation included."""
    found = _closest(quote, text, min_ratio, fuzzy)
    if found is None or found[3]:
        return found
    start, end, ratio, _ = found
    negation = _negation_before(text, start)
    if negation is not None:
        return negation, end, ratio, "a negation"
    return found


def _closest(quote: str, text: str, min_ratio: float, fuzzy: bool) -> tuple[int, int, float, str] | None:
    """`_match` before looking at the words just before the match."""
    q = quote.strip().strip("\"'“”").strip()
    if not q:
        return None
    i = _find_whole(text, q)
    if i >= 0:
        return i, i + len(q), 1.0, ""

    nt, idx = _normalize(text)
    nq, _ = _normalize(q)
    nq = nq.strip()
    if not nq or not nt:
        return None
    j = _find_whole(nt, nq)
    if j >= 0:
        return idx[j], idx[j + len(nq) - 1] + 1, 1.0, ""
    if not fuzzy:
        return None

    blocks = [b for b in SequenceMatcher(None, nt, nq, autojunk=False).get_matching_blocks() if b.size >= 3]
    # One passage, not pieces scattered across the page: the best-covered stretch no longer
    # than half again the quote.
    blocks = densest_run(blocks, lambda b: b.a, len(nq) * 1.5)
    matched = sum(b.size for b in blocks)
    if not blocks or matched / len(nq) < min_ratio:
        return None
    # The ratio says how much of the quote is in the source, not what the source has that the
    # quote left out, so a dropped "not" still scores 1.0: the words themselves are compared.
    s, e = _widen(nt, blocks[0].a, blocks[-1].a + blocks[-1].size)
    return idx[s], idx[e - 1] + 1, matched / len(nq), meaning_change(nq, nt[s:e])


def locate_quote(
    quote: str, text: str, min_ratio: float = 0.85, fuzzy: bool = True
) -> tuple[int, int, float] | None:
    """Return (start, end, match_ratio) of `quote` within `text`, or None. A near match that
    changes the source's meaning is None too (`quote_conflict` says what it changes).
    `fuzzy=False` skips the slow approximate pass (for scanning many pages)."""
    found = _match(quote, text, min_ratio, fuzzy)
    if found is None or found[3]:
        return None
    return found[:3]


def quote_conflict(quote: str, text: str, min_ratio: float = 0.85) -> tuple[str, int, int] | None:
    """When `quote` nearly matches `text` but changes what it says: (what it changes, start,
    end of the source's words). None when it matches cleanly or not at all."""
    found = _match(quote, text, min_ratio, True)
    if found is None or not found[3]:
        return None
    return found[3], found[0], found[1]


def source_words(text: str, start: int, end: int) -> str:
    """The source's own words at text[start:end], as a citation shows its quote: words
    hyphenated across a line break joined, a range broken there kept whole ("2004-12"), and
    whitespace as single spaces."""
    return " ".join(_RANGE_BREAK.sub("", _LINE_HYPHEN.sub("", text[start:end])).split())


VERDICT_STATUS = {"supported": "verified", "partial": "weak", "unsupported": "unsupported"}
