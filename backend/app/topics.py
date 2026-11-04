"""Cluster documents into topics with spherical k-means over TF-IDF word statistics:
how distinctive each word is in a document, counted from its text. No model is involved."""

import math
from collections import Counter

import numpy as np

from .text_utils import tokenize


def choose_k(n: int) -> int:
    if n < 3:
        return 1
    return max(2, min(12, round(math.sqrt(n / 1.5))))


def kmeans(x: np.ndarray, k: int, iters: int = 50, seed: int = 0) -> np.ndarray:
    """Cosine k-means on L2-normalized rows; returns a cluster label per row."""
    n = len(x)
    k = min(k, n)
    rng = np.random.default_rng(seed)
    centers = [x[rng.integers(n)]]
    for _ in range(1, k):  # k-means++ seeding
        dist = np.clip(1 - np.max(x @ np.stack(centers).T, axis=1), 0, None)
        p = dist / dist.sum() if dist.sum() > 0 else np.full(n, 1 / n)
        centers.append(x[rng.choice(n, p=p)])
    c = np.stack(centers)
    labels = np.zeros(n, dtype=int)
    for _ in range(iters):
        labels = np.argmax(x @ c.T, axis=1)
        new_c = np.stack([x[labels == j].mean(axis=0) if np.any(labels == j) else c[j] for j in range(k)])
        new_c /= np.linalg.norm(new_c, axis=1, keepdims=True) + 1e-9
        if np.allclose(new_c, c):
            break
        c = new_c
    return labels


def _tfidf_encode(counters: list[Counter], vocab: dict[str, int], idf: np.ndarray) -> np.ndarray:
    """Weighted word counts for texts, as L2-normalized rows in `vocab` order."""
    out = np.zeros((len(counters), len(vocab)), dtype=np.float32)
    for row, counts in enumerate(counters):
        for word, n in counts.items():
            col = vocab.get(word)
            if col is not None:
                out[row, col] = n * idf[col]
    return out / (np.linalg.norm(out, axis=1, keepdims=True) + 1e-9)


def _tfidf_setup(texts: list[str]):
    """Vocabulary and inverse document frequencies (rare words weigh more) for a set of texts."""
    counters = [Counter(tokenize(t)) for t in texts]
    vocab = {w: i for i, w in enumerate(sorted({w for c in counters for w in c}))}
    df = np.zeros(len(vocab), dtype=np.float32)
    for counts in counters:
        for word in counts:
            df[vocab[word]] += 1
    idf = np.log((1 + len(texts)) / (1 + df)) + 1.0 if texts else df
    return counters, vocab, idf


def tfidf_matrix(texts: list[str]) -> np.ndarray:
    """One normalized TF-IDF vector per text, over the vocabulary the texts share."""
    if not texts:
        return np.zeros((0, 0), dtype=np.float32)
    counters, vocab, idf = _tfidf_setup(texts)
    return _tfidf_encode(counters, vocab, idf)


def tfidf_cosines(documents: list[str], queries: list[str],
                  candidate: str | None = None) -> tuple[np.ndarray, np.ndarray | None]:
    """Cosine of each document to each query text, and of one extra candidate text when given.

    The candidate is a document not in `documents` yet (a paper being filed while it is
    stored): it is weighted with the library's own word statistics, so its scores are
    read against the same average as the stored documents'."""
    if not documents:
        return np.zeros((0, len(queries)), dtype=np.float32), (np.zeros(len(queries), dtype=np.float32) if candidate is not None else None)
    counters, vocab, idf = _tfidf_setup(documents)
    docs = _tfidf_encode(counters, vocab, idf)
    wants = _tfidf_encode([Counter(tokenize(q)) for q in queries], vocab, idf)
    mine = None
    if candidate is not None:
        mine = (_tfidf_encode([Counter(tokenize(candidate))], vocab, idf) @ wants.T)[0]
    return docs @ wants.T, mine


def jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a or b else 0.0
