import re
from collections import Counter
from typing import Iterable

STOPWORDS = frozenset(
    """a about above after again against all also am an and any are as at be because been
    before being below between both but by can could did do does doing down during each et
    al few for from further had has have having he her here hers him his how however i if in
    into is it its itself just may me more most must my no nor not now of off on once only or
    other our ours out over own per same she should so some such than that the their theirs
    them then there these they this those through thus to too under until up upon us use used
    using very via was we were what when where which while who whom why will with within
    without would yet you your paper study results result based show shows shown figure table
    section new one two three first second also however therefore approach method methods
    work data model models https http www doi org com""".split()
)

_WORD = re.compile(r"[A-Za-z][A-Za-z\-]{2,}")
# A sentence ends at terminal punctuation followed by whitespace, or at a blank line.
# Single newlines don't end sentences: PDF extraction hard-wraps lines mid-sentence.
_BOUNDARY = re.compile(r"[.!?]+[\"'\)\]]*(?=\s|$)|\n[ \t]*\n")


def tokenize(text: str) -> list[str]:
    words = (m.group().lower().strip("-") for m in _WORD.finditer(text))
    return [w for w in words if len(w) > 2 and w not in STOPWORDS]


def keywords(texts: Iterable[str], n: int = 5) -> list[str]:
    """Most frequent content words, counting each word once per text."""
    counts: Counter[str] = Counter()
    for text in texts:
        counts.update(set(tokenize(text)))
    return [w for w, _ in counts.most_common(n)]


def sentence_spans(text: str) -> list[tuple[int, int]]:
    """(start, end) offsets of sentences, trimmed of surrounding whitespace."""
    spans = []
    start = 0
    for end in [m.end() for m in _BOUNDARY.finditer(text)] + [len(text)]:
        seg = text[start:end]
        if seg.strip():
            spans.append((start + len(seg) - len(seg.lstrip()), end - (len(seg) - len(seg.rstrip()))))
        start = end
    return spans


def sentences(text: str) -> list[str]:
    return [text[s:e] for s, e in sentence_spans(text)]
