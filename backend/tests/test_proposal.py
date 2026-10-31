"""Research proposals written from a review's gaps, with the offline mock."""
import io
import sqlite3

import docx
import pytest
from fastapi.testclient import TestClient

from app import db
from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings
from test_matrix import PAPERS, wait


@pytest.fixture
def setup(tmp_path):
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), embedder=HashEmbedder())
    ids = {}
    for name, text in PAPERS.items():
        f = tmp_path / name
        f.write_text(text, encoding="utf-8")
        ids[name] = lib.ingest_path(str(f))[0]["document"]["id"]
    client = TestClient(create_app(lib.settings, lib))
    mid = client.post("/matrices", json={"name": "Digital finance", "doc_ids": list(ids.values())}).json()["id"]
    wait(client, mid)
    gaps = client.post(f"/matrices/{mid}/gaps").json()["gaps"]
    return client, lib, ids, mid, gaps


def nodes(doc, kind):
    out = []
    def walk(n):
        if n.get("type") == kind:
            out.append(n)
        for c in n.get("content") or []:
            walk(c)
    walk(doc)
    return out


def section(doc, title):
    """The blocks under a heading, up to the next one."""
    blocks, on = [], False
    for b in doc["content"]:
        if b["type"] == "heading":
            on = b["content"][0]["text"] == title
        elif on:
            blocks.append(b)
    return blocks


def test_variables_are_suggested_with_how_the_studies_measured_them(setup):
    client, lib, ids, mid, gaps = setup
    out = client.post("/proposals/variables", json={"finding_ids": [gaps[0]["id"]]}).json()
    assert out and all(v["role"] in ("independent", "dependent", "mediator", "moderator", "control") for v in out)
    findings = next(v for v in out if v["name"] == "Findings")
    assert findings["role"] == "dependent"
    assert {m["doc_id"] for m in findings["measures"]} == set(ids.values())  # each study, by its id in the library
    assert all(m["label"] and m["how"] for m in findings["measures"])
    assert client.post("/proposals/variables", json={"matrix_ids": [mid]}).status_code == 400  # no gap, no focus
    assert client.post("/proposals/variables", json={"matrix_ids": [mid], "focus": "savings"}).status_code == 200
    assert client.post("/proposals/variables", json={}).status_code == 400  # no matrix at all


def test_a_proposal_cites_the_studies_only_where_it_describes_them(setup):
    client, lib, ids, mid, gaps = setup
    body = {"finding_ids": [gaps[0]["id"]],
            "variables": [{"name": "Mobile money use", "role": "independent", "measure": "Account records"},
                          {"name": "Savings", "role": "dependent"}],
            "resources": "an existing household panel"}
    out = client.post("/proposals", json=body).json()
    doc = out["doc"]
    headings = [b["content"][0]["text"] for b in doc["content"] if b["type"] == "heading"]
    assert headings[0] == out["title"] and headings[1:4] == ["Background", "The gap", "Research questions"]
    assert {"Variables", "Design", "Timeline"} <= set(headings)

    chips = nodes(doc, "citation")
    assert chips and all(c["attrs"]["finding"] == out["finding"] and not c["attrs"]["quote"] for c in chips)
    assert {c["attrs"]["docId"] for c in chips} <= set(ids.values())
    assert all(c["attrs"]["status"] in ("verified", "weak", "unsupported") for c in chips)  # checked as it's written
    assert out["citations"]["verified"] + out["citations"]["flagged"] >= 1
    for proposed in ("Research questions", "Hypotheses", "Design", "Data", "Analysis", "Timeline"):
        assert not nodes({"content": section(doc, proposed)}, "citation"), proposed
    assert section(doc, "Research questions")[0]["type"] == "orderedList"
    variables = section(doc, "Variables")[0]
    assert variables["type"] == "table" and len(variables["content"]) == 3  # header and two variables
    assert "Account records" in str(variables) and "Independent" in str(variables)
    assert "an existing household panel" in str(section(doc, "Design"))

    # Kept as a finding the citations are checked against, but not listed with the matrix's gaps.
    kept = client.get(f"/findings/{out['finding']}").json()
    assert kept["kind"] == "proposal" and kept["matrix_ids"] == [mid] and kept["matrix_exists"]
    assert kept["title"] == out["title"] and len(kept["snapshot"]) == 2
    assert all(f["kind"] != "proposal" for f in client.get(f"/matrices/{mid}/findings").json())
    check = client.post(f"/findings/{out['finding']}/check", json={"claim": "Wanjiru reports 412 farmers."}).json()
    assert check["against"] == "matrix"


def test_what_the_writer_rules_out_is_checked_and_can_be_written_again(setup, monkeypatch):
    client, lib, ids, mid, gaps = setup
    seen = {}
    real = lib.provider.write_proposal
    def write(*args, **kw):
        seen["args"] = args
        return real(*args, **kw)
    monkeypatch.setattr(lib.provider, "write_proposal", write)
    monkeypatch.setattr(lib.provider, "check_exclusions", lambda rules, text: seen.setdefault("checked", (rules, text)) and
                        [{"rule": "No RCT", "section": "Design", "why": "It randomises households."}])
    body = {"finding_ids": [gaps[0]["id"]], "exclusions": "No RCT\nNo primary data collection", "resources": "Two years"}
    out = client.post("/proposals", json=body).json()
    assert out["violations"] == [{"rule": "No RCT", "section": "Design", "why": "It randomises households."}]
    assert seen["checked"][0] == "No RCT\nNo primary data collection" and "Research questions:" in seen["checked"][1]
    assert seen["args"][4] == "No RCT\nNo primary data collection" and seen["args"][5] == "Two years"

    client.post("/proposals", json={**body, "avoid": out["violations"]})
    assert "No RCT: It randomises households." in seen["args"][6]  # told what to avoid this time

    monkeypatch.setattr(lib.provider, "check_exclusions", lambda rules, text: pytest.fail("nothing to check"))
    assert client.post("/proposals", json={"finding_ids": [gaps[0]["id"]]}).json()["violations"] == []


def test_gaps_from_several_matrices(setup):
    client, lib, ids, mid, gaps = setup
    other = client.post("/matrices", json={"name": "Kenya only", "doc_ids": [ids["kenya.md"]],
                                           "columns": [{"key": "sample", "label": "Sample", "instruction": "Who"}]}).json()["id"]
    wait(client, other)
    seen = {}
    real = lib.provider.write_proposal
    lib.provider.write_proposal = lambda *a, **k: seen.setdefault("tables", a[0]) and real(*a, **k)
    out = client.post("/proposals", json={"finding_ids": [gaps[0]["id"]], "matrix_ids": [other], "focus": "savings"}).json()
    lines = seen["tables"].splitlines()
    assert len(lines) == 2  # the Kenyan paper is in both matrices: one line, values from each
    kenya = next(line for line in lines if "Mobile money and savings" in line)
    assert "Digital finance · Sample:" in kenya and "Kenya only · Sample:" in kenya
    kept = client.get(f"/findings/{out['finding']}").json()
    assert kept["matrix_ids"] == [other, mid] or kept["matrix_ids"] == [mid, other]
    assert kept["matrix_name"] in ("Digital finance, Kenya only", "Kenya only, Digital finance")

    client.put(f"/matrices/{other}/cells/{ids['kenya.md']}/sample", json={"answer": "500 traders"})
    assert client.get(f"/findings/{out['finding']}").json()["matrix_changed"]
    client.delete(f"/matrices/{other}")
    gone = client.get(f"/findings/{out['finding']}").json()
    assert not gone["matrix_exists"]  # one of its matrices is gone: checks use the rows kept with it
    assert client.post(f"/findings/{out['finding']}/check", json={"claim": "Savings rose."}).json()["against"] == "saved"


def test_has_this_been_done(setup, monkeypatch):
    client, lib, ids, mid, gaps = setup
    found = [{"openalex_id": "W1", "doi": "", "title": "Mobile money and savings in Kenya", "authors": ["A. Wanjiru"],
              "year": 2015, "venue": "", "cited_by_count": 40, "abstract": ""},
             {"openalex_id": "W2", "doi": "10.1/x", "title": "Mobile savings in rural India", "authors": ["C. Das"],
              "year": 2024, "venue": "J Dev", "cited_by_count": 3, "abstract": "A field study."}]
    asked = {}
    monkeypatch.setattr(lib.open_access, "search", lambda q, limit=15: asked.setdefault("q", q) and [dict(w) for w in found])
    works = client.post("/proposals/novelty", json={"query": "  Does mobile   money raise savings in rural India? "}).json()["works"]
    assert asked["q"] == "Does mobile money raise savings in rural India?"
    assert works[0]["in_library"] == ids["kenya.md"] and works[1]["in_library"] is None
    assert client.post("/proposals/novelty", json={"query": ""}).status_code == 422


def test_findings_from_before_proposals_are_migrated(tmp_path):
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript(db.SCHEMA.replace("'gap', 'synthesis', 'proposal'", "'gap', 'synthesis'")
                      .replace("  matrix_ids TEXT NOT NULL DEFAULT '[]', -- a proposal's matrices\n", ""))
    old.execute("INSERT INTO matrix_findings (kind, title, snapshot) VALUES ('gap', 'Kept', '[1]')")
    old.commit()
    old.close()
    conn = db.connect(path)
    row = conn.execute("SELECT kind, title, snapshot, matrix_ids FROM matrix_findings").fetchone()
    assert tuple(row) == ("gap", "Kept", "[1]", "[]")
    conn.execute("INSERT INTO matrix_findings (kind) VALUES ('proposal')")  # allowed now
    assert conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'matrix_findings_matrix'").fetchone()
    conn.close()
    db.connect(path).close()  # and connecting again changes nothing


def test_a_proposal_exports_to_word(setup):
    client, lib, ids, mid, gaps = setup
    doc = client.post("/proposals", json={"finding_ids": [gaps[0]["id"]],
                                          "variables": [{"name": "Savings", "role": "dependent"}]}).json()["doc"]
    data = client.post("/export/docx", json={"content": doc, "style": "apa"}).content
    word = docx.Document(io.BytesIO(data))
    text = "\n".join(p.text for p in word.paragraphs)
    assert "Research questions" in text and "References" in text and "missing source" not in text
    assert len(word.tables) == 2  # variables and timeline
