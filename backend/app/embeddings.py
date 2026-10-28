"""Local embeddings. Meta's Model API isn't known to offer embeddings, and local-first
means chunk vectors never leave the machine anyway."""

import logging
import zlib
from pathlib import Path
from typing import Protocol

import numpy as np

from .text_utils import tokenize

log = logging.getLogger(__name__)


class Embedder(Protocol):
    id: str

    def embed(self, texts: list[str]) -> np.ndarray:
        """Return an (n, dim) float32 array of L2-normalized vectors."""


def _normalize(m: np.ndarray) -> np.ndarray:
    return (m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-9)).astype(np.float32)


class HashEmbedder:
    """Bag-of-words hashed into a fixed vector. No downloads; good enough for tests and
    as a fallback, much weaker than a real model for semantic search."""

    def __init__(self, dim: int = 512):
        self.dim = dim
        self.id = f"hash-{dim}"

    def embed(self, texts: list[str]) -> np.ndarray:
        m = np.zeros((len(texts), self.dim), dtype=np.float32)
        for row, text in enumerate(texts):
            for word in tokenize(text):
                h = zlib.crc32(word.encode())
                m[row, h % self.dim] += 1.0 if (h >> 16) & 1 else -1.0
        return _normalize(m)


class FastEmbedder:
    def __init__(self, cache_dir: Path, model: str = "BAAI/bge-small-en-v1.5"):
        from fastembed import TextEmbedding

        # fastembed defaults to the OS temp dir, which Windows cleanup may wipe.
        self.model = TextEmbedding(model_name=model, cache_dir=str(cache_dir))
        self.id = f"fastembed:{model}"

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, 384), dtype=np.float32)
        return _normalize(np.array(list(self.model.embed(texts)), dtype=np.float32))


class GpuEmbedder:
    """BGE-M3 (1024-dim, 8k context, ~1.1 GB in fp16) through sentence-transformers. Uses CUDA when
    there is one (fits a 6 GB card), otherwise falls back to CPU, which works but is slow."""

    def __init__(self, cache_dir: Path, model: str = "BAAI/bge-m3", max_seq_length: int = 512):
        import torch
        from sentence_transformers import SentenceTransformer

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = SentenceTransformer(model, device=self.device, cache_folder=str(cache_dir))
        self.model.max_seq_length = max_seq_length  # chunks are short; this caps VRAM per batch
        if self.device == "cuda":
            self.model.half()
        self.dim = self.model.get_sentence_embedding_dimension()
        self.id = f"st:{model}"
        log.info("Embedder %s on %s", model, self.device)

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        batch = 16
        while True:
            try:
                vecs = self.model.encode(
                    texts, batch_size=batch, convert_to_numpy=True, normalize_embeddings=False, show_progress_bar=False
                )
                return _normalize(np.asarray(vecs, dtype=np.float32))
            except RuntimeError as exc:  # CUDA out of memory: retry with smaller batches
                if "out of memory" not in str(exc).lower() or batch == 1:
                    raise
                import torch

                torch.cuda.empty_cache()
                batch //= 2


def _cuda_available() -> bool:
    try:
        import torch

        return torch.cuda.is_available()
    except Exception:
        return False


def make_embedder(kind: str, cache_dir: Path) -> Embedder:
    if kind == "hash":
        return HashEmbedder()
    if kind in ("gpu", "bge-m3"):
        return GpuEmbedder(cache_dir)
    # "auto" picks the stronger GPU model only when a CUDA device is present; on CPU-only
    # machines BGE-M3 would be slow, so they keep the small fastembed model.
    if kind == "auto" and _cuda_available():
        try:
            return GpuEmbedder(cache_dir)
        except Exception as exc:
            log.warning("GPU embedder unavailable (%s); trying fastembed", exc)
    try:
        return FastEmbedder(cache_dir)
    except Exception as exc:  # not installed, or model download failed offline
        if kind == "fastembed":
            raise
        log.warning("fastembed unavailable (%s); falling back to hashing embedder", exc)
        return HashEmbedder()


def to_blob(vec: np.ndarray) -> bytes:
    return vec.astype(np.float32).tobytes()


def from_blob(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)
