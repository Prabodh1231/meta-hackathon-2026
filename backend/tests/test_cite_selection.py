import pytest
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder
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


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    c = TestClient(create_app(settings, Library(settings, provider=MockProvider(), embedder=HashEmbedder())))
    for name, text in [("sleep.md", SLEEP), ("reef.md", REEF)]:
        (tmp_path / name).write_text(text, encoding="utf-8")
        c.post("/ingest/path", json={"path": str(tmp_path / name)})
    return c


def suggest(client, claim, **kw):
    res = client.post("/citations/suggest", json={"claim": claim, **kw})
    assert res.status_code == 200, res.text
    return res.json()


def test_best_supporting_sentence_comes_first_and_is_checked(client):
    out = suggest(client, "Spindle density after a cue predicted next-morning recall of word pairs.")
    top = out[0]
    assert top["status"] == "verified"
    assert top["quote"] == "Spindle density after each cue predicted recall of the cued word pairs the next morning."
    page = client.get(f"/documents/{top['doc_id']}/pages/{top['page']}").json()["text"]
    assert page[top["start"] : top["end"]] == top["quote"]  # ready to highlight
    assert {"chunk_id", "label", "reason", "score"} <= top.keys()


def test_results_are_ranked_supported_first_and_deduplicated(client):
    out = suggest(client, "Coral bleaching mortality was lower after moderate heat stress.")
    statuses = [r["status"] for r in out]
    order = {"verified": 0, "weak": 1, "unsupported": 2, "quote_not_found": 3}
    assert statuses == sorted(statuses, key=order.get)
    assert "Coral bleaching" in out[0]["quote"]
    assert len({(r["doc_id"], r["quote"]) for r in out}) == len(out)


def test_unbacked_claim_has_no_verified_source(client):
    out = suggest(client, "Quantum computers will replace classical banking infrastructure.")
    assert all(r["status"] != "verified" for r in out)


def test_scope_and_limit(client):
    docs = {d["title"]: d["id"] for d in client.get("/documents").json()}
    out = suggest(client, "Spindle density predicted recall.", doc_ids=[docs["Reef survey"]], limit=2)
    assert len(out) <= 2 and {r["doc_id"] for r in out} <= {docs["Reef survey"]}


def test_empty_claim_is_rejected(client):
    assert client.post("/citations/suggest", json={"claim": "   "}).status_code == 400
