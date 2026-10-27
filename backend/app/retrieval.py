"""Hybrid retrieval pieces: keyword (FTS5/BM25) queries, rank fusion and a local reranker.

Dense embeddings find paraphrases but miss exact identifiers ("P-17", "S-208", gene
names); BM25 is the reverse. Reciprocal rank fusion combines both lists without having
to calibrate their scores, and a cross-encoder then reads query and passage together to
put the best few on top. See eval/ for the test set these choices were measured on.
"""

import logging
import re
from collections import defaultdict
from pathlib import Path
from typing import Protocol

log = logging.getLogger(__name__)

DEFAULT_RERANKER = "Xenova/ms-marco-MiniLM-L-6-v2"

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


class Reranker(Protocol):
    id: str

    def score(self, query: str, texts: list[str]) -> list[float]:
        """Relevance of each text to the query; higher is better."""


class CrossEncoderReranker:
    def __init__(self, cache_dir: Path, model: str = DEFAULT_RERANKER):
        from fastembed.rerank.cross_encoder import TextCrossEncoder

        self.model = TextCrossEncoder(model_name=model, cache_dir=str(cache_dir))
        self.id = f"fastembed:{model}"

    def score(self, query: str, texts: list[str]) -> list[float]:
        if not texts:
            return []
        return [float(s) for s in self.model.rerank(query, texts)]


def make_reranker(kind: str, cache_dir: Path) -> Reranker | None:
    """kind: "none", "auto" (default model, skipped if it can't load) or a model name."""
    if kind == "none":
        return None
    model = DEFAULT_RERANKER if kind == "auto" else kind
    try:
        return CrossEncoderReranker(cache_dir, model)
    except Exception as exc:  # not installed, or download failed offline
        if kind != "auto":
            raise
        log.warning("Reranker unavailable (%s); search will use fused keyword+vector ranking", exc)
        return None
