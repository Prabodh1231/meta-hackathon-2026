"""Muse goes through Meta's Model API only; reranking runs on this computer (no network)."""
import pytest
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder, make_embedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider, make_provider
from app.providers.muse import MuseProvider
from app.retrieval import make_reranker
from app.settings import Settings


def test_muse_goes_to_metas_model_api(tmp_path):
    p = make_provider(Settings(data_dir=tmp_path, provider="muse", muse_api_key="meta-key"))
    assert isinstance(p, MuseProvider)
    assert p.model == "muse-spark-1.3" and str(p.client.base_url).startswith("https://api.meta.ai/v1")


def test_muse_needs_the_meta_key(tmp_path):
    with pytest.raises(ValueError):
        make_provider(Settings(data_dir=tmp_path, provider="muse"))


def test_old_baseten_settings_are_ignored(tmp_path, monkeypatch):
    for name in ("MUSE_API_KEY", "MODEL_API_KEY", "RC_PROVIDER", "RC_RERANKER"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RC_DATA_DIR", str(tmp_path))
    (tmp_path / ".env").write_text("RC_PROVIDER=muse\nMUSE_API_KEY=meta-key\nMUSE_ROUTE=baseten\n"
                                   "BASETEN_API_KEY=bt-key\nRC_RERANKER=baseten\n", encoding="utf-8")
    s = Settings.from_env()
    assert isinstance(make_provider(s), MuseProvider) and s.reranker == "baseten"


@pytest.mark.parametrize("old", ["auto", "local", "baseten"])
def test_reranker_values_from_older_versions_mean_the_local_one(tmp_path, monkeypatch, old):
    made = []
    monkeypatch.setattr("app.retrieval.CrossEncoderReranker", lambda cache, model, path: made.append(model) or object())
    assert make_reranker(old, tmp_path) is not None and made == ["Xenova/ms-marco-MiniLM-L-6-v2"]


@pytest.mark.parametrize("old", ["auto", "local", "baseten", "bge-m3", "gpu"])
def test_every_embedder_setting_from_older_versions_means_the_local_model(old, tmp_path, monkeypatch):
    class Small(HashEmbedder):  # stands in for bge-small, so no model downloads
        def __init__(self, _cache_dir, path=None):
            super().__init__(dim=384)

    monkeypatch.setattr("app.embeddings.FastEmbedder", Small)
    assert make_embedder(old, tmp_path).dim == 384
    assert make_embedder("hash", tmp_path).dim == 512


def test_settings_show_the_search_models(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", embedder="hash", reranker="local")
    lib = Library(settings, provider=MockProvider(), embedder=HashEmbedder(), reranker=None)
    client = TestClient(create_app(lib.settings, lib))
    assert client.get("/settings/search").json() == {"embedder": "hash-512", "reranker": None}
    assert client.put("/settings/search", json={"where": "local"}).status_code == 405  # nothing to set any more
