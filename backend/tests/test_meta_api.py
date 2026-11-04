"""Muse goes through Meta's Model API only; search ranking goes through the provider layer."""
import pytest
from fastapi.testclient import TestClient

from app.library import Library
from app.main import create_app
from app.providers import MockProvider, make_provider
from app.providers.muse import MuseProvider
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
    assert isinstance(make_provider(s), MuseProvider)
    assert not hasattr(s, "embedder") and not hasattr(s, "reranker") and not hasattr(s, "models_dir")


def test_settings_show_how_search_works(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    lib = Library(settings, provider=MockProvider())
    client = TestClient(create_app(lib.settings, lib))
    assert client.get("/settings/search").json() == {"search": "keyword", "ranking": "mock", "model": None}
    assert client.put("/settings/search", json={"where": "local"}).status_code == 405  # nothing to set any more
