import json

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


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    c = TestClient(create_app(settings, Library(settings, provider=MockProvider())))
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


def stream(client, claim, **kw):
    res = client.post("/citations/suggest/stream", json={"claim": claim, **kw})
    assert res.status_code == 200, res.text
    return [json.loads(line) for line in res.text.splitlines()]


def test_stream_shows_candidates_first_then_each_check(client):
    claim = "Spindle density after a cue predicted next-morning recall of word pairs."
    updates = stream(client, claim)
    first, last = updates[0], updates[-1]
    # The candidates arrive unchecked, with their quote already located on its page.
    assert first["done"] is False and first["results"]
    assert all(r["status"] == "pending" and r["start"] is not None for r in first["results"])
    # One more update per check, and only the last is marked done.
    assert len(updates) == len(first["results"]) + 1
    assert [u["done"] for u in updates] == [False] * (len(updates) - 1) + [True]
    assert all(r["status"] != "pending" for r in last["results"])
    # It ends with what the plain endpoint answers.
    assert last["results"] == suggest(client, claim)


def test_stream_with_nothing_to_check_is_one_done_line(client):
    assert stream(client, "Zzyzx qwertyuiop.") == [{"results": [], "done": True}]


def test_stream_rejects_an_empty_claim_before_it_starts(client):
    assert client.post("/citations/suggest/stream", json={"claim": "   "}).status_code == 400


class FlakyJudge(MockProvider):
    """A mock whose support check fails for passages containing a word."""

    def __init__(self, fail_on):
        super().__init__()
        self.fail_on = fail_on

    def judge_support(self, claim, passage):
        if self.fail_on in passage:
            raise RuntimeError("Muse didn't answer")
        return super().judge_support(claim, passage)


def flaky_client(tmp_path, fail_on):
    settings = Settings(data_dir=tmp_path / "data")
    c = TestClient(create_app(settings, Library(settings, provider=FlakyJudge(fail_on))))
    for name, text in [("sleep.md", SLEEP), ("reef.md", REEF)]:
        (tmp_path / name).write_text(text, encoding="utf-8")
        c.post("/ingest/path", json={"path": str(tmp_path / name)})
    return c


def test_a_failed_check_drops_that_candidate_only(tmp_path):
    client = flaky_client(tmp_path, "Divers")
    last = stream(client, "Spindle density and coral bleaching mortality after heat stress and a cue.")[-1]
    assert last["done"] is True and last["results"]
    assert all(r["status"] != "pending" for r in last["results"])
    assert all("Reef" not in r["label"] for r in last["results"])


def test_when_every_check_fails_the_stream_ends_with_the_error(tmp_path):
    client = flaky_client(tmp_path, " ")
    updates = stream(client, "Spindle density after a cue predicted recall.")
    assert updates[0]["done"] is False
    assert updates[-1] == {"error": "Muse didn't answer"}
    with pytest.raises(RuntimeError):  # the plain endpoint fails as it did before
        client.post("/citations/suggest", json={"claim": "Spindle density after a cue predicted recall."})
