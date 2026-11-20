"""Home's to-do list: open citations per draft, works a draft's sources build on, matrix checks."""
import json

from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_citegraph import FILLER, HONG, LITERACY, ONLY_A, add, lib, paper  # noqa: F401 (lib is a fixture)


def chip(cid, doc_id, status, claim="A claim."):
    return {"type": "citation", "attrs": {"cid": cid, "docId": doc_id, "status": status, "label": f"Paper {doc_id}", "claim": claim}}


def draft(*inline):
    return json.dumps({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Some words. "}, *inline]},
                                                   {"type": "bulletList", "content": [{"type": "listItem", "content": [
                                                       {"type": "paragraph", "content": [chip("in-list", 999, "weak")]}]}]}]})


def test_drafts_list_what_they_cite_and_the_citations_still_open(lib):
    lib.create_draft("Cites things", draft(chip("a", 1, "verified"), chip("b", 2, "weak", "Spindles gate memory."),
                                           chip("c", 1, "quote_not_found"), chip("d", 3, "pending")))
    lib.create_draft("Nothing cited", json.dumps({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Hi"}]}]}))

    [d] = lib.draft_citations()  # a draft citing nothing isn't listed
    assert d["title"] == "Cites things" and d["cited"] == [1, 2, 3, 999]
    assert [(f["cid"], f["status"]) for f in d["flagged"]] == [("b", "weak"), ("c", "quote_not_found"), ("in-list", "weak")]
    assert d["flagged"][0]["claim"] == "Spindles gate memory." and d["flagged"][0]["doc_id"] == 2


def test_missing_for_keeps_works_several_of_the_drafts_sources_cite(lib, tmp_path):
    a = add(lib, tmp_path, "a.txt", paper("First study of household finance", [HONG, LITERACY, ONLY_A, *FILLER[:3]]))
    b = add(lib, tmp_path, "b.txt", paper("Second study of household finance", [HONG, LITERACY, *FILLER[3:6]]))
    c = add(lib, tmp_path, "c.txt", paper("Third study of household finance", [HONG, *FILLER[6:]]))

    works = lib.missing_for([a, b, c])
    assert [(w["title"].split()[0], w["cited_by"]) for w in works] == [("Social", 3), ("Financial", 2)]  # ONLY_A: cited once
    assert sorted(x["id"] for x in works[0]["citers"]) == sorted([a, b, c]) and "ref" in works[0]
    assert [w["cited_by"] for w in lib.missing_for([a, b])] == [2, 2]  # counted among the papers asked about only
    assert lib.missing_for([c]) == [] and lib.missing_for([12345]) == []


def test_the_endpoint_gives_the_chosen_drafts_missing_works_and_matrix_checks(lib, tmp_path):
    a = add(lib, tmp_path, "a.txt", paper("First study of household finance", [HONG, *FILLER[:3]]))
    b = add(lib, tmp_path, "b.txt", paper("Second study of household finance", [HONG, *FILLER[3:6]]))
    citing = lib.create_draft("Household finance", draft(chip("x", a, "verified"), chip("y", b, "unsupported")))["id"]
    with lib.conn:
        mid = lib.conn.execute("INSERT INTO matrices (name, columns, gaps) VALUES ('Finance', '[]', ?)",
                               (json.dumps([{"title": "No long panels", "detail": "Every study is short."}]),)).lastrowid
        lib.conn.executemany("INSERT INTO matrix_rows (matrix_id, doc_id) VALUES (?, ?)", [(mid, a), (mid, b)])
        lib.conn.executemany("INSERT INTO matrix_cells (matrix_id, doc_id, col, status) VALUES (?, ?, ?, ?)",
                             [(mid, a, "sample", "unverified"), (mid, b, "sample", "found"), (mid, a, "method", "not_reported")])
    client = TestClient(create_app(library=lib))

    res = client.get(f"/home/todo?draft_id={citing}").json()
    assert [d["id"] for d in res["drafts"]] == [citing] and res["drafts"][0]["flagged"][0]["status"] == "unsupported"
    assert [w["title"].split()[0] for w in res["missing"]] == ["Social"]
    [m] = res["matrices"]
    assert (m["name"], m["papers"], m["unverified"], m["not_reported"]) == ("Finance", 2, 1, 1)
    assert m["gaps"][0]["title"] == "No long panels" and isinstance(m["gaps"][0]["id"], int)  # saved as a finding
    assert client.get("/home/todo").json()["missing"] == []  # no draft chosen: nothing to look for
