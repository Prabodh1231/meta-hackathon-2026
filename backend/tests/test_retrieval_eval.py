"""Retrieval quality on eval/retrieval_set.json.

Search is keyword (BM25) plus provider expansion and ranking, so this checks the
eval script against the offline mock provider: the metric helpers, the three
configurations it compares (keyword only, keyword + expansion, and that plus
ranking), and the table it prints. Nothing here downloads or loads a model, and
no test reaches the network.
"""

import importlib.util
import tempfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "eval_retrieval.py"


def load_script(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPT.parent / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def ev():
    return load_script("eval_retrieval", SCRIPT.name)


@pytest.fixture(scope="module")
def results(ev):
    data = ev.load_set()
    with tempfile.TemporaryDirectory() as tmp:
        lib = ev.build_library(data, None, Path(tmp))
        out = {config["key"]: ev.evaluate(lib, data, config) for config in ev.CONFIGS}
        out["hybrid"] = out["ranked"]  # the Library.search name for the ranked configuration
        out["auto"] = ev.evaluate(lib, data, "auto")
        lib.conn.close()
    return out


def test_eval_script_builds_a_keyword_library_offline(results):
    assert results["keyword"]["overall"]["R@3"] > 0
    assert results["auto"]["overall"] == results["hybrid"]["overall"]  # auto is the hybrid search


def test_identifier_lookups_found(results):
    assert results["keyword"]["by_type"]["identifier"]["R@1"] == 1.0


def test_compute_metrics_on_known_ranks(ev):
    m = ev.compute_metrics([1, 2, 4, None])
    assert m["R@1"] == 0.25 and m["R@3"] == 0.5 and m["MRR"] == (1 + 0.5 + 0.25) / 4
    assert ev.compute_metrics([]) == {"R@1": 0.0, "R@3": 0.0, "MRR": 0.0}
    assert ev.compute_metrics([1, 1]) == {"R@1": 1.0, "R@3": 1.0, "MRR": 1.0}


def test_rank_of_answer(ev):
    hits = [{"text": "a sleep passage"}, {"text": "the gold sentence"}]
    assert ev.rank_of_answer(hits, "gold sentence") == 2
    assert ev.rank_of_answer(hits, "not there") is None


def test_configs_are_the_three_search_modes(ev):
    assert [(c["key"], c["mode"], c["rerank"]) for c in ev.CONFIGS] == [
        ("keyword", "keyword", False),  # no provider call
        ("expanded", "hybrid", False),  # expansion only
        ("ranked", "hybrid", True),  # expansion and ranking
    ]
    assert ev.search_args("keyword") == ("keyword", False)
    assert ev.search_args("expanded") == ("hybrid", False)
    assert ev.search_args("ranked") == ("hybrid", True)
    assert ev.search_args("hybrid") == ("hybrid", True)  # older name for the ranked mode
    assert ev.search_args("expanded", rerank=True) == ("hybrid", True)  # explicit override wins
    with pytest.raises(ValueError):
        ev.search_args("psychic")


def test_three_modes_all_score_the_set(ev, results):
    types = set(results["keyword"]["by_type"])
    assert types == {"keyword", "paraphrase", "precision", "identifier"}
    for key in ("keyword", "expanded", "ranked"):
        r = results[key]
        assert set(r["overall"]) == {"R@1", "R@3", "MRR"}
        assert all(0.0 <= v <= 1.0 for v in r["overall"].values())
        assert set(r["by_type"]) == types and r["ms_per_query"] >= 0
        assert isinstance(r["misses"], list)


def test_format_table_has_the_required_columns(ev, results):
    types = list(results["keyword"]["by_type"])
    table = ev.format_table(results, types)
    for heading in ("configuration", "R@1", "R@3", "MRR", "ms/query", "paraphrase R@1"):
        assert heading in table
    for config in ev.CONFIGS:
        assert config["label"] in table


def test_configured_provider_falls_back_to_offline_mock(ev, tmp_path):
    mock_settings = ev.Settings(data_dir=tmp_path, provider="mock")
    assert isinstance(ev.configured_provider(mock_settings), ev.MockProvider)
    # Muse chosen but no key set: the eval falls back rather than failing or calling out.
    muse_settings = ev.Settings(data_dir=tmp_path, provider="muse", muse_api_key="")
    assert isinstance(ev.configured_provider(muse_settings), ev.MockProvider)


def test_eval_large_shares_the_three_modes(ev):
    large = load_script("eval_large", "eval_large.py")
    assert [(c["key"], c["mode"], c["rerank"]) for c in large.CONFIGS] == [
        (c["key"], c["mode"], c["rerank"]) for c in ev.CONFIGS
    ]
    assert large.search_args("expanded") == ("hybrid", False)
    assert large.compute_metrics([1, None])["MRR"] == 0.5
