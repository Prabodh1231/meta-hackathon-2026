import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings


class FlakyProvider(MockProvider):
    """The mock, except that its model calls fail while `down` is set (Muse unreachable or rate
    limited), and summaries wait for `gate` (to hold files mid-import)."""

    def __init__(self):
        self.down = False
        self.gate = threading.Event()
        self.gate.set()

    def _check(self):
        if self.down:
            raise RuntimeError("Muse API error 429: rate limited")

    def extract_metadata(self, text):
        self._check()
        return super().extract_metadata(text)

    def summarize(self, title, text):
        self.gate.wait(10)
        self._check()
        return super().summarize(title, text)

    def tag_document(self, title, text):
        self._check()
        return super().tag_document(title, text)


@pytest.fixture
def setup(tmp_path):
    provider = FlakyProvider()
    settings = Settings(data_dir=tmp_path / "data")
    client = TestClient(create_app(settings, Library(settings, provider=provider, embedder=HashEmbedder())))
    return client, provider


def write_notes(folder, n):
    folder.mkdir(exist_ok=True)
    for i in range(n):
        (folder / f"note{i}.md").write_text(
            f"# Reef survey {i}\n\nCorals at site {i} bleached after weeks of warm water in the lagoon. "
            "Recovery took two seasons where shading reduced light stress.", encoding="utf-8")
    return folder


def wait_for(client, job_id, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/ingest/jobs/{job_id}").json()
        if job["finished_at"]:
            return job
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} didn't finish: {job}")


def test_a_job_reports_every_file_and_adds_them(setup, tmp_path):
    client, _ = setup
    folder = write_notes(tmp_path / "notes", 3)
    job = client.post("/ingest/jobs", json={"paths": [str(folder), str(tmp_path / "gone.pdf"), ""]}).json()
    assert job["state"] in ("queued", "listing", "running")  # answers at once, before reading anything

    job = wait_for(client, job["id"])
    assert job["state"] == "done" and job["total"] == 5
    assert (job["done"], job["failed"], job["incomplete"]) == (3, 2, 0)
    done = [f for f in job["files"] if f["state"] == "done"]
    assert {f["name"] for f in done} == {"note0.md", "note1.md", "note2.md"}
    assert all(f["document_id"] and f["title"].startswith("Reef survey") for f in done)
    assert sorted(f["error"] for f in job["files"] if f["state"] == "failed") == ["Empty path", "No such file or folder"]
    assert len(client.get("/documents").json()) == 3
    assert client.get("/ingest/jobs").json()[0]["id"] == job["id"]


def test_a_failed_model_call_keeps_the_file_and_is_retried(setup, tmp_path):
    client, provider = setup
    provider.down = True
    folder = write_notes(tmp_path / "notes", 2)
    job = wait_for(client, client.post("/ingest/jobs", json={"paths": [str(folder)]}).json()["id"])
    # Stored and searchable anyway, with what's owed listed; the end-of-job retry also failed.
    assert job["done"] == 2 and job["failed"] == 0 and job["incomplete"] == 2
    docs = client.get("/documents").json()
    assert all(set(d["missing"]) == {"metadata", "summary", "tags"} and d["summary"] == "" for d in docs)
    assert client.get("/search", params={"q": "bleached lagoon"}).json()

    provider.down = False
    assert client.post("/library/fill-missing", json={}).json() == {"filled": 2, "still_missing": 0}
    docs = client.get("/documents").json()
    assert all(d["missing"] == [] and d["summary"] and d["tags"] for d in docs)


def test_fill_missing_never_overwrites_what_the_user_corrected(setup, tmp_path):
    client, provider = setup
    provider.down = True
    f = tmp_path / "plain.txt"
    f.write_text("Coral heat stress notes.\n\nCorals bleached after weeks of warm water in the lagoon.", encoding="utf-8")
    [res] = client.post("/ingest/path", json={"path": str(f)}).json()["results"]
    doc = res["document"]
    assert doc["title"] == "Coral heat stress notes." and "summary" in doc["missing"]
    client.patch(f"/documents/{doc['id']}", json={"title": "My own title"})
    provider.down = False
    client.post("/library/fill-missing", json={"doc_ids": [doc["id"]]})
    doc = client.get(f"/documents/{doc['id']}").json()
    assert doc["title"] == "My own title" and doc["summary"] and doc["missing"] == []


def test_re_adding_while_muse_is_down_keeps_the_good_summary(setup, tmp_path):
    client, provider = setup
    f = write_notes(tmp_path / "notes", 1) / "note0.md"
    [first] = client.post("/ingest/path", json={"path": str(f)}).json()["results"]
    summary = first["document"]["summary"]
    assert summary and first["document"]["missing"] == []

    provider.down = True
    [again] = client.post("/ingest/path", json={"path": str(f)}).json()["results"]
    assert again["ok"] and again["document"]["id"] == first["document"]["id"]
    assert again["document"]["summary"] == summary and again["document"]["missing"] == []


def test_cancelling_skips_the_files_not_started(setup, tmp_path):
    client, provider = setup
    provider.gate.clear()  # files stop at their summary until released
    folder = write_notes(tmp_path / "notes", 7)
    job_id = client.post("/ingest/jobs", json={"paths": [str(folder)]}).json()["id"]
    end = time.time() + 10
    while sum(f["state"] == "working" for f in client.get(f"/ingest/jobs/{job_id}").json()["files"]) < 4:
        assert time.time() < end, "files never started"
        time.sleep(0.05)
    working = client.get(f"/ingest/jobs/{job_id}").json()["files"]
    assert {f["stage"] for f in working if f["state"] == "working"} == {"analysing"}

    assert client.post(f"/ingest/jobs/{job_id}/cancel").json()["cancelled"]
    provider.gate.set()
    job = wait_for(client, job_id)
    assert job["state"] == "cancelled" and (job["done"], job["skipped"]) == (4, 3)
    assert len(client.get("/documents").json()) == 4
    assert client.get("/ingest/jobs/999").status_code == 404
