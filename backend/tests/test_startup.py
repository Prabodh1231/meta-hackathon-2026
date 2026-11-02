"""The backend answers while the embedding model is still loading; only embedding waits for it."""
import threading

import pytest
from fastapi.testclient import TestClient

from app import library as library_module
from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings


@pytest.fixture
def slow_model(monkeypatch):
    """make_embedder blocks until the test lets it finish (or fail), like BGE-M3 loading."""
    gate = {"release": threading.Event(), "fail": False}

    def make(*_args, **_kwargs):
        gate["release"].wait(10)
        if gate["fail"]:
            raise OSError("no such model")
        return HashEmbedder()

    monkeypatch.setattr(library_module, "make_embedder", make)
    return gate


def test_the_library_lists_while_the_model_loads(tmp_path, slow_model):
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), reranker=None)
    client = TestClient(create_app(lib.settings, lib))

    h = client.get("/health").json()
    assert (h["embedder"], h["embedder_device"]) == ("loading", "")
    for path in ("/documents", "/folders", "/drafts", "/settings"):
        assert client.get(path).status_code == 200, path
    assert client.get("/settings/search").json()["embedder"] == "loading"

    # Something that embeds waits for the model instead of failing.
    found = {}
    search = threading.Thread(target=lambda: found.setdefault("hits", lib.search("coral bleaching")))
    search.start()
    search.join(0.3)
    assert search.is_alive()
    slow_model["release"].set()
    search.join(5)
    assert found["hits"] == []

    assert client.get("/health").json()["embedder"] == "hash-512"


def test_a_model_that_fails_to_load_is_reported_not_replaced(tmp_path, slow_model):
    slow_model["fail"] = True
    slow_model["release"].set()
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), reranker=None)
    with pytest.raises(RuntimeError, match="search model couldn't load"):
        lib.embedder.embed(["anything"])
    client = TestClient(create_app(lib.settings, lib))
    assert client.get("/health").json()["embedder"] == "failed"
    assert client.get("/documents").status_code == 200


def test_a_new_model_reembeds_before_it_is_used(tmp_path, slow_model):
    data = tmp_path / "data"
    first = Library(Settings(data_dir=data), provider=MockProvider(), embedder=HashEmbedder(dim=64), reranker=None)
    note = data / "note.txt"
    note.write_text("Coral reefs bleach in marine heatwaves.")
    first.ingest_path(str(note))
    first.conn.close()

    slow_model["release"].set()
    lib = Library(Settings(data_dir=data), provider=MockProvider(), reranker=None)
    assert lib.embedder.id == "hash-512"  # waits for the load, which re-embedded with the new model
    dims = {len(r["embedding"]) for r in lib.conn.execute("SELECT embedding FROM chunks")}
    assert dims == {512 * 4}
    assert lib.search("coral heatwaves")
