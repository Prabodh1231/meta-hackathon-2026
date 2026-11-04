"""The backend answers at once: search is keyword search plus the provider, so no search
model loads, nothing is embedded at ingest, and no library is ever re-embedded."""
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings


class ExplodingEmbedder:
    """Any call is a failure: the work that used to embed must not call it any more."""

    id = "exploding"

    def embed(self, texts):
        raise AssertionError("the embedder must not run")


def test_the_library_lists_and_searches_without_a_search_model(tmp_path):
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), reranker=None)
    client = TestClient(create_app(lib.settings, lib))

    h = client.get("/health").json()
    assert h["search"] == "keyword+muse" and "embedder" not in h and "reranker" not in h
    for path in ("/documents", "/folders", "/drafts", "/settings"):
        assert client.get(path).status_code == 200, path
    assert client.get("/settings/search").json() == {"search": "keyword", "ranking": "mock", "model": None}

    assert lib.search("coral bleaching") == []
    note = tmp_path / "note.txt"
    note.write_text("Coral reefs bleach in marine heatwaves.")
    lib.ingest_path(str(note))
    assert lib.search("coral heatwaves")


def test_ingest_stores_no_vectors_and_never_calls_a_passed_embedder(tmp_path):
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(),
                  embedder=ExplodingEmbedder(), reranker=ExplodingEmbedder())
    note = tmp_path / "note.txt"
    note.write_text("Coral reefs bleach in marine heatwaves and recover in shade.")
    [res] = lib.ingest_path(str(note))
    assert res["ok"], res
    assert [r["embedding"] for r in lib.conn.execute("SELECT embedding FROM chunks")] == [None]
    assert lib.search("coral heatwaves")
    assert lib.check_duplicates({"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Unrelated words of my own."}]}]})


def test_reopening_a_library_reembeds_nothing(tmp_path):
    data = tmp_path / "data"
    first = Library(Settings(data_dir=data), provider=MockProvider(), embedder=HashEmbedder(dim=64), reranker=None)
    note = tmp_path / "note.txt"
    note.write_text("Coral reefs bleach in marine heatwaves.")
    first.ingest_path(str(note))
    first.conn.close()

    lib = Library(Settings(data_dir=data), provider=MockProvider(), embedder=ExplodingEmbedder(), reranker=None)
    assert len(lib.list_documents()) == 1 and lib.search("coral heatwaves")
    assert [r["embedding"] for r in lib.conn.execute("SELECT embedding FROM chunks")] == [None]
