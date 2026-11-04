"""Retrieval quality on eval/retrieval_set.json.

Search is keyword (BM25) plus provider expansion and ranking, so this checks the
eval script against the offline mock provider. Phase 4 rewrites the eval to
compare keyword-only, expanded and ranked search in more depth; nothing here
downloads or loads a model.
"""

import importlib.util
import tempfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "eval_retrieval.py"


@pytest.fixture(scope="module")
def results():
    spec = importlib.util.spec_from_file_location("eval_retrieval", SCRIPT)
    ev = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ev)

    data = ev.load_set()
    with tempfile.TemporaryDirectory() as tmp:
        lib = ev.build_library(data, None, Path(tmp))
        out = {"keyword": ev.evaluate(lib, data, "keyword"), "hybrid": ev.evaluate(lib, data, "hybrid")}
        out["auto"] = ev.evaluate(lib, data, "auto")
        lib.conn.close()
    return out


def test_eval_script_builds_a_keyword_library_offline(results):
    assert results["keyword"]["overall"]["R@3"] > 0
    assert results["auto"]["overall"] == results["hybrid"]["overall"]  # auto is the hybrid search


def test_identifier_lookups_found(results):
    assert results["keyword"]["by_type"]["identifier"]["R@1"] == 1.0
