"""A slow answer explains itself: Muse's retries and route switches show up at /model/activity."""
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider, activity
from app.providers.failover import FailoverProvider
from app.providers.muse import MuseProvider
from app.settings import Settings

META = {"title": "T", "authors": [], "year": None, "venue": "", "doi": ""}


class Service:
    """Fails with each status in `fail` once, then answers."""

    def __init__(self, *fail: int):
        self.fail = list(fail)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.fail:
            return httpx.Response(self.fail.pop(0), json={"error": "busy"})
        msg = {"content": json.dumps(META)}
        return httpx.Response(200, json={"choices": [{"message": msg, "finish_reason": "stop"}]})


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch):
    monkeypatch.setattr("app.providers.muse.time.sleep", lambda s: None)


def test_a_rate_limit_retry_is_noted():
    start = time.time()
    p = MuseProvider("https://x/v1", "k", "m", retries=3, transport=httpx.MockTransport(Service(429, 503)))
    assert p.extract_metadata("page one")["title"] == "T"
    notes = activity.since(start)
    assert [n["kind"] for n in notes] == ["retry", "retry"]
    assert "busy (rate limit)" in notes[0]["text"] and "attempt 2 of 4" in notes[0]["text"]
    assert "server error (503)" in notes[1]["text"] and "attempt 3 of 4" in notes[1]["text"]


def test_switching_routes_is_noted_with_their_names():
    start = time.time()
    down = MuseProvider("https://x/v1", "k", "m", retries=0, transport=httpx.MockTransport(Service(429)))
    up = MuseProvider("https://y/v1", "k", "m", retries=0, transport=httpx.MockTransport(Service()))
    FailoverProvider([("baseten", down), ("meta", up)]).extract_metadata("page one")
    switch = [n for n in activity.since(start) if n["kind"] == "switch"]
    assert len(switch) == 1 and "via Baseten didn't answer" in switch[0]["text"] and "via Meta's API" in switch[0]["text"]


def test_the_endpoint_returns_only_newer_notes(tmp_path):
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), embedder=HashEmbedder())
    client = TestClient(create_app(lib.settings, lib))
    activity.note("retry", "old")
    time.sleep(0.05)  # the clock moves on (coarse on Windows)
    now = client.get("/model/activity").json()["now"]
    activity.note("retry", "Muse is busy (rate limit); trying again in 2 s (attempt 2 of 4).")
    body = client.get("/model/activity", params={"since": now}).json()
    assert [e["text"] for e in body["events"]] == ["Muse is busy (rate limit); trying again in 2 s (attempt 2 of 4)."]
