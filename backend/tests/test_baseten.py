"""Reranking on Baseten, against a fake deployment (no network). Embeddings always run locally."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import retrieval
from app.embeddings import HashEmbedder, make_embedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.retrieval import BasetenReranker, baseten_base, make_reranker
from app.settings import Settings, read_env_file

KEY = "b10_test-key-1234567890"


class FakeBaseten:
    """Answers /rerank by text length. Can fail the next few calls, and records every request."""

    def __init__(self, fail_next: int = 0, status: int = 503):
        self.requests: list[tuple[str, dict, str]] = []
        self.fail_next, self.status = fail_next, status

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append((request.url.path, body, request.headers.get("authorization", "")))
        if self.fail_next:
            self.fail_next -= 1
            return httpx.Response(self.status)
        if request.url.path.endswith("/rerank"):
            ranked = sorted(range(len(body["texts"])), key=lambda i: -len(body["texts"][i]))
            return httpx.Response(200, json=[{"index": i, "score": float(len(body["texts"][i]))} for i in ranked])
        return httpx.Response(404)


@pytest.fixture
def fake(monkeypatch):
    """Every httpx.Client the Baseten reranker makes talks to one fake deployment."""
    server = FakeBaseten()
    real = httpx.Client

    def client(**kw):
        kw["transport"] = httpx.MockTransport(server)
        return real(**kw)

    monkeypatch.setattr(retrieval.httpx, "Client", client)
    monkeypatch.setattr(retrieval.time, "sleep", lambda s: None)  # retries don't wait in tests
    return server


def test_model_id_or_any_address_gives_the_base_url():
    base = "https://model-abcd1234.api.baseten.co/environments/production/sync"
    assert baseten_base("abcd1234") == base
    for url in (base, base + "/", base + "/v1", base + "/rerank", base + "/predict"):
        assert baseten_base(url) == base
    with pytest.raises(ValueError):
        baseten_base("https://example.com/rerank")


def test_reranker_scores_follow_the_input_order(fake):
    r = BasetenReranker("abcd1234", KEY)
    assert r.score("q", ["aa", "a", "aaaa"]) == [2.0, 1.0, 4.0]
    assert fake.requests[0][0].endswith("/rerank") and fake.requests[0][1] == {"query": "q", "texts": ["aa", "a", "aaaa"]}
    assert fake.requests[0][2] == f"Api-Key {KEY}"


def test_a_waking_deployment_is_retried(fake):
    fake.fail_next = 2  # 503 twice while it scales up from zero
    assert BasetenReranker("abcd1234", KEY).score("q", ["a"]) == [1.0]
    assert len(fake.requests) == 3


def test_a_wrong_key_is_not_retried(fake):
    fake.fail_next, fake.status = 1, 401
    with pytest.raises(httpx.HTTPStatusError):
        BasetenReranker("abcd1234", KEY).score("q", ["a"])
    assert len(fake.requests) == 1


def test_auto_reranks_on_baseten_only_when_a_reranker_is_deployed_there(fake, tmp_path):
    assert isinstance(make_reranker("auto", tmp_path, "abcd1234", KEY), BasetenReranker)
    assert isinstance(make_reranker("baseten", tmp_path, "abcd1234", KEY), BasetenReranker)
    assert not isinstance(make_reranker("local", tmp_path, "abcd1234", KEY), BasetenReranker)
    assert not isinstance(make_reranker("auto", tmp_path), BasetenReranker)


@pytest.mark.parametrize("old", ["auto", "local", "baseten", "bge-m3", "gpu"])
def test_every_embedder_setting_from_older_versions_means_the_local_model(old, tmp_path, monkeypatch):
    class Small(HashEmbedder):  # stands in for bge-small, so no model downloads
        def __init__(self, _cache_dir):
            super().__init__(dim=384)

    monkeypatch.setattr("app.embeddings.FastEmbedder", Small)
    assert make_embedder(old, tmp_path).dim == 384
    assert make_embedder("hash", tmp_path).dim == 512


@pytest.fixture
def lib(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", embedder="hash", reranker="local")
    return Library(settings, provider=MockProvider(), embedder=HashEmbedder(), reranker=None)


def test_settings_show_the_models_without_the_key(lib):
    client = TestClient(create_app(lib.settings, lib))
    s = client.get("/settings/search").json()
    assert s["embedder"] == "hash-512" and s["where"] == "local" and s["has_key"] is False
    assert set(s) == {"where", "embedder", "reranker", "reranker_on", "has_key", "key_hint", "rerank_model"}


def test_reranking_on_baseten_is_checked_written_and_used_at_once(lib, fake):
    client = TestClient(create_app(lib.settings, lib))
    assert client.put("/settings/search", json={"where": "baseten"}).status_code == 400  # nothing set up yet
    r = client.put("/settings/search", json={"where": "baseten", "api_key": KEY, "rerank_model": "efgh5678"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert KEY not in r.text and body["key_hint"] == KEY[-4:]
    assert body["reranker_on"] == "baseten" and isinstance(lib.reranker, BasetenReranker)
    assert body["embedder"] == "hash-512"  # embeddings don't move
    env = read_env_file(lib.settings.data_dir / ".env")
    assert env == {"RC_RERANKER": "baseten", "BASETEN_RERANK_MODEL": "efgh5678", "BASETEN_API_KEY": KEY}
    assert all(p.endswith("/rerank") for p, _, _ in fake.requests)


def test_a_deployment_that_does_not_answer_changes_nothing(lib, fake):
    client = TestClient(create_app(lib.settings, lib))
    fake.fail_next, fake.status = 1, 404
    r = client.put("/settings/search", json={"where": "baseten", "api_key": KEY, "rerank_model": "efgh5678"})
    assert r.status_code == 400 and "didn't answer" in r.json()["detail"]
    assert not (lib.settings.data_dir / ".env").exists() and lib.settings.reranker == "local"
