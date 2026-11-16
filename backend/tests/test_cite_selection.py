import json
import threading

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


def test_stream_ends_with_what_the_plain_endpoint_answers(client):
    claim = "Spindle density after a cue predicted next-morning recall of word pairs."
    updates = stream(client, claim)
    # Only the last update is marked done, and nothing is left unchecked in it.
    assert [u["done"] for u in updates] == [False] * (len(updates) - 1) + [True]
    assert all(u["results"] for u in updates)
    last = updates[-1]["results"]
    assert all(r["status"] != "pending" for r in last)
    assert last == suggest(client, claim)
    # Every candidate arrives with its quote already located on its page.
    assert all(r["start"] is not None for u in updates for r in u["results"])


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


def test_when_every_check_fails_the_cite_fails(tmp_path):
    client = flaky_client(tmp_path, " ")
    claim = {"claim": "Spindle density after a cue predicted recall."}
    # With nothing to show, the failure is the answer: before the reply starts, or as its
    # last line if candidates were already listed as being checked.
    try:
        res = client.post("/citations/suggest/stream", json=claim)
    except RuntimeError:
        pass
    else:
        assert json.loads(res.text.splitlines()[-1]) == {"error": "Muse didn't answer"}
    with pytest.raises(RuntimeError):  # the plain endpoint fails as it did before
        client.post("/citations/suggest", json=claim)


class SlowSearch(MockProvider):
    """A mock whose query expansion (the full search's first step) waits to be released."""

    def __init__(self):
        super().__init__()
        self.release = threading.Event()

    def expand_query(self, query):
        self.release.wait(10)
        return super().expand_query(query)


def library(tmp_path, provider):
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=provider)
    for name, text in [("sleep.md", SLEEP), ("reef.md", REEF)]:
        (tmp_path / name).write_text(text, encoding="utf-8")
        lib.ingest_path(str(tmp_path / name))
    return lib


def test_quick_keyword_search_shows_a_supported_source_before_the_full_search_is_back(tmp_path):
    provider = SlowSearch()
    lib = library(tmp_path, provider)
    updates = lib.suggest_citations_stream("Spindle density after each cue predicted recall of the cued word pairs.")
    results, done = next(updates)  # the full search is still waiting on its expansion
    assert not done and not provider.release.is_set()
    assert [r["status"] for r in results] == ["verified"]
    assert results[0]["quote"].startswith("Spindle density after each cue")
    provider.release.set()
    *_, (final, done) = updates
    assert done and final[0]["status"] == "verified"
    assert all(r["status"] != "pending" for r in final)
    assert len({(r["chunk_id"], r["quote"]) for r in final}) == len(final)  # picked by both, checked once


def test_a_quick_candidate_the_full_search_dropped_is_listed_only_if_supported(tmp_path):
    lib = library(tmp_path, MockProvider())
    claim = "Spindle density after each cue predicted recall of the cued word pairs the next morning."
    hits = {h["title"]: h for h in lib.search("spindle recall reef coral transects", k=8, mode="keyword")}
    sleep, reef = hits["Sleep study"], hits["Reef survey"]
    supported = (0.9, sleep, "Spindle density after each cue predicted recall of the cued word pairs the next morning.")
    unrelated = (0.1, reef, "Divers surveyed forty transects along the outer reef slope in March.")
    full_pick = (0.2, sleep, "Participants slept in the lab for two nights before testing began.")
    lib._cite_candidates = lambda claim, doc_ids, limit, mode="auto": [supported, unrelated] if mode == "keyword" else [full_pick]
    quotes = {r["quote"]: r["status"] for r in lib.suggest_citations(claim)}
    assert quotes[supported[2]] == "verified"  # an extra supported source is kept
    assert full_pick[2] in quotes  # the full search's candidate is listed whatever its verdict
    assert unrelated[2] not in quotes  # an unsupported quick-only candidate is not
