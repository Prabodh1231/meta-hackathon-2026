"""Embeddings: bge-small (fastembed, ONNX) on this computer. Chunk text never leaves the machine
to be embedded. When the computer has a GPU that onnxruntime can use, the model runs on it
(CUDA first, then DirectML on Windows); otherwise, or if the GPU can't start the model, it runs
on the CPU. The CPU build of onnxruntime ships with the app; a GPU build (onnxruntime-gpu or
onnxruntime-directml, installed in its place) is picked up automatically when present."""

import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import numpy as np

log = logging.getLogger(__name__)

EMBED_MODEL = "BAAI/bge-small-en-v1.5"
DIM = 384
# bge's retrieval prefix: put on the query only, never on the passages.
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
# GPU providers in the order they are tried; the CPU is always the last resort.
GPU_PROVIDERS = ("CUDAExecutionProvider", "DmlExecutionProvider")


class Embedder(Protocol):
    id: str
    device: str

    def embed(self, texts: list[str]) -> np.ndarray:
        """(n, dim) float32, L2-normalized, for passages."""

    def embed_query(self, text: str) -> np.ndarray:
        """(dim,) float32, L2-normalized, for a search query."""


def _normalize(m: np.ndarray) -> np.ndarray:
    return (m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-9)).astype(np.float32)


def pick_providers(available: list[str] | None = None) -> list[str]:
    """onnxruntime providers to try, best first: the GPU one(s) this computer's onnxruntime
    offers, then the CPU. `available` is for tests; by default it asks onnxruntime."""
    if available is None:
        try:
            import onnxruntime

            available = onnxruntime.get_available_providers()
        except Exception:
            available = []
    return [p for p in GPU_PROVIDERS if p in available] + ["CPUExecutionProvider"]


def device_of(providers: list[str]) -> str:
    """'cuda', 'directml' or 'cpu' for the first provider in the list."""
    return {"CUDAExecutionProvider": "cuda", "DmlExecutionProvider": "directml"}.get(providers[0], "cpu")


class FastEmbedder:
    # Texts per ONNX call. On the CPU small batches ran ~3x faster than fastembed's default of 256;
    # a GPU wants bigger ones.
    CPU_BATCH = 4
    GPU_BATCH = 64

    def __init__(self, cache_dir: Path, model: str = EMBED_MODEL, providers: list[str] | None = None):
        from fastembed import TextEmbedding

        providers = providers or pick_providers()
        self.model = None
        for i, tried in enumerate([providers, ["CPUExecutionProvider"]] if providers != ["CPUExecutionProvider"] else [providers]):
            try:
                # fastembed defaults to the OS temp dir, which Windows cleanup may wipe.
                self.model = TextEmbedding(model_name=model, cache_dir=str(cache_dir), providers=tried)
                self.device = device_of(tried)
                if self.device != "cpu" and not self._works():
                    raise RuntimeError(f"{tried[0]} could not run the model")
                break
            except Exception as exc:
                if tried == ["CPUExecutionProvider"]:
                    raise
                log.warning("GPU unavailable for the search model (%s); using the CPU", exc)
                self.model = None
        self.id = f"fastembed:{model}"
        self.batch = self.CPU_BATCH if self.device == "cpu" else self.GPU_BATCH

    def _works(self) -> bool:
        """onnxruntime falls back to the CPU silently when a GPU provider can't load (missing
        CUDA libraries, say), so check the session itself and run one text through it."""
        try:
            sessions = [getattr(self.model.model, "model", None)]
            active = sessions[0].get_providers() if sessions[0] is not None else []
            if active and active[0] not in GPU_PROVIDERS:
                return False
            list(self.model.embed(["warm up"]))
            return True
        except Exception:
            return False

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, DIM), dtype=np.float32)
        return _normalize(np.array(list(self.model.embed(texts, batch_size=self.batch)), dtype=np.float32))

    def embed_query(self, text: str) -> np.ndarray:
        return self.embed([QUERY_PREFIX + text])[0]


class LoadingEmbedder:
    """An embedder that loads in a background thread: the model downloads on first launch. Listing
    the library doesn't need it, so the backend answers at once; anything that embeds waits here
    until it's ready. If loading fails, `state` says so and each use raises."""

    def __init__(self, load: Callable[[], Embedder]):
        self._inner: Embedder | None = None
        self._error: Exception | None = None
        self._done = threading.Event()
        threading.Thread(target=self._load, args=(load,), name="load-embedder", daemon=True).start()

    def _load(self, load: Callable[[], Embedder]) -> None:
        started = time.perf_counter()
        try:
            self._inner = load()
            log.info("Search model ready on %s after %.1f s", self._inner.device, time.perf_counter() - started)
        except Exception as exc:
            log.exception("The search model couldn't load")
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

    @property
    def device(self) -> str:
        return self.wait().device

    def embed(self, texts: list[str]) -> np.ndarray:
        return self.wait().embed(texts)

    def embed_query(self, text: str) -> np.ndarray:
        return self.wait().embed_query(text)


class HashEmbedder:
    """Bag-of-words hashed into a fixed vector, for tests: no model, no download."""

    device = "cpu"

    def __init__(self, dim: int = 512):
        import zlib

        from .text_utils import tokenize

        self._zlib, self._tokenize = zlib, tokenize
        self.dim = dim
        self.id = f"hash-{dim}"

    def embed(self, texts: list[str]) -> np.ndarray:
        m = np.zeros((len(texts), self.dim), dtype=np.float32)
        for row, text in enumerate(texts):
            for word in self._tokenize(text):
                h = self._zlib.crc32(word.encode())
                m[row, h % self.dim] += 1.0 if (h >> 16) & 1 else -1.0
        return _normalize(m) if len(texts) else m

    def embed_query(self, text: str) -> np.ndarray:
        return self.embed([text])[0]


RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2"


class FastReranker:
    """A cross-encoder: reads the query and a passage together and scores how well the passage
    answers it, which a vector comparison can't. Runs on the GPU when there is one, like the embedder."""

    def __init__(self, cache_dir: Path, model: str = RERANK_MODEL, providers: list[str] | None = None):
        from fastembed.rerank.cross_encoder import TextCrossEncoder

        providers = providers or pick_providers()
        for tried in ([providers, ["CPUExecutionProvider"]] if providers != ["CPUExecutionProvider"] else [providers]):
            try:
                self.model = TextCrossEncoder(model_name=model, cache_dir=str(cache_dir), providers=tried)
                self.device = device_of(tried)
                list(self.model.rerank("warm up", ["warm up"]))
                break
            except Exception as exc:
                if tried == ["CPUExecutionProvider"]:
                    raise
                log.warning("GPU unavailable for the reranker (%s); using the CPU", exc)
        self.id = f"fastembed:{model}"

    def rerank(self, query: str, texts: list[str]) -> list[float]:
        """One score per text (higher is better)."""
        return [float(x) for x in self.model.rerank(query, texts)] if texts else []


class LoadingReranker:
    """A reranker that loads in a background thread, like LoadingEmbedder."""

    def __init__(self, load: Callable[[], FastReranker]):
        self._inner = None
        self._error: Exception | None = None
        self._done = threading.Event()
        threading.Thread(target=self._load, args=(load,), name="load-reranker", daemon=True).start()

    def _load(self, load) -> None:
        try:
            self._inner = load()
            log.info("Reranker ready on %s", self._inner.device)
        except Exception as exc:
            log.exception("The reranker couldn't load")
            self._error = exc
        finally:
            self._done.set()

    @property
    def state(self) -> str:
        return "loading" if not self._done.is_set() else "failed" if self._error else "ready"

    @property
    def id(self) -> str:
        return self._inner.id if self.state == "ready" else ""

    @property
    def device(self) -> str:
        return self._inner.device if self.state == "ready" else ""

    def rerank(self, query: str, texts: list[str]) -> list[float]:
        if self.state != "ready":
            raise RuntimeError("The reranker isn't ready")
        return self._inner.rerank(query, texts)


def make_embedder(cache_dir: Path) -> Embedder:
    """bge-small, on the GPU when there is one."""
    return FastEmbedder(cache_dir)


def to_blob(vec: np.ndarray) -> bytes:
    return vec.astype(np.float32).tobytes()


def from_blob(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)
