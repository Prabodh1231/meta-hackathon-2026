"""Measure retrieval quality on eval/retrieval_set.json.

Builds a throwaway library from the test set (each passage is its own document, so hits
are judged per passage), then runs every query through the three search configurations
the app can run under the Meta-only rule: keyword (BM25) alone, keyword plus provider
query expansion, and keyword plus expansion plus provider passage ranking. Reports
Recall@1, Recall@3 and MRR@10, overall and per query type, plus time per query.

The corpus is always built with the offline mock provider, so no ingestion calls are
measured; the provider used for expansion and ranking is the configured one
(Settings.from_env, i.e. the mock unless Muse is configured), falling back to the
mock when the configured provider cannot be made. No other model is involved.

Usage (from backend/): python -I scripts/eval_retrieval.py [--provider mock|muse] [--json OUT]
"""

import argparse
import dataclasses
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.library import Library  # noqa: E402
from app.providers import MockProvider, make_provider  # noqa: E402
from app.settings import Settings  # noqa: E402

SET_PATH = Path(__file__).resolve().parents[1] / "eval" / "retrieval_set.json"
K = 10

# The three configurations compared. "keyword" makes no provider call at all; the other
# two run the provider's query expansion (mode="hybrid"), and only the last also asks it
# to rank the fused candidates. Library.search mode names "hybrid"/"auto" mean the
# ranked configuration, for older callers.
CONFIGS = [
    {"key": "keyword", "label": "keyword (BM25)", "mode": "keyword", "rerank": False},
    {"key": "expanded", "label": "keyword + expansion", "mode": "hybrid", "rerank": False},
    {"key": "ranked", "label": "keyword + expansion + ranking", "mode": "hybrid", "rerank": True},
]
_MODE_ARGS = {
    "keyword": ("keyword", False),
    "expanded": ("hybrid", False),
    "expansion": ("hybrid", False),
    "ranked": ("hybrid", True),
    "hybrid": ("hybrid", True),
    "auto": ("hybrid", True),
}


def search_args(mode, rerank: bool | None = None) -> tuple[str, bool]:
    """Library.search (mode, rerank) for an eval configuration name or CONFIGS entry."""
    if isinstance(mode, dict):
        return mode["mode"], bool(mode["rerank"] if rerank is None else rerank)
    if mode not in _MODE_ARGS:
        raise ValueError(f"Unknown eval mode {mode!r} (expected one of {', '.join(_MODE_ARGS)})")
    lib_mode, default_rerank = _MODE_ARGS[mode]
    return lib_mode, default_rerank if rerank is None else bool(rerank)


def compute_metrics(ranks: list) -> dict:
    """Recall@1, Recall@3 and MRR for a list of 1-based ranks (None = not in the top K)."""
    n = len(ranks)
    if not n:
        return {"R@1": 0.0, "R@3": 0.0, "MRR": 0.0}
    return {
        "R@1": sum(r == 1 for r in ranks) / n,
        "R@3": sum(r is not None and r <= 3 for r in ranks) / n,
        "MRR": sum(1 / r for r in ranks if r) / n,
    }


def rank_of_answer(hits: list[dict], answer: str) -> int | None:
    """1-based rank of the first hit whose text contains the gold answer, or None."""
    return next((i + 1 for i, h in enumerate(hits) if answer in h["text"]), None)


def configured_provider(settings: Settings | None = None):
    """The provider the app is configured with; the offline mock when it cannot be made
    (for example Muse chosen but no key set), so the eval still runs."""
    settings = settings or Settings.from_env()
    try:
        return make_provider(settings)
    except Exception:
        return MockProvider()


def load_set() -> dict:
    data = json.loads(SET_PATH.read_text(encoding="utf-8"))
    passages = [p for doc in data["documents"].values() for p in doc]
    for q in data["queries"]:  # a gold answer must identify exactly one passage
        found = sum(q["answer"] in p for p in passages)
        assert found == 1, f"answer {q['answer']!r} appears in {found} passages"
    return data


def build_library(data: dict, cache: Path | None = None, workdir: Path | None = None,
                  provider=None) -> Library:
    # `cache` is accepted for older callers and ignored: no model is downloaded or loaded.
    workdir = workdir or Path(tempfile.mkdtemp())
    lib = Library(Settings(data_dir=workdir / "data"), provider=provider or MockProvider())
    corpus = workdir / "corpus"
    corpus.mkdir()
    for name, passages in data["documents"].items():
        for i, text in enumerate(passages):
            (corpus / f"{name}__{i}.md").write_text(text + "\n", encoding="utf-8")
    results = lib.ingest_path(str(corpus))
    assert all(r["ok"] for r in results), [r for r in results if not r["ok"]]
    return lib


def evaluate(lib: Library, data: dict, mode="keyword", rerank: bool | None = None) -> dict:
    """Score one configuration ("keyword", "expanded", "ranked"; "hybrid"/"auto" are the
    ranked one, as in Library.search) over every query in the set."""
    lib_mode, do_rerank = search_args(mode, rerank)
    ranks, times, by_type = [], [], {}
    for q in data["queries"]:
        start = time.perf_counter()
        hits = lib.search(q["q"], k=K, mode=lib_mode, rerank=do_rerank)
        times.append(time.perf_counter() - start)
        rank = rank_of_answer(hits, q["answer"])
        ranks.append(rank)
        by_type.setdefault(q["type"], []).append(rank)
    return {
        "mode": mode["key"] if isinstance(mode, dict) else mode,
        "search_mode": lib_mode,
        "rerank": do_rerank,
        "overall": compute_metrics(ranks),
        "by_type": {t: compute_metrics(rs) for t, rs in by_type.items()},
        "ms_per_query": 1000 * statistics.mean(times) if times else 0.0,
        "misses": [q["q"] for q, r in zip(data["queries"], ranks) if r != 1],
    }


def format_table(results: dict, types: list[str]) -> str:
    """The printed comparison: one row per configuration in CONFIGS present in `results`
    (keyed by configuration key), per-type columns are R@1."""
    header = f"{'configuration':<34}{'R@1':>6}{'R@3':>6}{'MRR':>6}  " + "".join(f"{t + ' R@1':>16}" for t in types) + f"{'ms/query':>10}"
    lines = [header, "-" * len(header)]
    for config in CONFIGS:
        r = results.get(config["key"])
        if r is None:
            continue
        o = r["overall"]
        row = f"{config['label']:<34}{o['R@1']:>6.2f}{o['R@3']:>6.2f}{o['MRR']:>6.2f}  "
        row += "".join(f"{r['by_type'].get(t, {'R@1': 0.0})['R@1']:>16.2f}" for t in types)
        lines.append(row + f"{r['ms_per_query']:>10.0f}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", choices=("mock", "muse"), help="provider for expansion and ranking (default: the configured one)")
    ap.add_argument("--json", type=Path, help="write full results here")
    args = ap.parse_args()

    settings = Settings.from_env()
    if args.provider:
        settings = dataclasses.replace(settings, provider=args.provider)
    provider = configured_provider(settings)
    if provider.name != settings.provider:
        print(f"configured provider {settings.provider!r} is unavailable; using the offline mock instead", file=sys.stderr)

    data = load_set()
    with tempfile.TemporaryDirectory() as tmp:
        lib = build_library(data, workdir=Path(tmp))  # built offline; only search uses `provider`
        lib.provider = provider
        results = {}
        for config in CONFIGS:
            lib.search("warm up", k=K, mode=config["mode"], rerank=config["rerank"])
            results[config["key"]] = evaluate(lib, data, config)
        lib.conn.close()

    types = list(results[CONFIGS[0]["key"]]["by_type"])
    n = len(data["queries"])
    print(f"\nprovider for expansion and ranking: {provider.name} (the keyword configuration makes no provider call)")
    print(f"\n{n} queries ({', '.join(f'{sum(q['type'] == t for q in data['queries'])} {t}' for t in types)}), "
          f"{sum(len(p) for p in data['documents'].values())} passages\n")
    print(format_table(results, types))
    if args.json:
        args.json.write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(f"\nfull results (including missed queries) written to {args.json}")


if __name__ == "__main__":
    main()
