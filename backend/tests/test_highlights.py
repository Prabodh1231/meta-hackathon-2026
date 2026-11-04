"""Highlights and notes made while reading, fetched while writing (no network: mock model,
keyword scoring instead of any embedder)."""
import pytest
from fastapi.testclient import TestClient

from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings

SLEEP = """# Sleep study
Participants slept in the lab for two nights before testing began.
Spindle density after each cue predicted recall of the cued word pairs the next morning.
REM sleep cues produced no measurable memory benefit in any participant.
"""
REEF = """# Reef survey
Divers surveyed forty transects along the outer reef slope in March.
Coral bleaching mortality was lower on reefs exposed to moderate heat stress the previous year.
"""
SPINDLES = "Spindle density after each cue predicted recall of the cued word pairs the next morning."
CORAL = "Coral bleaching mortality was lower on reefs exposed to moderate heat stress the previous year."


@pytest.fixture
def setup(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    lib = Library(settings, provider=MockProvider())
    c = TestClient(create_app(settings, lib))
    ids = {}
    for name, text in [("sleep", SLEEP), ("reef", REEF)]:
        (tmp_path / f"{name}.md").write_text(text, encoding="utf-8")
        ids[name] = c.post("/ingest/path", json={"path": str(tmp_path / f"{name}.md")}).json()["results"][0]["document"]["id"]
    return c, lib, ids


def add(c, doc_id, text, note="", page=1):
    r = c.post(f"/documents/{doc_id}/highlights", json={"page": page, "text": text, "note": note})
    assert r.status_code == 200, r.text
    return r.json()


def test_a_highlight_is_kept_with_its_place_in_the_page(setup):
    c, lib, ids = setup
    # As pdf.js gives a selection: a line break where the stored text has a space.
    h = add(c, ids["sleep"], "Spindle density after each cue predicted\nrecall of the cued word pairs")
    page = c.get(f"/documents/{ids['sleep']}/pages/1").json()["text"]
    assert page[h["start"]:h["end"]] == "Spindle density after each cue predicted recall of the cued word pairs"
    assert [x["id"] for x in c.get(f"/documents/{ids['sleep']}/highlights").json()] == [h["id"]]


def test_notes_are_written_changed_and_removed_with_the_highlight(setup):
    c, lib, ids = setup
    h = add(c, ids["reef"], CORAL, note="Compare with the 2016 bleaching")
    assert h["note"] == "Compare with the 2016 bleaching"
    assert c.patch(f"/highlights/{h['id']}", json={"note": "  Ask about recovery  "}).json()["note"] == "Ask about recovery"
    assert c.delete(f"/highlights/{h['id']}").status_code == 200
    assert c.get(f"/documents/{ids['reef']}/highlights").json() == []
    assert c.patch(f"/highlights/{h['id']}", json={"note": "x"}).status_code == 404


def test_bad_highlights_are_refused(setup):
    c, lib, ids = setup
    assert c.post(f"/documents/{ids['reef']}/highlights", json={"page": 1, "text": "   "}).status_code == 400
    assert c.post(f"/documents/{ids['reef']}/highlights", json={"page": 9, "text": "coral"}).status_code == 404
    assert c.post("/documents/999/highlights", json={"page": 1, "text": "coral"}).status_code == 404


def test_fetch_puts_what_fits_the_paragraph_first(setup):
    c, lib, ids = setup
    add(c, ids["sleep"], SPINDLES, note="spindles and memory")
    add(c, ids["reef"], CORAL)
    out = c.post("/highlights/fetch", json={"context": "Coral reefs that met moderate heat stress bleached less."}).json()
    assert [h["text"] for h in out] == [CORAL, SPINDLES]
    assert out[0]["score"] > out[1]["score"] and out[0]["doc_title"]
    # The reader's note is scored too: it alone can bring a highlight to the top.
    noted = c.post("/highlights/fetch", json={"context": "what did I think about memory and spindles"}).json()
    assert noted[0]["text"] == SPINDLES
    # Without a paragraph, the newest first.
    assert [h["text"] for h in c.post("/highlights/fetch", json={}).json()] == [CORAL, SPINDLES]


def test_a_fetched_highlight_is_a_verified_citation_of_its_page(setup):
    c, lib, ids = setup
    add(c, ids["sleep"], SPINDLES)
    cite = c.post("/highlights/fetch", json={"context": "spindles"}).json()[0]["citation"]
    assert cite["status"] == "verified" and cite["quote"] == SPINDLES and cite["doc_id"] == ids["sleep"]
    page = c.get(f"/documents/{ids['sleep']}/pages/1").json()["text"]
    assert page[cite["start"]:cite["end"]] == SPINDLES
    # The chip's quote is found again like any other citation.
    again = c.post("/citations/verify", json={"claim": SPINDLES, "chunk_id": cite["chunk_id"], "quote": cite["quote"]}).json()
    assert again["start"] == cite["start"]


def test_text_not_in_the_page_is_kept_but_not_cited(setup):
    c, lib, ids = setup
    h = add(c, ids["reef"], "a sentence that is nowhere in this paper at all")
    assert h["start"] is None
    out = c.post("/highlights/fetch", json={}).json()
    assert out[0]["citation"] is None and out[0]["label"]
    assert c.post("/highlights/write", json={"ids": [h["id"]]}).status_code == 400


def test_writing_from_highlights_cites_them(setup):
    c, lib, ids = setup
    a = add(c, ids["sleep"], SPINDLES, note="my idea: cueing helps only in deep sleep")
    b = add(c, ids["reef"], CORAL)
    seen = {}
    original = lib.provider.draft

    def spy(instruction, context, passages):
        seen.update(instruction=instruction, passages=passages)
        return original(instruction, context, passages)

    lib.provider.draft = spy
    r = c.post("/highlights/write", json={"ids": [a["id"], b["id"]], "context": "So far: sleep and memory."})
    assert r.status_code == 200, r.text
    assert [p.text for p in seen["passages"]] == [SPINDLES, CORAL]
    assert "my idea: cueing helps only in deep sleep" in seen["instruction"]
    cited = {cc["doc_id"] for s in r.json()["sentences"] for cc in s["citations"]}
    assert cited <= {ids["sleep"], ids["reef"]} and cited


def test_highlights_go_with_their_paper(setup):
    c, lib, ids = setup
    add(c, ids["reef"], CORAL)
    assert c.delete(f"/documents/{ids['reef']}").status_code == 200
    assert c.post("/highlights/fetch", json={}).json() == []
