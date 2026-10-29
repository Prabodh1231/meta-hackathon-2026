import pytest

from app.embeddings import HashEmbedder
from app.library import Library
from app.providers import MockProvider
from app.settings import Settings

WITH_KEYWORDS = """Mobile Money and Inclusion
Dana Okafor

Abstract. We study mobile money adoption among unbanked households across three countries.
Keywords: mobile money; financial inclusion; adoption; Sub-Saharan Africa
JEL classification: G21, O16

1. Introduction
Mobile money lets people send funds without a bank account.
"""

WITHOUT_KEYWORDS = """Reef Fieldwork Notes
Dana Okafor

Coral bleaching was visible on the shallow flats after the marine heatwave in March.
"""


class Spy(MockProvider):
    """Counts model tagging calls and keeps the text each folder-scoring call was given."""

    def __init__(self):
        self.tag_calls = 0
        self.scored_text = []

    def tag_document(self, title, text):
        self.tag_calls += 1
        return ["model tag"]

    def score_folders(self, title, summary, text, folders):
        self.scored_text.append(text)
        return {f: 80 for f in folders}


@pytest.fixture
def lib(tmp_path):
    return Library(Settings(data_dir=tmp_path / "data"), provider=Spy(), embedder=HashEmbedder())


def add(lib, tmp_path, name, text):
    f = tmp_path / name
    f.write_text(text, encoding="utf-8")
    [res] = lib.ingest_path(str(f))
    assert res["ok"], res
    return res["document"]


def test_printed_keywords_and_jel_codes_are_stored_on_the_document(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", WITH_KEYWORDS)
    assert doc["keywords"] == ["mobile money", "financial inclusion", "adoption", "sub-saharan africa"]
    assert [j["code"] for j in doc["jel_codes"]] == ["G21", "O16"]
    assert doc["jel_codes"][0]["area"] == "Financial Economics"


def test_a_paper_with_its_own_keywords_is_tagged_without_a_model_call(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", WITH_KEYWORDS)
    assert lib.provider.tag_calls == 0
    assert doc["tags"] == sorted(["mobile money", "financial inclusion", "adoption", "sub-saharan africa"])


def test_a_paper_without_keywords_is_still_tagged_by_the_model(lib, tmp_path):
    doc = add(lib, tmp_path, "b.txt", WITHOUT_KEYWORDS)
    assert lib.provider.tag_calls == 1
    assert doc["tags"] == ["model tag"]
    assert doc["keywords"] == [] and doc["jel_codes"] == []


def test_the_folder_scoring_model_is_shown_the_authors_keywords_and_jel(lib, tmp_path):
    add(lib, tmp_path, "a.txt", WITH_KEYWORDS)
    lib.create_folder("Digital finance")
    seen = lib.provider.scored_text[0]
    assert "Keywords: mobile money; financial inclusion" in seen
    assert "JEL: G21 (Financial Economics); O16 (Economic Development" in seen


def test_a_library_from_before_keywords_are_filled_in_once_at_startup(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    first = Library(settings, provider=Spy(), embedder=HashEmbedder())
    doc = add(first, tmp_path, "a.txt", WITH_KEYWORDS)
    with first.conn:  # what a library from before this feature looks like
        first.conn.execute("UPDATE documents SET keywords = '[]', jel_codes = '[]'")
        first.conn.execute("DELETE FROM meta WHERE key = 'keywords_backfill'")
    first.conn.close()

    second = Library(settings, provider=Spy(), embedder=HashEmbedder())
    got = second.get_document(doc["id"])
    assert got["keywords"][0] == "mobile money"
    assert [j["code"] for j in got["jel_codes"]] == ["G21", "O16"]
    assert second.provider.tag_calls == 0  # local only
