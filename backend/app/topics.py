"""Cluster documents into topics with spherical k-means over their mean chunk embeddings."""

import math

import numpy as np


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


def jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a or b else 0.0
