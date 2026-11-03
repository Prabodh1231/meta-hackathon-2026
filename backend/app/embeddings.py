"""Embeddings: bge-small (fastembed) on this computer, always. Meta's Model API isn't known to
offer embeddings, and local-first means chunk text never leaves the machine to be embedded.
BGE-M3 (GPU or Baseten) was dropped after eval/README.md showed the app's hybrid + reranked
search ranks the same passage first with either model, for a 2 GB download and a 12 s load."""

import logging
import threading
import time
import zlib
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import numpy as np

from .text_utils import tokenize

log = logging.getLogger(__name__)

EMBED_MODEL = "BAAI/bge-small-en-v1.5"


def bundled_model(models_dir: Path | None, model: str) -> str | None:
    """The folder of a model shipped with the installer (scripts/fetch_models.py puts each in
    <models_dir>/<org>--<name>), or None when it isn't there and has to be downloaded."""
    if models_dir is None:
        return None
    folder = models_dir / model.replace("/", "--")
    return str(folder) if folder.is_dir() and any(folder.glob("*.json")) else None


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
    # Texts per ONNX call. fastembed's default of 256 ran at 16 chunks/s on ~700-character chunks
    # (20-thread CPU); batches of 1-8 ran at 42-52, so imports and re-embedding are ~3x faster.
    BATCH = 4

    def __init__(self, cache_dir: Path, model: str = EMBED_MODEL, path: str | None = None):
        from fastembed import TextEmbedding

        # fastembed defaults to the OS temp dir, which Windows cleanup may wipe. `path`: the
        # installer's copy, loaded without downloading; the id is the same, so are the vectors.
        self.model = TextEmbedding(model_name=model, cache_dir=str(cache_dir), specific_model_path=path)
        self.id = f"fastembed:{model}"

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, 384), dtype=np.float32)
        return _normalize(np.array(list(self.model.embed(texts, batch_size=self.BATCH)), dtype=np.float32))


class LoadingEmbedder:
    """An embedder that loads in a background thread: the model downloads on first launch, and
    a library embedded with another model is re-embedded before use. Listing the library doesn't
    need it, so the backend answers at once; anything that embeds waits here until it's ready.
    `load` returns the real embedder; if it fails, each use raises instead of searching with
    something else."""

    def __init__(self, load: Callable[[], Embedder]):
        self._inner: Embedder | None = None
        self._error: Exception | None = None
        self._done = threading.Event()
        threading.Thread(target=self._load, args=(load,), name="load-embedder", daemon=True).start()

    def _load(self, load: Callable[[], Embedder]) -> None:
        started = time.perf_counter()
        try:
            self._inner = load()
            log.info("Embedder ready after %.1f s", time.perf_counter() - started)
        except Exception as exc:
            log.exception("The embedding model couldn't load")
            self._error = exc
        finally:
            self._done.set()

    @property
    def state(self) -> str:
        """'loading', 'ready' or 'failed', without waiting."""
        return "loading" if not self._done.is_set() else "failed" if self._error else "ready"

    def wait(self) -> Embedder:
        self._done.wait()
        if self._error:
            raise RuntimeError(f"The search model couldn't load: {self._error}") from self._error
        return self._inner

    @property
    def id(self) -> str:
        return self.wait().id

    def embed(self, texts: list[str]) -> np.ndarray:
        return self.wait().embed(texts)

    def __getattr__(self, name: str):  # device, dim, … of the loaded embedder
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self.wait(), name)


def make_embedder(kind: str, cache_dir: Path, models_dir: Path | None = None) -> Embedder:
    """kind: "hash" (tests, scripts) or anything else for bge-small, falling back to the hashing
    embedder when fastembed can't load (not installed, or the model can't download offline).
    Values from older versions ("auto", "local", "baseten", "bge-m3", "gpu") mean bge-small.
    The installer's copy in `models_dir` is used when it's there."""
    if kind == "hash":
        return HashEmbedder()
    try:
        return FastEmbedder(cache_dir, path=bundled_model(models_dir, EMBED_MODEL))
    except Exception as exc:
        if kind == "fastembed":
            raise
        log.warning("fastembed unavailable (%s); falling back to hashing embedder", exc)
        return HashEmbedder()


def to_blob(vec: np.ndarray) -> bytes:
    return vec.astype(np.float32).tobytes()


def from_blob(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)
