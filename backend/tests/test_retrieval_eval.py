"""Retrieval quality on eval/retrieval_set.json with the real local models.

Guards the measured gains (see eval/README.md) against regressions. Skipped when the
models aren't in the local cache, so the suite never downloads ~150 MB by surprise; run
`python scripts/eval_retrieval.py` once to fetch them.
"""

import importlib.util
import os
import tempfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "eval_retrieval.py"
CACHE = Path(os.environ.get("RC_MODEL_CACHE") or Path.home() / ".research-companion" / "models")
RERANKER = "Xenova/ms-marco-MiniLM-L-6-v2"


def _cached(fragment: str) -> bool:
    return CACHE.exists() and any(fragment in p.name for p in CACHE.iterdir())


pytestmark = pytest.mark.skipif(
    not (_cached("bge-small-en-v1.5") and _cached("ms-marco-MiniLM-L-6-v2")),
    reason="local embedding/reranker models not cached",
)


@pytest.fixture(scope="module")
def results():
    os.environ["HF_HUB_OFFLINE"] = "1"  # use the cache, never the network
    spec = importlib.util.spec_from_file_location("eval_retrieval", SCRIPT)
    ev = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ev)
    from app.retrieval import CrossEncoderReranker

    data = ev.load_set()
    with tempfile.TemporaryDirectory() as tmp:
        lib = ev.build_library(data, CACHE, Path(tmp))
        out = {"dense": ev.evaluate(lib, data, "dense"), "hybrid_norerank": ev.evaluate(lib, data, "hybrid")}
        lib.reranker = CrossEncoderReranker(CACHE, RERANKER)
        out["hybrid_rerank"] = ev.evaluate(lib, data, "hybrid")
        out["auto"] = ev.evaluate(lib, data, "auto")
        lib.reranker = None
        out["auto_without_reranker"] = ev.evaluate(lib, data, "auto")
        lib.conn.close()
    return out


def test_reranked_hybrid_beats_embeddings_alone(results):
    before, after = results["dense"]["overall"], results["hybrid_rerank"]["overall"]
    assert after["R@1"] >= before["R@1"] + 0.05  # measured: 0.82 -> 0.91
    assert after["R@3"] >= before["R@3"]  # measured: 0.93 -> 0.98
    assert after["MRR"] >= before["MRR"] + 0.03  # measured: 0.89 -> 0.94


def test_no_query_type_gets_worse(results):
    for qtype, before in results["dense"]["by_type"].items():
        assert results["hybrid_rerank"]["by_type"][qtype]["R@1"] >= before["R@1"], qtype


def test_identifier_lookups_found(results):
    assert results["hybrid_rerank"]["by_type"]["identifier"]["R@1"] == 1.0


def test_default_mode_is_hybrid_with_or_without_reranker(results):
    # Plain fusion trails embeddings slightly on this 40-passage set but clearly beats them
    # on the 14,000-chunk library (eval/README.md), so "auto" stays hybrid without a reranker.
    assert results["auto"]["overall"] == results["hybrid_rerank"]["overall"]
    assert results["auto_without_reranker"]["overall"] == results["hybrid_norerank"]["overall"]
