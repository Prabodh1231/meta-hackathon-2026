import sqlite3

import pytest
from fastapi.testclient import TestClient

from app import db
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.retrieval import fts_query, reciprocal_rank_fusion
from app.settings import Settings

NOTEBOOK = """# Lab notebook
Protocol P-17 replaced the old cueing script; volume is now fixed at 42 dB.
Participant S-208 reported hearing the cues during the night.
"""
STUDY = """# Sleep study
Replaying sounds during slow-wave sleep improved recall of cued word pairs.
Spindle bursts after each cue predicted which pairs were remembered.
"""


class RankingProvider(MockProvider):
    """Scores by whether the passage contains a marker word, and counts its search calls:
    lets a test see the provider's ranking win over the fused keyword order."""

    def __init__(self, marker: str):
        self.marker = marker
        self.expand_calls = 0
        self.rank_calls = 0

    def expand_query(self, query):
        self.expand_calls += 1
        return []

    def rank_passages(self, query, passages):
        self.rank_calls += 1
        return [1.0 if self.marker in text else 0.0 for _, text in passages]


@pytest.fixture
def lib(tmp_path):
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider())
    for name, text in [("notebook.md", NOTEBOOK), ("study.md", STUDY)]:
        (tmp_path / name).write_text(text, encoding="utf-8")
        lib.ingest_path(str(tmp_path / name))
    return lib


def fts_count(lib, term):
    return lib.conn.execute("SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH ?", (f'"{term}"',)).fetchone()[0]


def test_fts_query_keeps_identifiers_and_drops_function_words():
    assert fts_query("What changed in protocol P-17?") == '"changed" OR "protocol" OR "P-17"'
    assert fts_query("EA-2024-031 and 3-back at 36.5") == '"EA-2024-031" OR "3-back" OR "36.5"'
    assert fts_query('the "of" a') == ""


def test_keyword_search_finds_exact_identifiers(lib):
    hits = lib.search("What happened with S-208?", k=3, mode="keyword")
    assert "S-208" in hits[0]["text"]
    assert lib.search("P-17", k=3, mode="keyword")[0]["text"].count("P-17") == 1


def test_keyword_index_follows_reingest_and_delete(lib, tmp_path):
    assert fts_count(lib, "S-208") == 1
    (tmp_path / "notebook.md").write_text("# Lab notebook\nNothing about that participant now.\n", encoding="utf-8")
    lib.ingest_path(str(tmp_path / "notebook.md"))
    assert fts_count(lib, "S-208") == 0 and fts_count(lib, "participant") == 1
    doc = next(d for d in lib.list_documents() if d["title"] == "Lab notebook")
    lib.delete_document(doc["id"])  # chunks go by ON DELETE CASCADE; the trigger must still fire
    assert fts_count(lib, "participant") == 0


def test_existing_library_gets_keyword_index_on_upgrade(tmp_path):
    path = tmp_path / "old.db"
    conn = db.connect(path)
    conn.execute("INSERT INTO documents (id, source, kind) VALUES (1, 'a.md', 'text')")
    conn.execute("INSERT INTO chunks (doc_id, page, start, end, text) VALUES (1, 1, 0, 5, 'Durusdinium shuffling')")
    conn.commit()
    # Simulate a library from before keyword search existed.
    conn.executescript("DROP TRIGGER chunks_fts_insert; DROP TRIGGER chunks_fts_delete; "
                       "DROP TRIGGER chunks_fts_update; DROP TABLE chunks_fts;")
    conn.close()
    upgraded = db.connect(path)
    assert upgraded.execute("SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH 'Durusdinium'").fetchone()[0] == 1


def test_reciprocal_rank_fusion_rewards_agreement():
    fused = reciprocal_rank_fusion([1, 2, 3], [3, 1, 4])
    assert [cid for cid, _ in fused][:2] == [1, 3]  # in both lists near the top
    assert {cid for cid, _ in fused} == {1, 2, 3, 4}


def test_search_uses_provider_ranking_order(lib):
    lib.provider = RankingProvider("Spindle")
    hits = lib.search("cue", k=2, mode="hybrid")
    assert "Spindle" in hits[0]["text"]
    assert (lib.provider.expand_calls, lib.provider.rank_calls) == (1, 1)


def test_keyword_mode_makes_no_provider_calls(lib):
    lib.provider = RankingProvider("Spindle")
    hits = lib.search("S-208", k=3, mode="keyword")
    assert "S-208" in hits[0]["text"]
    assert (lib.provider.expand_calls, lib.provider.rank_calls) == (0, 0)


def test_expansion_without_ranking_expands_but_does_not_rank(lib):
    lib.provider = RankingProvider("Spindle")
    hits = lib.search("cue", k=2, mode="hybrid", rerank=False)
    assert hits and (lib.provider.expand_calls, lib.provider.rank_calls) == (1, 0)


def test_expanded_queries_are_fused_into_results(lib):
    class ExpandingProvider(MockProvider):
        def __init__(self):
            self.rank_calls = 0

        def expand_query(self, query):
            return ["spindle bursts"]

        def rank_passages(self, query, passages):
            self.rank_calls += 1
            return None

    lib.provider = ExpandingProvider()
    hits = lib.search("unmatchedword", k=3, rerank=False)
    assert hits and "Spindle" in hits[0]["text"] and lib.provider.rank_calls == 0


def test_ranking_failure_keeps_the_fused_keyword_order(lib):
    class FailingProvider(MockProvider):
        def expand_query(self, query):
            return []

        def rank_passages(self, query, passages):
            raise RuntimeError("ranking unavailable")

    expected = lib.search("cue", k=2, mode="keyword")
    lib.provider = FailingProvider()
    hits = lib.search("cue", k=2)
    assert [h["id"] for h in hits] == [h["id"] for h in expected]


def test_mock_search_helpers_are_deterministic():
    provider = MockProvider()
    queries = provider.expand_query("sleep memory recall")
    assert queries == provider.expand_query("sleep memory recall") and 2 <= len(queries) <= 4
    scores = provider.rank_passages(
        "coral bleaching heatwave",
        [(7, "Coral bleaching followed the marine heatwave."), (9, "Sleep spindles predicted recall.")],
    )
    assert len(scores) == 2 and scores[0] > scores[1]


def test_cite_sentence_choice_uses_word_overlap(lib):
    out = lib.suggest_citations("Spindle bursts after each cue predicted which pairs were remembered.")
    assert out and "Spindle bursts" in out[0]["quote"] and out[0]["status"] == "verified"


def test_scope_applies_to_keyword_results(lib):
    study = next(d for d in lib.list_documents() if d["title"] == "Sleep study")
    hits = lib.search("P-17 cue", k=5, doc_ids=[study["id"]], mode="hybrid")
    assert hits and all(h["doc_id"] == study["id"] for h in hits)


def test_unknown_mode_is_rejected(lib):
    with pytest.raises(ValueError):
        lib.search("x", mode="psychic")


def test_health_reports_keyword_plus_muse_search(tmp_path):
    settings = Settings(data_dir=tmp_path / "d")
    client = TestClient(create_app(settings, Library(settings, provider=MockProvider())))
    h = client.get("/health").json()
    assert h["search"] == "keyword+muse" and "embedder" not in h and "reranker" not in h
