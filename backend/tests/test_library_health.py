"""Library health: papers whose file is gone (and finding it again), and papers never used."""
import json
import shutil

import pytest
from fastapi.testclient import TestClient

from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings
from tests.test_dupfiles import prose


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    return TestClient(create_app(settings, Library(settings, provider=MockProvider())))


def add(client, tmp_path, name, seed=1):
    f = tmp_path / "papers" / f"{name}.md"
    f.parent.mkdir(exist_ok=True)
    f.write_text(f"{name.title()} and household savings\nAda Okafor\n\n" + prose(seed), encoding="utf-8")
    [res] = client.post("/ingest/path", json={"path": str(f)}).json()["results"]
    assert res["ok"], res
    return res["document"]


def doc(client, doc_id):
    return client.get(f"/documents/{doc_id}").json()


def chip(doc_id):
    return {"type": "citation", "attrs": {"cid": f"c{doc_id}", "docId": doc_id, "page": 1, "quote": "x", "status": "verified"}}


def test_a_paper_whose_file_is_gone_is_flagged_and_a_web_page_never_is(client, tmp_path):
    d = add(client, tmp_path, "okafor")
    assert doc(client, d["id"])["file_missing"] is False
    (tmp_path / "papers" / "okafor.md").unlink()
    assert doc(client, d["id"])["file_missing"] is True
    lib = client.app.state.library
    with lib.conn:
        lib.conn.execute("UPDATE documents SET kind = 'web', source = 'https://example.org/a' WHERE id = ?", (d["id"],))
    assert doc(client, d["id"])["file_missing"] is False


def test_a_paper_is_used_once_a_draft_matrix_or_finding_cites_it(client, tmp_path):
    a, b, c, e = (add(client, tmp_path, n, seed=i) for i, n in enumerate(["alpha", "beta", "gamma", "delta"], 1))
    assert not any(doc(client, x["id"])["cited_in_drafts"] for x in (a, b, c, e))
    draft = client.post("/drafts", json={"title": "Ch 1"}).json()
    content = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "Claim. "}, chip(a["id"]),
        {"type": "citeMark", "attrs": {"cid": "m1", "results": [{"docId": b["id"]}]}},  # not confirmed: not a use
    ]}]}
    client.put(f"/drafts/{draft['id']}", json={"title": "Ch 1", "content": json.dumps(content)})
    assert doc(client, a["id"])["cited_in_drafts"] is True  # the kept answer was dropped when the draft changed
    assert doc(client, b["id"])["cited_in_drafts"] is False
    lib = client.app.state.library
    with lib.conn:
        mid = lib.conn.execute("INSERT INTO matrices (name) VALUES ('M')").lastrowid
        lib.conn.execute("INSERT INTO matrix_rows (matrix_id, doc_id) VALUES (?, ?)", (mid, c["id"]))
        lib.conn.execute("INSERT INTO matrix_findings (matrix_id, kind, snapshot) VALUES (?, 'gap', ?)",
                         (mid, json.dumps([{"doc_id": e["id"], "label": "Delta"}])))
    assert doc(client, c["id"])["cited_in_drafts"] is True and doc(client, e["id"])["cited_in_drafts"] is True
    client.delete(f"/drafts/{draft['id']}")
    assert doc(client, a["id"])["cited_in_drafts"] is False


def test_locate_file_keeps_the_document_its_highlights_and_citations(client, tmp_path):
    d = add(client, tmp_path, "okafor")
    h = client.post(f"/documents/{d['id']}/highlights", json={"page": 1, "text": "household savings", "note": "n"}).json()
    moved = tmp_path / "elsewhere" / "okafor.md"
    moved.parent.mkdir()
    shutil.move(tmp_path / "papers" / "okafor.md", moved)
    assert doc(client, d["id"])["file_missing"] is True
    r = client.post(f"/documents/{d['id']}/locate", json={"path": str(moved)}).json()
    assert r["status"] == "located" and r["document"]["id"] == d["id"] and r["document"]["file_missing"] is False
    assert r["document"]["source"] == str(moved.resolve())
    assert [x["id"] for x in client.get(f"/documents/{d['id']}/highlights").json()] == [h["id"]]
    assert client.get(f"/documents/{d['id']}/file").status_code == 200


def test_a_different_version_needs_saying_so_and_wrong_files_are_refused(client, tmp_path):
    d = add(client, tmp_path, "okafor")
    other = add(client, tmp_path, "beta", seed=3)
    revised = tmp_path / "revised.md"
    revised.write_text("Okafor revised\nAda Okafor\n\n" + prose(9), encoding="utf-8")
    assert client.post(f"/documents/{d['id']}/locate", json={"path": str(revised)}).json() == {"status": "differs", "doc_id": d["id"]}
    assert doc(client, d["id"])["source"].endswith("okafor.md")  # nothing changed
    r = client.post(f"/documents/{d['id']}/locate", json={"path": str(revised), "force": True}).json()
    assert r["status"] == "located" and r["document"]["source"].endswith("revised.md")

    pdf = tmp_path / "x.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    assert client.post(f"/documents/{d['id']}/locate", json={"path": str(pdf)}).status_code == 400  # another type
    assert client.post(f"/documents/{d['id']}/locate", json={"path": str(tmp_path / "nope.md")}).status_code == 400
    assert client.post(f"/documents/{d['id']}/locate", json={"path": other["source"]}).status_code == 400  # another paper's file
    assert client.post("/documents/999/locate", json={"path": str(revised)}).status_code == 404
