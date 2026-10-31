import os
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.openaccess import Record
from app.providers import MockProvider
from app.settings import Settings
from tests.test_dupfiles import prose
from tests.test_enrich import FakeIndex


@pytest.fixture
def lib(tmp_path):
    return Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), embedder=HashEmbedder())


@pytest.fixture
def client(lib):
    return TestClient(create_app(lib.settings, lib))


def add(client, path) -> dict:
    [res] = client.post("/ingest/path", json={"path": str(path)}).json()["results"]
    assert res["ok"], res
    return res["document"]


def backdate(lib, doc_id, when="2020-01-01 00:00:00"):
    """Added well before anything the test removes (timestamps only have whole seconds)."""
    with lib.conn:
        lib.conn.execute("UPDATE documents SET added_at = ? WHERE id = ?", (when, doc_id))


def test_a_file_is_dated_by_when_it_reached_this_computer(client, tmp_path):
    f = tmp_path / "okafor.md"
    f.write_text(prose(1), encoding="utf-8")
    march = datetime(2024, 3, 15, 12, tzinfo=timezone.utc).timestamp()
    os.utime(f, (march, march))  # a copy keeps the download's modification time
    doc = add(client, f)
    assert doc["file_date"].startswith("2024-03-15")
    assert doc["added_at"] > doc["file_date"]
    assert len(doc["sha256"]) == 64


def test_removing_a_duplicate_keeps_a_record_of_it(client, lib, tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    text = prose(2)
    (tmp_path / "a" / "paper.md").write_text(text, encoding="utf-8")
    (tmp_path / "b" / "paper.md").write_text(text, encoding="utf-8")
    kept, dup = add(client, tmp_path / "a" / "paper.md"), add(client, tmp_path / "b" / "paper.md")
    client.patch(f"/documents/{kept['id']}", json={"title": "Mobile money and savings"})
    client.patch(f"/documents/{dup['id']}", json={"title": "My corrected title", "year": 2019})
    client.post("/folders", json={"name": "Digital finance", "similarity": 100})
    client.post(f"/documents/{dup['id']}/folders", json={"name": "Digital finance"})
    backdate(lib, kept["id"])
    backdate(lib, dup["id"])

    r = client.delete(f"/documents/{dup['id']}", params={"reason": "duplicate", "duplicate_of": kept["id"], "trashed": True})
    assert r.status_code == 200
    assert dup["id"] not in {d["id"] for d in client.get("/documents").json()}
    [entry] = client.get("/library/removed").json()
    assert entry["id"] == dup["id"]
    assert entry["reason"] == "duplicate"
    assert entry["duplicate_of"] == kept["id"]
    assert entry["duplicate_of_title"] == "Mobile money and savings"
    assert entry["file_trashed"] is True
    assert entry["added_at"] == "2020-01-01 00:00:00"
    assert entry["removed_at"] >= entry["added_at"]
    assert entry["title"] == "My corrected title"
    assert entry["edited_fields"] == {"title": "My corrected title", "year": 2019}
    assert entry["folders"] == ["Digital finance"]
    assert entry["sha256"] == dup["sha256"]
    assert entry["restorable"] is True  # the file is still there (the Recycle Bin is the app's job)


def test_an_unknown_reason_is_refused(client, tmp_path):
    f = tmp_path / "p.md"
    f.write_text(prose(3), encoding="utf-8")
    doc = add(client, f)
    assert client.delete(f"/documents/{doc['id']}", params={"reason": "boredom"}).status_code == 400
    assert client.get(f"/documents/{doc['id']}").status_code == 200


def test_restoring_brings_back_the_same_id_date_corrections_and_folders(client, lib, tmp_path):
    f = tmp_path / "p.md"
    f.write_text(prose(4), encoding="utf-8")
    doc = add(client, f)
    backdate(lib, doc["id"], "2024-03-10 09:00:00")
    client.patch(f"/documents/{doc['id']}", json={"title": "Fixed title", "authors": ["Okafor, A."]})
    client.post("/folders", json={"name": "Savings", "similarity": 100})
    client.post(f"/documents/{doc['id']}/folders", json={"name": "Savings"})
    client.delete(f"/documents/{doc['id']}")

    back = client.post(f"/library/removed/{doc['id']}/restore").json()
    assert back["id"] == doc["id"]  # citations in drafts point at this id
    assert back["added_at"] == "2024-03-10 09:00:00"
    assert back["title"] == "Fixed title"
    assert back["authors"] == ["Okafor, A."]
    assert set(back["edited_fields"]) == {"title", "authors"}
    assert [x["name"] for x in back["folders"] if x["state"] == "user"] == ["Savings"]
    assert client.get("/library/removed").json() == []
    assert client.get(f"/documents/{doc['id']}/pages/1").status_code == 200  # text is searchable again


def test_a_file_that_is_gone_cannot_be_restored(client, tmp_path):
    f = tmp_path / "p.md"
    f.write_text(prose(5), encoding="utf-8")
    doc = add(client, f)
    client.delete(f"/documents/{doc['id']}")
    f.unlink()
    [entry] = client.get("/library/removed").json()
    assert entry["file_exists"] is False and entry["restorable"] is False
    r = client.post(f"/library/removed/{doc['id']}/restore")
    assert r.status_code == 404 and "no longer at" in r.json()["detail"]
    assert client.delete(f"/library/removed/{doc['id']}").status_code == 200  # forget it
    assert client.get("/library/removed").json() == []


def test_a_removed_file_added_again_is_recognised(client, lib, tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    text = prose(6)
    (tmp_path / "a" / "paper.md").write_text(text, encoding="utf-8")
    (tmp_path / "b" / "paper.md").write_text(text, encoding="utf-8")
    kept, dup = add(client, tmp_path / "a" / "paper.md"), add(client, tmp_path / "b" / "paper.md")
    backdate(lib, kept["id"])
    backdate(lib, dup["id"])
    client.delete(f"/documents/{dup['id']}", params={"reason": "duplicate", "duplicate_of": kept["id"]})

    # The copy kept was in the library all along: it wasn't removed and added again.
    assert client.get(f"/documents/{kept['id']}").json()["previously_removed"] is None
    [entry] = client.get("/library/removed").json()
    assert entry["back_in_library"] is None

    again = add(client, tmp_path / "b" / "paper.md")
    assert again["id"] != dup["id"]
    seen = again["previously_removed"]
    assert seen["id"] == dup["id"] and seen["reason"] == "duplicate" and seen["duplicate_of"] == kept["id"]
    [entry] = client.get("/library/removed").json()
    assert entry["back_in_library"] == again["id"] and entry["restorable"] is False
    assert client.post(f"/library/removed/{dup['id']}/restore").status_code == 400


def test_publication_dates_must_match_the_year(tmp_path):
    index = FakeIndex({
        "10.1/known": Record(published="2024-03-02"),
        "10.1/preprint": Record(published="2019-11-01"),  # the paper says 2020: a different version
        "10.1/noyear": Record(published="2018-06", year=2018),
        "10.1/yearonly": Record(published="", year=2022),
    })
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), embedder=HashEmbedder(), open_access=index)
    client = TestClient(create_app(lib.settings, lib))
    ids = {}
    for i, (doi, year) in enumerate([("10.1/known", 2024), ("10.1/preprint", 2020), ("10.1/noyear", None), ("10.1/yearonly", 2022)]):
        f = tmp_path / f"p{i}.md"
        f.write_text(prose(10 + i), encoding="utf-8")
        d = add(client, f)
        with lib.conn:
            lib.conn.execute("UPDATE documents SET doi = ?, year = ? WHERE id = ?", (doi, year, d["id"]))
        ids[doi] = d["id"]

    assert client.post("/library/enrich", json={}).json()["dates"] == 2
    doc = lambda doi: client.get(f"/documents/{ids[doi]}").json()  # noqa: E731
    assert doc("10.1/known")["published"] == "2024-03-02"
    assert doc("10.1/preprint")["published"] == ""
    assert doc("10.1/noyear")["published"] == "2018-06" and doc("10.1/noyear")["year"] == 2018
    assert doc("10.1/yearonly")["published"] == "" and doc("10.1/yearonly")["published_checked"] is True

    # Correcting the year drops a date looked up for the wrong one.
    assert client.patch(f"/documents/{ids['10.1/known']}", json={"year": 2023}).json()["published"] == ""
