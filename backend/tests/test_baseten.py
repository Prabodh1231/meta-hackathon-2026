"""Embeddings and reranking on Baseten, against a fake deployment (no network)."""
import json

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import embeddings, retrieval
from app.embeddings import HashEmbedder, BasetenEmbedder, baseten_base, make_embedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.retrieval import BasetenReranker, make_reranker
from app.settings import Settings, read_env_file

KEY = "b10_test-key-1234567890"


class FakeBaseten:
    """Answers /v1/embeddings with a vector per text (its length on one axis) and /rerank by text
    length. Can fail the next few calls, and records every request."""

    def __init__(self, fail_next: int = 0, status: int = 503):
        self.requests: list[tuple[str, dict, str]] = []
        self.fail_next, self.status = fail_next, status

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append((request.url.path, body, request.headers.get("authorization", "")))
        if self.fail_next:
            self.fail_next -= 1
            return httpx.Response(self.status)
        if request.url.path.endswith("/v1/embeddings"):
            data = [{"index": i, "embedding": [float(len(t)), 1.0, 0.0]} for i, t in enumerate(body["input"])]
            return httpx.Response(200, json={"data": data[::-1]})  # out of order, as a server may send them
        if request.url.path.endswith("/rerank"):
            ranked = sorted(range(len(body["texts"])), key=lambda i: -len(body["texts"][i]))
            return httpx.Response(200, json=[{"index": i, "score": float(len(body["texts"][i]))} for i in ranked])
        return httpx.Response(404)


@pytest.fixture
def fake(monkeypatch):
    """Every httpx.Client the Baseten classes make talks to one fake deployment."""
    server = FakeBaseten()
    real = httpx.Client

    def client(**kw):
        kw["transport"] = httpx.MockTransport(server)
        return real(**kw)

    monkeypatch.setattr(embeddings.httpx, "Client", client)
    monkeypatch.setattr(embeddings.time, "sleep", lambda s: None)  # retries don't wait in tests
    return server


def test_model_id_or_any_address_gives_the_base_url():
    base = "https://model-abcd1234.api.baseten.co/environments/production/sync"
    assert baseten_base("abcd1234") == base
    for url in (base, base + "/", base + "/v1/embeddings", base + "/v1", base + "/rerank"):
        assert baseten_base(url) == base
    with pytest.raises(ValueError):
        baseten_base("https://example.com/v1/embeddings")


def test_embeddings_keep_their_order_across_batches_and_are_normalized(fake):
    e = BasetenEmbedder("abcd1234", KEY)
    texts = [f"text number {'x' * i}" for i in range(70)]  # three batches of up to 32
    out = e.embed(texts)
    assert out.shape == (70, 3)
    assert np.allclose(np.linalg.norm(out, axis=1), 1.0, atol=1e-5)
    lengths = out[:, 0] / out[:, 1]  # the fake puts each text's length on the first axis
    assert np.allclose(lengths, [len(t) for t in texts], rtol=1e-4)
    assert len(fake.requests) == 3 and all(a == f"Api-Key {KEY}" for _, _, a in fake.requests)
    assert e.id == "st:BAAI/bge-m3" and e.device == "baseten"  # the same vectors as the local GPU model


def test_a_waking_deployment_is_retried(fake):
    fake.fail_next = 2  # 503 twice while it scales up from zero
    assert BasetenEmbedder("abcd1234", KEY).embed(["hello"]).shape == (1, 3)
    assert len(fake.requests) == 3


def test_a_wrong_key_is_not_retried(fake):
    fake.fail_next, fake.status = 1, 401
    with pytest.raises(httpx.HTTPStatusError):
        BasetenEmbedder("abcd1234", KEY).embed(["hello"])
    assert len(fake.requests) == 1


def test_reranker_scores_follow_the_input_order(fake):
    r = BasetenReranker("abcd1234", KEY)
    assert r.score("q", ["aa", "a", "aaaa"]) == [2.0, 1.0, 4.0]
    assert fake.requests[0][0].endswith("/rerank") and fake.requests[0][1] == {"query": "q", "texts": ["aa", "a", "aaaa"]}


def test_auto_uses_baseten_only_without_a_gpu(fake, monkeypatch, tmp_path):
    monkeypatch.setattr(embeddings, "_cuda_available", lambda: False)
    monkeypatch.setattr(retrieval, "_cuda_available", lambda: False)
    assert isinstance(make_embedder("auto", tmp_path, "abcd1234", KEY), BasetenEmbedder)
    assert isinstance(make_reranker("auto", tmp_path, "abcd1234", KEY), BasetenReranker)
    # Without Baseten set up, a CPU machine keeps the small local model (here: whatever loads).
    assert not isinstance(make_embedder("auto", tmp_path), BasetenEmbedder)
    assert not isinstance(make_reranker("auto", tmp_path), BasetenReranker)


def test_auto_falls_back_when_baseten_does_not_answer(fake, monkeypatch, tmp_path):
    monkeypatch.setattr(embeddings, "_cuda_available", lambda: False)
    fake.fail_next, fake.status = 1, 404  # wrong model ID
    assert not isinstance(make_embedder("auto", tmp_path, "abcd1234", KEY), BasetenEmbedder)


@pytest.fixture
def lib(tmp_path, monkeypatch):
    monkeypatch.setattr(embeddings, "_cuda_available", lambda: False)
    monkeypatch.setattr(retrieval, "_cuda_available", lambda: False)
    settings = Settings(data_dir=tmp_path / "data", embedder="hash", reranker="none")
    return Library(settings, provider=MockProvider(), embedder=HashEmbedder(), reranker=None)


def test_settings_show_where_search_runs_without_the_key(lib):
    client = TestClient(create_app(lib.settings, lib))
    s = client.get("/settings/search").json()
    assert s["embedder"] == "hash-512" and s["embedder_on"] == "cpu" and s["has_key"] is False
    assert s["gpu"] is False


def test_switching_to_baseten_checks_it_writes_env_and_swaps_live(lib, fake):
    client = TestClient(create_app(lib.settings, lib))
    assert client.put("/settings/search", json={"where": "baseten"}).status_code == 400  # nothing set up yet
    r = client.put("/settings/search", json={"where": "baseten", "api_key": KEY, "embed_model": "abcd1234",
                                              "rerank_model": "efgh5678"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert KEY not in r.text and body["key_hint"] == KEY[-4:]
    # The hash embedder's vectors aren't BGE-M3's, so moving waits for a restart (which re-embeds);
    # the reranker has no stored vectors and moves at once.
    assert body["restart_needed"] is True and body["embedder"] == "hash-512" and body["embedder_on"] == "cpu"
    assert body["reranker_on"] == "baseten" and isinstance(lib.reranker, BasetenReranker)
    env = read_env_file(lib.settings.data_dir / ".env")
    assert env == {"RC_EMBEDDER": "baseten", "RC_RERANKER": "baseten", "BASETEN_EMBED_MODEL": "abcd1234",
                   "BASETEN_RERANK_MODEL": "efgh5678", "BASETEN_API_KEY": KEY}
    paths = [p for p, _, _ in fake.requests]
    assert any(p.endswith("/v1/embeddings") for p in paths) and any(p.endswith("/rerank") for p in paths)


def test_a_deployment_that_does_not_answer_changes_nothing(lib, fake):
    client = TestClient(create_app(lib.settings, lib))
    fake.fail_next, fake.status = 1, 404
    r = client.put("/settings/search", json={"where": "baseten", "api_key": KEY, "embed_model": "abcd1234"})
    assert r.status_code == 400 and "didn't answer" in r.json()["detail"]
    assert not (lib.settings.data_dir / ".env").exists() and lib.settings.embedder == "hash"


class LocalBgeM3(HashEmbedder):
    """Stands in for BGE-M3 on this computer's GPU: the same id the Baseten deployment has."""

    device = "cuda"

    def __init__(self):
        super().__init__()
        self.id = "st:BAAI/bge-m3"  # HashEmbedder sets its own id per instance


def test_moving_bge_m3_to_baseten_happens_at_once(tmp_path, monkeypatch, fake):
    monkeypatch.setattr(embeddings, "_cuda_available", lambda: False)
    settings = Settings(data_dir=tmp_path / "data", embedder="local", reranker="none")
    lib = Library(settings, provider=MockProvider(), embedder=LocalBgeM3(), reranker=None)
    body = lib.update_search("baseten", KEY, "abcd1234", "")
    assert body["restart_needed"] is False and body["embedder_on"] == "baseten"
    assert isinstance(lib.embedder, BasetenEmbedder)
    assert not isinstance(lib.reranker, BasetenReranker)  # no reranker deployed there: it stays local
