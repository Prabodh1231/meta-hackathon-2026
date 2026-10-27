"""Measure retrieval quality on eval/retrieval_set.json.

Builds a throwaway library from the test set (each passage is its own document, so hits
are judged per passage) with the real local embedding model, then runs every query
through each retrieval configuration and reports Recall@1, Recall@3 and MRR@10, overall
and per query type, plus time per query.

Usage: python scripts/eval_retrieval.py [--rerankers MODEL ...] [--json OUT]
Models load from ~/.research-companion/models (override with RC_MODEL_CACHE) and are
downloaded there on first use.
"""

import argparse
import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.embeddings import FastEmbedder  # noqa: E402
from app.library import Library  # noqa: E402
from app.providers import MockProvider  # noqa: E402
from app.retrieval import CrossEncoderReranker  # noqa: E402
from app.settings import Settings  # noqa: E402

SET_PATH = Path(__file__).resolve().parents[1] / "eval" / "retrieval_set.json"
DEFAULT_RERANKERS = [
    "Xenova/ms-marco-MiniLM-L-6-v2",
    "Xenova/ms-marco-MiniLM-L-12-v2",
    "jinaai/jina-reranker-v1-tiny-en",
    "jinaai/jina-reranker-v1-turbo-en",
]
K = 10


def load_set() -> dict:
    data = json.loads(SET_PATH.read_text(encoding="utf-8"))
    passages = [p for doc in data["documents"].values() for p in doc]
    for q in data["queries"]:  # a gold answer must identify exactly one passage
        found = sum(q["answer"] in p for p in passages)
        assert found == 1, f"answer {q['answer']!r} appears in {found} passages"
    return data


def build_library(data: dict, cache: Path, workdir: Path) -> Library:
    lib = Library(Settings(data_dir=workdir / "data"), provider=MockProvider(), embedder=FastEmbedder(cache), reranker=None)
    corpus = workdir / "corpus"
    corpus.mkdir()
    for name, passages in data["documents"].items():
        for i, text in enumerate(passages):
            (corpus / f"{name}__{i}.md").write_text(text + "\n", encoding="utf-8")
    results = lib.ingest_path(str(corpus))
    assert all(r["ok"] for r in results), [r for r in results if not r["ok"]]
    return lib


def evaluate(lib: Library, data: dict, mode: str) -> dict:
    ranks, times, by_type = [], [], {}
    for q in data["queries"]:
        start = time.perf_counter()
        hits = lib.search(q["q"], k=K, mode=mode)  # reranks when lib.reranker is set
        times.append(time.perf_counter() - start)
        rank = next((i + 1 for i, h in enumerate(hits) if q["answer"] in h["text"]), None)
        ranks.append(rank)
        by_type.setdefault(q["type"], []).append(rank)

    def metrics(rs: list) -> dict:
        n = len(rs)
        return {
            "R@1": sum(r == 1 for r in rs) / n,
            "R@3": sum(r is not None and r <= 3 for r in rs) / n,
            "MRR": sum(1 / r for r in rs if r) / n,
        }

    return {
        "overall": metrics(ranks),
        "by_type": {t: metrics(rs) for t, rs in by_type.items()},
        "ms_per_query": 1000 * statistics.mean(times),
        "misses": [q["q"] for q, r in zip(data["queries"], ranks) if r != 1],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rerankers", nargs="*", default=DEFAULT_RERANKERS)
    ap.add_argument("--json", type=Path, help="write full results here")
    args = ap.parse_args()
    cache = Path(os.environ.get("RC_MODEL_CACHE") or Path.home() / ".research-companion" / "models")

    data = load_set()
    with tempfile.TemporaryDirectory() as tmp:
        lib = build_library(data, cache, Path(tmp))
        configs = [("dense (before)", "dense", None), ("keyword (BM25)", "keyword", None), ("hybrid (RRF)", "hybrid", None)]
        for m in args.rerankers:  # dense + reranker shows how much the keyword index adds
            configs += [(f"dense + {m.split('/')[-1]}", "dense", m), (f"hybrid + {m.split('/')[-1]}", "hybrid", m)]
        results = {}
        for label, mode, model in configs:
            lib.reranker = CrossEncoderReranker(cache, model) if model else None
            evaluate(lib, data, mode)  # warm-up: first call pays model load / JIT costs
            results[label] = evaluate(lib, data, mode)
        lib.conn.close()

    types = list(results[next(iter(results))]["by_type"])
    n = len(data["queries"])
    print(f"\n{n} queries ({', '.join(f'{sum(q['type'] == t for q in data['queries'])} {t}' for t in types)}), "
          f"{sum(len(p) for p in data['documents'].values())} passages\n")
    header = f"{'configuration':<34}{'R@1':>6}{'R@3':>6}{'MRR':>6}  " + "".join(f"{t + ' R@1':>16}" for t in types) + f"{'ms/query':>10}"
    print(header)
    print("-" * len(header))
    for label, r in results.items():
        o = r["overall"]
        row = f"{label:<34}{o['R@1']:>6.2f}{o['R@3']:>6.2f}{o['MRR']:>6.2f}  "
        row += "".join(f"{r['by_type'][t]['R@1']:>16.2f}" for t in types)
        print(row + f"{r['ms_per_query']:>10.0f}")
    if args.json:
        args.json.write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(f"\nfull results (including missed queries) written to {args.json}")


if __name__ == "__main__":
    main()
