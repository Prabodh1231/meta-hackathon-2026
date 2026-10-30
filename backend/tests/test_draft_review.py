import json

import pytest
from fastapi.testclient import TestClient

from app import draft_review
from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings

SOURCE = """Coral Reef Bleaching Under Ocean Warming
Dana Okafor

Marine heatwaves in 2016 caused mass coral bleaching across the Great Barrier Reef.
Reefs exposed to prior moderate heat stress showed lower bleaching mortality, suggesting thermal acclimation.
"""


def doc(*blocks) -> dict:
    """Editor JSON from ("h", text), ("p", text) or ("p", text, doc_id) for a paragraph ending in a citation chip."""
    content = []
    for b in blocks:
        if b[0] == "h":
            content.append({"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": b[1]}]})
        else:
            inline = [{"type": "text", "text": b[1]}]
            if len(b) > 2:
                inline.append({"type": "citation", "attrs": {"docId": b[2], "quote": "", "cid": "c1"}})
            content.append({"type": "paragraph", "content": inline})
    return {"type": "doc", "content": content}


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    return TestClient(create_app(settings, Library(settings, provider=MockProvider(), embedder=HashEmbedder())))


def test_blocks_skip_chips_and_read_lists():
    d = doc(("h", "Intro"), ("p", "One claim.", 3))
    d["content"].append({"type": "bulletList", "content": [
        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "A point"}]}]}]})
    bs = draft_review.blocks(d)
    assert [(b.kind, b.text) for b in bs] == [("heading", "Intro"), ("paragraph", "One claim."), ("paragraph", "A point")]
    assert bs[1].cites == [(10, 3)]


def test_compare_reports_each_level():
    old = doc(("h", "Methods"), ("p", "We sampled twelve reefs in 2016 during the heatwave."),
              ("h", "Results"), ("p", "Bleaching was severe on shallow flats."), ("p", "Deep reefs fared better."))
    new = doc(("h", "Methods"), ("p", "We sampled twelve reefs in 2016 during the heatwave."),
              ("h", "Results"), ("p", "Bleaching was very severe on the shallow flats."),
              ("h", "Discussion"), ("p", "Acclimation may explain the pattern."))
    r = draft_review.compare(json.dumps(old), new)
    assert 0 < r["document"]["change"] < 100
    assert r["document"]["added_words"] > 0 and r["document"]["removed_words"] > 0
    by = {s["title"]: s for s in r["sections"]}
    assert by["Methods"]["status"] == "unchanged" and by["Methods"]["change"] == 0
    assert by["Results"]["status"] == "modified"
    assert [p["status"] for p in by["Results"]["paragraphs"]] == ["modified", "removed"]
    assert by["Discussion"]["status"] == "added" and by["Discussion"]["change"] == 100
    assert r["paragraph_counts"] == {"added": 1, "removed": 1, "modified": 1, "unchanged": 1}
    edit = by["Results"]["paragraphs"][0]["ops"]
    assert ["+", "very"] in edit


def test_internal_duplicates_find_repeated_sentences_and_paragraphs():
    para = ("Reefs that experienced moderate heat stress before the 2016 heatwave lost fewer corals, "
            "which points to thermal acclimation as a buffer against bleaching mortality.")
    d = doc(("p", "Coral cover declined sharply on every surveyed reef after the heatwave. " + para),
            ("p", "Something unrelated about sampling design and transects."),
            ("p", para + " Coral cover declined sharply on every surveyed reef after the heatwave."))
    r = draft_review.internal_duplicates(draft_review.blocks(d))
    assert len(r["sentences"]) >= 2
    assert r["paragraphs"] and r["paragraphs"][0]["first_block"] == 0 and r["paragraphs"][0]["second_block"] == 2
    assert r["repeated"]  # only the later copies count


def test_check_duplicates_flags_copied_text_and_whether_it_is_cited(client, tmp_path):
    f = tmp_path / "coral.txt"
    f.write_text(SOURCE, encoding="utf-8")
    [res] = client.post("/ingest/path", json={"path": str(f)}).json()["results"]
    doc_id = res["document"]["id"]
    d = doc(("p", "Reefs exposed to prior moderate heat stress showed lower bleaching mortality, suggesting thermal acclimation."),
            ("p", "Marine heatwaves in 2016 caused mass coral bleaching across the Great Barrier Reef.", doc_id),
            ("p", "My own words about transect methods and nothing else at all here."))
    r = client.post("/drafts/check-duplicates", json={"content": d}).json()
    assert len(r["source_matches"]) == 2
    uncited, cited = r["source_matches"]  # uncited first
    assert not uncited["cited"] and uncited["level"] == "copied" and uncited["doc_id"] == doc_id
    assert cited["cited"]
    assert "heat stress" in uncited["quote"]
    assert 0 < r["uncited"] < r["sources"] <= r["overall"] < 100
    assert {p["block"] for p in r["paragraphs"]} == {0, 1}


def test_versions_milestones_compare_and_restore(client):
    v1 = doc(("h", "Intro"), ("p", "First version of the introduction."))
    v2 = doc(("h", "Intro"), ("p", "Second version of the introduction, much longer now."))
    client.put("/drafts/1", json={"title": "Intro", "content": json.dumps(v1)})
    listing = client.get("/drafts/1/versions").json()
    assert [v["kind"] for v in listing["versions"]] == ["auto"]  # the first save is kept
    assert listing["current_change"] == 0

    m = client.post("/drafts/1/versions", json={"label": "Sent to advisor", "title": "Intro", "content": json.dumps(v1)}).json()
    client.put("/drafts/1", json={"title": "Intro", "content": json.dumps(v2)})
    listing = client.get("/drafts/1/versions").json()
    assert listing["versions"][0]["label"] == "Sent to advisor" and listing["versions"][0]["number"] == 2
    assert listing["current_change"] > 0

    cmp = client.post(f"/drafts/1/versions/{m['id']}/compare", json={}).json()
    assert cmp["sections"][0]["status"] == "modified"

    restored = client.post(f"/drafts/1/versions/{m['id']}/restore").json()
    assert json.loads(restored["content"]) == v1
    listing = client.get("/drafts/1/versions").json()
    assert listing["versions"][0]["label"].startswith("Before restoring")
    assert client.post(f"/drafts/1/versions/{listing['versions'][0]['id']}/compare", json={}).json()["document"]["change"] > 0

    auto = listing["versions"][-1]
    assert client.patch(f"/drafts/1/versions/{auto['id']}", json={"label": "Kept"}).json()["kind"] == "milestone"
    client.delete(f"/drafts/1/versions/{auto['id']}")
    assert client.get(f"/drafts/1/versions/{auto['id']}").status_code == 404


def test_large_edit_keeps_the_draft_as_it_was(client):
    words = [f"word{i}" for i in range(80)]
    long = doc(("p", " ".join(words) + "."))
    edited = doc(("p", " ".join(words) + " and a few more words."))
    client.put("/drafts/1", json={"title": "t", "content": json.dumps(long)})  # first version
    client.put("/drafts/1", json={"title": "t", "content": json.dumps(edited)})  # small edit: no new version yet
    assert len(client.get("/drafts/1/versions").json()["versions"]) == 1

    client.put("/drafts/1", json={"title": "t", "content": json.dumps(doc(("p", "Almost everything was deleted.")))})
    versions = client.get("/drafts/1/versions").json()["versions"]
    assert versions[0]["label"] == "Before a large edit"
    assert json.loads(client.get(f"/drafts/1/versions/{versions[0]['id']}").json()["content"]) == edited


def test_auto_version_once_the_newest_is_old(client):
    client.put("/drafts/1", json={"title": "t", "content": json.dumps(doc(("p", "One.")))})
    lib = client.app.state.library
    with lib.conn:  # the newest version is older than the snapshot interval
        lib.conn.execute("UPDATE draft_versions SET created_at = datetime('now', '-1 hour')")
    client.put("/drafts/1", json={"title": "t", "content": json.dumps(doc(("p", "Two.")))})
    assert [v["number"] for v in client.get("/drafts/1/versions").json()["versions"]] == [2, 1]


def test_old_drafts_that_are_not_json_still_save(client):
    client.put("/drafts/1", json={"title": "x", "content": "not json"})
    assert client.get("/drafts/1/versions").json()["versions"] == []


def test_health_reports_the_api_version(client):
    from app.main import API_VERSION

    assert client.get("/health").json()["api"] == API_VERSION
