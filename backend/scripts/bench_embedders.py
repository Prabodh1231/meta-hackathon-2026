"""Compare embedding models on speed and dense-retrieval quality.

Quality: Recall@1/3 and MRR@10 on eval/retrieval_set.json, embeddings only (no keyword index,
no reranker), so differences come from the embedder alone. Speed: chunks per second over ~900
character chunks (the size real documents are split into) and milliseconds to embed one query.

Usage: python scripts/bench_embedders.py [--models bge-small bge-m3 ...] [--json OUT]
Models download to ~/.research-companion/models on first use.
"""

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.embeddings import FastEmbedder  # noqa: E402
from app.settings import Settings  # noqa: E402
from eval_retrieval import load_set  # noqa: E402

CACHE = Settings.from_env().data_dir / "models"
K = 10


def make(name: str):
    if name == "bge-small":
        return FastEmbedder(CACHE)
    if name == "bge-m3":
        from app.embeddings import GpuEmbedder

        return GpuEmbedder(CACHE)
    if name == "bge-m3-cpu":
        import torch

        from app.embeddings import GpuEmbedder

        torch.cuda.is_available = lambda: False  # force the CPU path for a fair CPU number
        return GpuEmbedder(CACHE)
    if name.startswith("st:"):  # any sentence-transformers model, e.g. st:Qwen/Qwen3-Embedding-0.6B
        from app.embeddings import GpuEmbedder

        return GpuEmbedder(CACHE, model=name[3:])
    raise SystemExit(f"unknown model {name}")


def quality(emb, data: dict) -> dict:
    passages = [p for doc in data["documents"].values() for p in doc]
    docs = emb.embed(passages)
    ranks = []
    for q in data["queries"]:
        scores = docs @ emb.embed([q["q"]])[0]
        order = np.argsort(-scores)[:K]
        gold = next(i for i, p in enumerate(passages) if q["answer"] in p)
        ranks.append(next((r + 1 for r, i in enumerate(order) if i == gold), None))
    n = len(ranks)
    return {
        "r@1": sum(r == 1 for r in ranks) / n,
        "r@3": sum(r is not None and r <= 3 for r in ranks) / n,
        "mrr": sum(1 / r for r in ranks if r) / n,
    }


def speed(emb, data: dict, n_chunks: int = 300) -> dict:
    passages = [p for doc in data["documents"].values() for p in doc]
    chunks, i = [], 0
    while len(chunks) < n_chunks:  # glue passages together up to ~900 characters
        text = ""
        while len(text) < 900:
            text += passages[i % len(passages)] + " "
            i += 1
        chunks.append(text[:900])
    emb.embed(chunks[:16])  # warm up (CUDA init, caches)
    t = time.perf_counter()
    emb.embed(chunks)
    per_s = n_chunks / (time.perf_counter() - t)
    q = []
    for question in [x["q"] for x in data["queries"][:20]]:
        t = time.perf_counter()
        emb.embed([question])
        q.append((time.perf_counter() - t) * 1000)
    return {"chunks_per_s": per_s, "query_ms": statistics.median(q)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["bge-small", "bge-m3"])
    ap.add_argument("--json")
    args = ap.parse_args()
    data = load_set()
    rows = []
    for name in args.models:
        emb = make(name)
        row = {"model": name, "device": getattr(emb, "device", "cpu"), **quality(emb, data), **speed(emb, data)}
        rows.append(row)
        print(
            f"{name:12} {row['device']:5} R@1 {row['r@1']:.2f}  R@3 {row['r@3']:.2f}  MRR {row['mrr']:.2f}  "
            f"{row['chunks_per_s']:7.1f} chunks/s  {row['query_ms']:6.1f} ms/query",
            flush=True,
        )
        del emb
    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
