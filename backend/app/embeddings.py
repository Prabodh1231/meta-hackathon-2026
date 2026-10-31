"""Embeddings. Local by default: Meta's Model API isn't known to offer embeddings, and
local-first means chunk vectors never leave the machine. A machine without a CUDA GPU can use
the same BGE-M3 model on a Baseten deployment instead of the weaker CPU model."""

import logging
import re
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Protocol

import httpx
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


def baseten_base(model: str) -> str:
    """A Baseten deployment's base URL from its model ID ("abcd1234") or any URL of it (the
    dashboard's /v1/embeddings, /rerank or /predict address)."""
    model = model.strip().rstrip("/")
    if re.fullmatch(r"[A-Za-z0-9]{6,16}", model):
        return f"https://model-{model}.api.baseten.co/environments/production/sync"
    if not re.match(r"https://[\w.-]+\.baseten\.co/", model):
        raise ValueError("Paste a Baseten model ID or its https://model-….api.baseten.co/… address")
    return re.sub(r"/(v1/embeddings|v1|rerank|predict)$", "", model)


def baseten_post(client: httpx.Client, url: str, body: dict) -> httpx.Response:
    """POST with retries: a deployment that scaled to zero answers 503 or times out while it wakes."""
    for attempt in range(5):
        try:
            res = client.post(url, json=body)
        except httpx.TimeoutException:
            if attempt == 4:
                raise
            continue
        if res.status_code in (429, 500, 502, 503, 504) and attempt < 4:
            time.sleep(min(2 ** attempt, 10))
            continue
        res.raise_for_status()
        return res
    raise RuntimeError("unreachable")


class BasetenEmbedder:
    """BGE-M3 on a Baseten deployment (its OpenAI-compatible /v1/embeddings), for machines
    without a CUDA GPU. It's the model GpuEmbedder runs, so it shares that embedder's id: moving
    between this computer's GPU and Baseten doesn't re-embed the library."""

    device = "baseten"
    BATCH = 32  # texts per request
    PARALLEL = 4  # requests in flight

    def __init__(self, model: str, api_key: str, model_name: str = "BAAI/bge-m3", dim: int = 1024,
                 transport: httpx.BaseTransport | None = None):
        if not api_key:
            raise ValueError("A Baseten API key is needed to embed on Baseten")
        self.url = baseten_base(model) + "/v1/embeddings"
        self.client = httpx.Client(timeout=120.0, transport=transport, headers={"Authorization": f"Api-Key {api_key}"})
        self.dim = dim
        self.id = f"st:{model_name}"

    def _batch(self, texts: list[str]) -> list[list[float]]:
        data = baseten_post(self.client, self.url, {"input": texts, "model": "not-required"}).json()["data"]
        return [d["embedding"] for d in sorted(data, key=lambda d: d["index"])]

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        batches = [texts[i:i + self.BATCH] for i in range(0, len(texts), self.BATCH)]
        with ThreadPoolExecutor(max_workers=min(self.PARALLEL, len(batches))) as pool:
            parts = list(pool.map(self._batch, batches))
        return _normalize(np.array([v for part in parts for v in part], dtype=np.float32))


def _cuda_available() -> bool:
    try:
        import torch

        return torch.cuda.is_available()
    except Exception:
        return False


def make_embedder(kind: str, cache_dir: Path, baseten_model: str = "", baseten_key: str = "") -> Embedder:
    """kind: "auto" (this computer's GPU; else Baseten when it's set up; else the small CPU model),
    "local" (this computer only), "baseten", or one model: "bge-m3" / "gpu", "fastembed", "hash"."""
    if kind == "hash":
        return HashEmbedder()
    if kind in ("gpu", "bge-m3"):
        return GpuEmbedder(cache_dir)
    if kind == "baseten":
        return BasetenEmbedder(baseten_model, baseten_key)
    # The stronger GPU model only when a CUDA device is present; on CPU-only machines BGE-M3
    # would be slow, so they use it on Baseten when that's set up, or the small fastembed model.
    cuda = kind in ("auto", "local") and _cuda_available()
    if cuda:
        try:
            return GpuEmbedder(cache_dir)
        except Exception as exc:
            log.warning("GPU embedder unavailable (%s); trying the next option", exc)
    if kind == "auto" and baseten_model and baseten_key:
        try:
            embedder = BasetenEmbedder(baseten_model, baseten_key)
            embedder.embed(["warm up"])  # wakes a deployment that scaled to zero, and checks it answers
            return embedder
        except Exception as exc:
            log.warning("Baseten embeddings unavailable (%s); using the CPU model", exc)
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
