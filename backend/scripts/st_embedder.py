"""Sentence-transformers models for the evaluation scripts only. The app embeds with bge-small
(fastembed) and never imports this; eval/README.md has the BGE-M3 comparison that settled it.
Needs `pip install sentence-transformers` (and a CUDA build of torch for the GPU)."""

import logging
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)


def _normalize(m: np.ndarray) -> np.ndarray:
    return (m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-9)).astype(np.float32)


class SentenceTransformerEmbedder:
    """Any sentence-transformers model, BGE-M3 by default, on CUDA when there is one (fp16)."""

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
