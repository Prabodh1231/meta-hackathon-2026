"""Muse through two services: Baseten first, Meta's API as the backup (no network)."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider, make_provider
from app.providers.failover import FailoverProvider
from app.providers.muse import MuseError, MuseProvider
from app.settings import Settings, read_env_file

META = {"title": "From Meta", "authors": [], "year": None, "venue": "", "doi": ""}


class Service:
    """A fake chat-completions service that answers with `answer`, or fails with `status`."""

    def __init__(self, answer: dict, status: int = 200):
        self.answer, self.status, self.calls = answer, status, 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.status != 200:
            return httpx.Response(self.status, json={"error": "down"})
        msg = {"content": json.dumps(self.answer)}
        return httpx.Response(200, json={"choices": [{"message": msg, "finish_reason": "stop"}]})


def muse(service: Service) -> MuseProvider:
    return MuseProvider("https://x/v1", "k", "m", retries=0, transport=httpx.MockTransport(service))


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch):
    monkeypatch.setattr("app.providers.muse.time.sleep", lambda s: None)


def test_the_first_route_answers_when_it_can():
    baseten, meta = Service({**META, "title": "From Baseten"}), Service(META)
    p = FailoverProvider([("baseten", muse(baseten)), ("meta", muse(meta))])
    assert p.extract_metadata("page one")["title"] == "From Baseten"
    assert (baseten.calls, meta.calls) == (1, 0)


def test_a_failing_route_hands_over_and_rests():
    baseten, meta = Service({}, status=503), Service(META)
    p = FailoverProvider([("baseten", muse(baseten)), ("meta", muse(meta))])
    assert p.extract_metadata("page one")["title"] == "From Meta"
    assert p.extract_metadata("page two")["title"] == "From Meta"
    assert baseten.calls == 1  # resting after its failure: the second request went straight to Meta
    assert p._order()[0][0] == "meta"


def test_a_rested_route_is_tried_again_and_recovers():
    baseten, meta = Service({**META, "title": "From Baseten"}, status=503), Service(META)
    p = FailoverProvider([("baseten", muse(baseten)), ("meta", muse(meta))], cooldown=0.0)
    assert p.extract_metadata("x")["title"] == "From Meta"
    baseten.status = 200
    assert p.extract_metadata("y")["title"] == "From Baseten"


def test_when_every_route_fails_the_error_comes_through():
    p = FailoverProvider([("baseten", muse(Service({}, 503))), ("meta", muse(Service({}, 401)))])
    with pytest.raises(MuseError, match="401"):
        p.extract_metadata("x")


def test_scans_fail_over_too():
    baseten, meta = Service({}, status=500), Service(META)
    meta.answer = "OCR text"  # transcribe_image returns the content as text

    def as_text(request):
        meta.calls += 1
        return httpx.Response(200, json={"choices": [{"message": {"content": "OCR text"}, "finish_reason": "stop"}]})

    p = FailoverProvider([("baseten", muse(baseten)), ("meta", MuseProvider("https://x/v1", "k", "m", retries=0, transport=httpx.MockTransport(as_text)))])
    assert p.transcribe_image(b"png", "image/png") == "OCR text"


def settings(tmp_path, **kw) -> Settings:
    base = dict(data_dir=tmp_path / "d", provider="muse", muse_api_key="meta-key", baseten_api_key="bt-key")
    return Settings(**{**base, **kw})


def test_route_defaults_to_baseten_first_when_both_keys_exist(tmp_path):
    p = make_provider(settings(tmp_path))
    assert isinstance(p, FailoverProvider) and p.route == ["baseten", "meta"]
    assert p.routes[0][1].model == "meta-models/muse-spark-open-1026" and p.routes[1][1].model == "muse-spark-1.3"
    assert all(r.retries == 1 for _, r in p.routes)  # hand over quickly instead of backing off


def test_one_service_means_no_failover(tmp_path):
    assert make_provider(settings(tmp_path, baseten_api_key="")).route == ["meta"]
    assert make_provider(settings(tmp_path, muse_route="baseten")).route == ["baseten"]
    assert make_provider(settings(tmp_path, muse_route="meta")).route == ["meta"]
    with pytest.raises(ValueError):
        make_provider(settings(tmp_path, muse_route="baseten", baseten_api_key=""))


def test_choosing_the_route_in_settings(tmp_path):
    s = settings(tmp_path, provider="mock")
    lib = Library(s, provider=MockProvider(), embedder=HashEmbedder(), reranker=None)
    client = TestClient(create_app(s, lib))
    r = client.put("/settings/model", json={"provider": "muse", "route": "meta"})
    assert r.status_code == 200 and r.json()["routes"] == ["meta"]
    r = client.put("/settings/model", json={"route": "baseten-first"})
    assert r.json()["route"] == "baseten-first" and r.json()["routes"] == ["baseten", "meta"]
    assert client.get("/health").json()["muse_route"] == ["baseten", "meta"]
    assert read_env_file(s.data_dir / ".env")["MUSE_ROUTE"] == "baseten-first"
    assert client.put("/settings/model", json={"route": "sideways"}).status_code == 400
