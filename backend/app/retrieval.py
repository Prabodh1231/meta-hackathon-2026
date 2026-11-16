"""Keyword retrieval pieces: FTS5/BM25 queries and rank fusion.

BM25 finds exact terms and identifiers ("P-17", "S-208", gene names) and ranks by
how many rare terms a chunk contains. The provider suggests short expansions in the
words a paper would use; reciprocal rank fusion merges the BM25 lists for the query
and its expansions without having to calibrate their scores, and the provider then
ranks the best few passages in one call (see Library.search).
"""

import re
import threading
from collections import OrderedDict, defaultdict


# Only true function words: everything else may be the term that matters, and BM25's IDF
# already discounts words that are common in this library.
_FTS_STOPWORDS = frozenset(
    """a an and are as at be by can could did do does for from had has have how in is it its
    of on or that the their there these this those to was were what when where which who why
    will with would about into than then they them we you your our""".split()
)
# Words, plus identifiers kept whole: P-17, EA-2024-031, 3-back, 36.5
_FTS_TOKEN = re.compile(r"[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)*")


def fts_query(text: str) -> str:
    """Turn free text into an FTS5 query: each term quoted (so punctuation can't be read as
    query syntax) and OR-ed, letting BM25 rank by how many rare terms a chunk contains."""
    terms: dict[str, None] = {}
    for token in _FTS_TOKEN.findall(text):
        if token.lower() in _FTS_STOPWORDS:
            continue
        if len(token) < 2 and not token.isdigit():
            continue
        terms['"' + token + '"'] = None
    return " OR ".join(terms)


def reciprocal_rank_fusion(*rankings: list[int], k: int = 60) -> list[tuple[int, float]]:
    """Merge ranked id lists: each list contributes 1 / (k + rank). Robust to the lists'
    scores being on different scales, which is why scores aren't used at all."""
    scores: dict[int, float] = defaultdict(float)
    for ranking in rankings:
        for rank, item in enumerate(ranking):
            scores[item] += 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda kv: -kv[1])


# Ranking is done by the provider layer (Library.search calls rank_passages), not by a local model.


class RecentCache:
    """The last `size` answers by key, for calls worth not repeating (a Muse call behind a
    search). Safe to use from several threads; the least recently used entry goes first."""

    def __init__(self, size: int):
        self.size = size
        self._items: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            if key not in self._items:
                return None
            self._items.move_to_end(key)
            return self._items[key]

    def put(self, key, value) -> None:
        with self._lock:
            self._items[key] = value
            self._items.move_to_end(key)
            while len(self._items) > self.size:
                self._items.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
