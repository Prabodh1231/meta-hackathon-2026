"""Keeping one version of a paper (the published one) and moving everything from another (a
preprint) to it: citations in drafts, matrix rows, findings, highlights, topics and star."""
import json

import fitz
import pytest
from fastapi.testclient import TestClient

from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings

BOTH = "Spindle density after each cue predicted recall of the cued word pairs."
ONLY_PRE = "In this early sample of twelve adults the effect was larger than expected."


def pdf(path, pages):
    d = fitz.open()
    for text in pages:
        d.new_page().insert_textbox(fitz.Rect(72, 100, 520, 700), text, fontsize=10)
    d.save(path)


@pytest.fixture
def setup(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    lib = Library(settings, provider=MockProvider())
    client = TestClient(create_app(settings, lib))
    pdf(tmp_path / "pre.pdf", ["Sleep spindles and memory: a working paper.", f"{ONLY_PRE} {BOTH}"])
    pdf(tmp_path / "pub.pdf", ["Introduction to sleep and memory research in adults.", "Methods were preregistered.", BOTH])
    ids = {}
    for name, meta in [("pre", {"authors": ["Alice Chen"], "year": 2020, "title": "Spindles gate reactivation (working paper)"}),
                       ("pub", {"authors": ["Alice Chen"], "year": 2021, "venue": "J. Sleep Res.", "doi": "10.5555/jsr.2021.1",
                                "title": "Spindles gate reactivation"})]:
        doc = client.post("/ingest/path", json={"path": str(tmp_path / f"{name}.pdf")}).json()["results"][0]["document"]
        client.patch(f"/documents/{doc['id']}", json=meta)
        ids[name] = doc["id"]
    return client, lib, ids


def chip(doc_id, page, quote, status="verified"):
    return {"type": "citation", "attrs": {"cid": f"c{page}{len(quote)}", "chunkId": 1, "docId": doc_id, "page": page, "start": 0,
                                          "end": 5, "quote": quote, "claim": "x", "label": "Chen 2020, p. 2", "status": status,
                                          "reason": "", "finding": None}}


def draft_with(client, ids):
    d = client.post("/drafts", json={"title": "Chapter"}).json()
    content = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "Spindles matter. "}, chip(ids["pre"], 2, BOTH),
        {"type": "text", "text": " Bigger early. "}, chip(ids["pre"], 2, ONLY_PRE),
        {"type": "text", "text": " Elsewhere. "}, chip(ids["pub"], 3, BOTH),
        {"type": "citeMark", "attrs": {"cid": "m1", "results": [{"docId": ids["pre"], "page": 2, "quote": BOTH}]}},
    ]}]}
    client.put(f"/drafts/{d['id']}", json={"title": "Chapter", "content": json.dumps(content)})
    return d["id"]


def chips(client, draft_id):
    out = []

    def walk(n):
        if n.get("type") in ("citation", "citeMark"):
            out.append(n["attrs"])
        for c in n.get("content") or []:
            walk(c)

    walk(json.loads(client.get(f"/drafts/{draft_id}").json()["content"]))
    return out


def test_citations_move_to_the_kept_version_and_ones_not_found_are_marked_to_check(setup):
    client, lib, ids = setup
    draft = draft_with(client, ids)
    before = client.get(f"/drafts/{draft}").json()["content"]
    dry = client.post(f"/documents/{ids['pre']}/merge-into/{ids['pub']}", params={"dry_run": True}).json()
    assert (dry["citations"], dry["citations_to_check"], dry["drafts"], dry["done"]) == (2, 1, 1, False)
    assert client.get(f"/drafts/{draft}").json()["content"] == before  # a dry run changes nothing

    r = client.post(f"/documents/{ids['pre']}/merge-into/{ids['pub']}").json()
    assert (r["citations"], r["citations_to_check"], r["done"], r["kept_title"]) == (2, 1, True, "Spindles gate reactivation")
    found, missing, untouched, mark = chips(client, draft)
    assert (found["docId"], found["page"], found["status"]) == (ids["pub"], 3, "verified")  # found on the published page
    assert found["label"].startswith("Chen 2021")
    assert (missing["docId"], missing["status"], missing["quote"]) == (ids["pub"], "quote_not_found", ONLY_PRE)
    assert "Check it" in missing["reason"]  # kept, marked: never dropped, never pointed at another passage
    assert untouched == chip(ids["pub"], 3, BOTH)["attrs"]
    assert mark["results"][0]["docId"] == ids["pub"] and mark["results"][0]["page"] == 3
    # A version of the draft as it was, to undo it from History.
    versions = client.get(f"/drafts/{draft}/versions").json()["versions"]
    assert any(v["label"].startswith("Before moving citations to") for v in versions)
    assert client.get(f"/documents/{ids['pre']}").status_code == 404
    [gone] = [x for x in client.get("/library/removed").json() if x["id"] == ids["pre"]]
    assert (gone["reason"], gone["duplicate_of"]) == ("duplicate", ids["pub"])


def test_highlights_topics_star_matrices_and_findings_move_too(setup):
    client, lib, ids = setup
    placed = client.post(f"/documents/{ids['pre']}/highlights", json={"page": 2, "text": BOTH, "note": "key"}).json()
    lost = client.post(f"/documents/{ids['pre']}/highlights", json={"page": 2, "text": ONLY_PRE, "note": "early"}).json()
    [f1] = [f for f in lib.create_folder("Sleep") if f["name"] == "Sleep"]
    lib.set_folder_membership(ids["pre"], f1["id"], True)
    client.post("/library/marks", json={"doc_ids": [ids["pre"]], "starred": True})
    with lib.conn:
        only = lib.conn.execute("INSERT INTO matrices (name) VALUES ('Only the preprint')").lastrowid
        both = lib.conn.execute("INSERT INTO matrices (name) VALUES ('Both')").lastrowid
        lib.conn.executemany("INSERT INTO matrix_rows (matrix_id, doc_id) VALUES (?, ?)",
                             [(only, ids["pre"]), (both, ids["pre"]), (both, ids["pub"])])
        lib.conn.executemany('INSERT INTO matrix_cells (matrix_id, doc_id, col, status, answer, quote, page) VALUES (?, ?, ?, ?, ?, ?, ?)',
                             [(only, ids["pre"], "finding", "found", "spindles", BOTH, 2),
                              (only, ids["pre"], "sample", "found", "twelve", ONLY_PRE, 2)])
        lib.conn.execute("INSERT INTO matrix_findings (matrix_id, kind, snapshot, sentences) VALUES (?, 'gap', ?, ?)",
                         (only, json.dumps([{"doc_id": ids["pre"], "label": "Chen 2020"}]),
                          json.dumps([{"text": "x", "citations": [{"docId": ids["pre"]}]}])))
    r = client.post(f"/documents/{ids['pre']}/merge-into/{ids['pub']}").json()
    assert (r["highlights"], r["highlights_unplaced"], r["topics"], r["starred"]) == (2, 1, 1, True)
    assert (r["matrix_rows"], r["matrix_rows_dropped"], r["cells_to_check"], r["findings"]) == (1, 1, 1, 1)

    hs = {h["id"]: h for h in client.get(f"/documents/{ids['pub']}/highlights").json()}
    assert (hs[placed["id"]]["page"], hs[placed["id"]]["note"]) == (3, "key") and hs[placed["id"]]["start"] is not None
    assert (hs[lost["id"]]["text"], hs[lost["id"]]["note"], hs[lost["id"]]["start"]) == (ONLY_PRE, "early", None)
    pub = client.get(f"/documents/{ids['pub']}").json()
    assert pub["starred"] and [(f["name"], f["state"]) for f in pub["folders"] if f["name"] == "Sleep"] == [("Sleep", "user")]
    cells = {r["col"]: dict(r) for r in lib.conn.execute("SELECT * FROM matrix_cells WHERE matrix_id = ?", (only,))}
    assert {c["doc_id"] for c in cells.values()} == {ids["pub"]}
    assert (cells["finding"]["status"], cells["finding"]["page"]) == ("found", 3)
    assert cells["sample"]["status"] == "unverified"
    assert [r[0] for r in lib.conn.execute("SELECT doc_id FROM matrix_rows WHERE matrix_id = ?", (both,))] == [ids["pub"]]
    finding = lib.conn.execute("SELECT snapshot, sentences FROM matrix_findings").fetchone()
    assert json.loads(finding["snapshot"])[0]["doc_id"] == ids["pub"]
    assert json.loads(finding["sentences"])[0]["citations"][0]["docId"] == ids["pub"]


def test_a_failure_part_way_changes_nothing(setup, monkeypatch):
    client, lib, ids = setup
    draft = draft_with(client, ids)
    h = client.post(f"/documents/{ids['pre']}/highlights", json={"page": 2, "text": BOTH}).json()
    before = client.get(f"/drafts/{draft}").json()["content"]
    versions = len(client.get(f"/drafts/{draft}/versions").json()["versions"])

    def broken(*a, **k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(lib, "_remove_row", broken)  # the last step
    with pytest.raises(RuntimeError):
        lib.merge_into(ids["pre"], ids["pub"])
    assert client.get(f"/drafts/{draft}").json()["content"] == before
    assert len(client.get(f"/drafts/{draft}/versions").json()["versions"]) == versions
    assert [x["id"] for x in client.get(f"/documents/{ids['pre']}/highlights").json()] == [h["id"]]
    assert client.get(f"/documents/{ids['pre']}").status_code == 200


def test_merging_needs_two_papers_that_exist(setup):
    client, _, ids = setup
    assert client.post(f"/documents/{ids['pre']}/merge-into/{ids['pre']}").status_code == 400
    assert client.post(f"/documents/{ids['pre']}/merge-into/999").status_code == 404
