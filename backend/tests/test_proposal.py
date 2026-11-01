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
    plan, write = lib.provider.plan_proposal, lib.provider.write_proposal
    monkeypatch.setattr(lib.provider, "plan_proposal", lambda *a: seen.setdefault("plan", []).append(a) or plan(*a))
    monkeypatch.setattr(lib.provider, "write_proposal", lambda *a: seen.setdefault("write", []).append(a) or write(*a))
    monkeypatch.setattr(lib.provider, "check_exclusions", lambda rules, text: seen.setdefault("checked", (rules, text)) and
                        [{"rule": "No RCT", "section": "Design", "why": "It randomises households."}])
    body = {"finding_ids": [gaps[0]["id"]], "exclusions": "No RCT\nNo primary data collection", "resources": "Two years"}
    out = client.post("/proposals", json=body).json()
    assert out["violations"] == [{"rule": "No RCT", "section": "Design", "why": "It randomises households."}]
    assert seen["checked"][0] == "No RCT\nNo primary data collection" and "Research questions:" in seen["checked"][1]
    args = seen["plan"][0]
    assert args[4] == "No RCT\nNo primary data collection" and args[5] == "Two years"
    assert seen["write"][0][3] == "No RCT\nNo primary data collection"  # both the plan and the writing keep to them

    client.post("/proposals", json={**body, "avoid": out["violations"]})
    assert "No RCT: It randomises households." in seen["plan"][1][6]  # told what to avoid this time
    assert "No RCT: It randomises households." in seen["write"][1][5]

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


def test_plan_then_review_the_questions_then_write(setup, monkeypatch):
    client, lib, ids, mid, gaps = setup
    labels = {r["doc_id"]: r["label"] for r in client.get(f"/matrices/{mid}").json()["rows"]}
    kenya, india = labels[ids["kenya.md"]], labels[ids["india.md"]]
    calls = []

    def plan(tables, *rest):
        calls.append("plan")
        assert f"[{kenya}] \"" in tables and "[S1]" not in tables  # studies are named, not numbered
        return {"title": "Savings and mobile money", "core_question": "Does mobile money raise household savings?",
                "research_questions": ["RQ1: Does mobile money raise savings?", "RQ2: Does it last?",
                                       "RQ3: Does trust in fintech drive firm sales in India?"],
                "hypotheses": ["H1: It does.", "H2: It lasts.", "H3: Trust matters."],
                "variables": [{"name": "Savings", "role": "dependent"}, {"name": "Mobile money use", "role": "independent"}],
                "left_out": [{"gap": "Little on setting", "why": "It needs a second country."}]}

    def review(plan_text):
        calls.append("review")
        assert "Core question: Does mobile money raise household savings?" in plan_text
        assert "- Does trust in fintech drive firm sales in India?" in plan_text  # labels gone before the review
        return {"questions": [
            {"original": "Does mobile money raise savings?", "verdict": "keep", "text": "Does mobile money raise savings?", "why": "Core."},
            {"original": "Does it last?", "verdict": "revise", "text": "Does the effect on savings last beyond two years?", "why": "Vague."},
            {"original": "Does trust in fintech drive firm sales in India?", "verdict": "remove", "text": "",
             "why": "Another outcome (firm sales) and population."}],
            "hypotheses": ["Savings rise with mobile money.", "The rise lasts beyond two years."]}

    def write(tables, plan_text, *rest):
        calls.append("write")
        assert "firm sales" not in plan_text and "beyond two years" in plan_text  # written around the reviewed questions
        return {"background": [{"text": f"Wanjiru finds savings rose 12% [S1][{kenya}].", "studies": [kenya.upper()]},
                               {"text": "Both studies find large effects on savings.", "studies": [kenya, india, "Nobody 2020"]}],
                "gap": [{"text": "No study follows savings beyond 2018.", "studies": [kenya]}],
                "variables": [{"name": "Savings", "role": "dependent", "measure": "Bank records",
                               "earlier": [{"study": kenya, "how": "self-reported savings"},
                                           {"study": india, "how": "a validated savings index"}]}],
                "design": ["A panel."], "data": [], "analysis": [], "contribution": [], "limitations": [], "timeline": []}
    monkeypatch.setattr(lib.provider, "plan_proposal", plan)
    monkeypatch.setattr(lib.provider, "review_questions", review)
    monkeypatch.setattr(lib.provider, "write_proposal", write)
    monkeypatch.setattr(lib.provider, "repair_claims", lambda items: [""] * len(items))  # nothing saved: kept as written

    judged = {}
    def judge(claim, topic, table):
        judged[claim] = table
        if claim.startswith("Both"):
            return {"verdict": "partial", "reason": "Only Wanjiru reports savings."}
        if "validated savings index" in claim:
            return {"verdict": "unsupported", "reason": "The line states no measure."}
        return {"verdict": "supported", "reason": "Stated."}
    monkeypatch.setattr(lib.provider, "judge_against_matrix", judge)
    out = client.post("/proposals", json={"finding_ids": [gaps[0]["id"]]}).json()

    assert calls == ["plan", "review", "write"]
    assert out["research_questions"] == ["Does mobile money raise savings?", "Does the effect on savings last beyond two years?"]
    assert out["hypotheses"] == ["Savings rise with mobile money.", "The rise lasts beyond two years."]
    assert [q["verdict"] for q in out["question_review"]] == ["revise", "remove"]
    assert out["question_review"][1]["why"] == "Another outcome (firm sales) and population."
    assert out["core_question"] == "Does mobile money raise household savings?"
    assert out["left_out"] == [{"gap": "Little on setting", "why": "It needs a second country."}]

    background = section(out["doc"], "Background")
    assert background[0]["content"][0]["text"] == "Wanjiru finds savings rose 12%. "  # no "[S1]" or "[name]" left
    assert [c["attrs"]["docId"] for c in nodes({"content": background}, "citation")] == [ids["kenya.md"], ids["kenya.md"], ids["india.md"]]

    # Each claim is checked against the rows of the studies it cites, not the whole review.
    assert judged["Both studies find large effects on savings."].count("\n") == 1  # two studies, two lines
    stated = next(c for c in judged if "self-reported savings" in c)
    assert stated.startswith(f"In {kenya}, Savings was measured as") and judged[stated].count("\n") == 0
    assert out["flagged"] == [{"section": "Background", "claim": "Both studies find large effects on savings.",
                               "status": "weak", "reason": "Only Wanjiru reports savings.", "studies": [kenya, india]}]
    # A measure the matrices don't state is dropped from the table, and reported.
    assert out["removed"] == [{"claim": f"In {india}, Savings was measured as: a validated savings index",
                               "reason": "The line states no measure.", "study": india}]
    table = str(section(out["doc"], "Variables"))
    assert "self-reported savings" in table and "validated savings index" not in table
    assert out["citations"] == {"verified": 3, "flagged": 2}


def test_a_review_that_removes_every_question_keeps_the_core_one(setup, monkeypatch):
    client, lib, ids, mid, gaps = setup
    real = lib.provider.plan_proposal
    monkeypatch.setattr(lib.provider, "plan_proposal", lambda *a: {**real(*a), "core_question": "Does X raise Y?"})
    monkeypatch.setattr(lib.provider, "review_questions", lambda plan: {
        "questions": [{"original": "Q", "verdict": "remove", "text": "", "why": "Off topic."}], "hypotheses": []})
    out = client.post("/proposals", json={"finding_ids": [gaps[0]["id"]]}).json()
    assert out["research_questions"] == ["Does X raise Y?"] and out["question_review"][0]["verdict"] == "remove"


def test_a_check_can_be_limited_to_the_cited_studies(setup, monkeypatch):
    client, lib, ids, mid, gaps = setup
    tables = []
    monkeypatch.setattr(lib.provider, "judge_against_matrix", lambda c, t, table: tables.append(table) or
                        {"verdict": "supported", "reason": ""})
    fid = gaps[0]["id"]
    client.post(f"/findings/{fid}/check", json={"claim": "Savings rose.", "doc_ids": [ids["india.md"]]})
    client.post(f"/findings/{fid}/check", json={"claim": "Savings rose."})
    client.post(f"/findings/{fid}/check", json={"claim": "Savings rose.", "doc_ids": [999]})
    assert [t.count("\n") + 1 for t in tables] == [1, 2, 2]  # unknown ids fall back to the whole matrix
    assert "Digital payments" in tables[0] and "Mobile money" not in tables[0]


def test_the_review_can_refocus_the_title_and_core_question(setup, monkeypatch):
    client, lib, ids, mid, gaps = setup
    real = lib.provider.plan_proposal
    monkeypatch.setattr(lib.provider, "plan_proposal", lambda *a: {
        **real(*a), "title": "Savings, when search interest is controlled",
        "core_question": "Does mobile money raise savings, distinguishing search-interest proxies from use?"})
    def review(plan_text):
        return {"title": "Savings and mobile money", "core_question": "Does mobile money raise savings?",
                "core_changed_why": "The search-interest clause brings in another review's topic.",
                "questions": [{"original": "Q", "verdict": "keep", "text": "Does mobile money raise savings?", "why": ""}],
                "hypotheses": ["It does."]}
    monkeypatch.setattr(lib.provider, "review_questions", review)
    seen = {}
    write = lib.provider.write_proposal
    monkeypatch.setattr(lib.provider, "write_proposal", lambda t, plan, *r: seen.setdefault("plan", plan) and write(t, plan, *r))
    out = client.post("/proposals", json={"finding_ids": [gaps[0]["id"]]}).json()
    assert out["title"] == "Savings and mobile money" and out["core_question"] == "Does mobile money raise savings?"
    assert out["question_review"][0] == {
        "original": "Does mobile money raise savings, distinguishing search-interest proxies from use?", "verdict": "core",
        "text": "Does mobile money raise savings?", "title_before": "Savings, when search interest is controlled",
        "title": "Savings and mobile money", "why": "The search-interest clause brings in another review's topic."}
    assert "search-interest" not in seen["plan"]  # the rest is written around the refocused study
    assert section(out["doc"], "Background") is not None and out["doc"]["content"][0]["content"][0]["text"] == "Savings and mobile money"


def test_flagged_paragraphs_get_one_repair(setup, monkeypatch):
    client, lib, ids, mid, gaps = setup
    labels = {r["doc_id"]: r["label"] for r in client.get(f"/matrices/{mid}").json()["rows"]}
    kenya, india = labels[ids["kenya.md"]], labels[ids["india.md"]]
    def write(*a):
        return {"background": [{"text": f"[{kenya}] find savings rose 12%.", "studies": [kenya]},
                               {"text": "No study has ever measured savings.", "studies": [kenya, india]},
                               {"text": "Both studies find huge effects.", "studies": [kenya, india]},
                               {"text": "Firms everywhere doubled sales.", "studies": [india]}],
                "gap": [], "variables": [], "design": [], "data": [], "analysis": [], "contribution": [],
                "limitations": [], "timeline": []}
    monkeypatch.setattr(lib.provider, "write_proposal", write)
    asked = {}
    def repair(items):
        asked["items"] = items
        return [f"{kenya} reports savings rose 12%.",  # better: replaces it
                "Some studies find effects.",            # no better: the original stays
                ""]                                      # nothing saved, and contradicted: dropped
    monkeypatch.setattr(lib.provider, "repair_claims", repair)
    verdicts = {f"{kenya} find savings rose 12%.": "supported",
                "No study has ever measured savings.": "unsupported", f"{kenya} reports savings rose 12%.": "supported",
                "Both studies find huge effects.": "partial", "Some studies find effects.": "partial",
                "Firms everywhere doubled sales.": "unsupported"}
    checked = []
    def judge(claim, topic, table):
        checked.append((claim, table.count("\n") + 1))
        return {"verdict": verdicts[claim], "reason": f"Reason for {claim[:12]}"}
    monkeypatch.setattr(lib.provider, "judge_against_matrix", judge)
    out = client.post("/proposals", json={"finding_ids": [gaps[0]["id"]]}).json()

    assert [i["claim"] for i in asked["items"]] == ["No study has ever measured savings.", "Both studies find huge effects.",
                                                    "Firms everywhere doubled sales."]
    assert asked["items"][0]["rows"].count("\n") == 1 and f"[{kenya}]" in asked["items"][0]["rows"]  # the rows it cites
    assert (f"{kenya} reports savings rose 12%.", 2) in checked  # the rewrite is checked against the same studies
    texts = [b["content"][0]["text"].strip() for b in section(out["doc"], "Background")]
    assert texts == [f"{kenya} find savings rose 12%.", f"{kenya} reports savings rose 12%.", "Both studies find huge effects."]
    assert [(r["status"], r["after"]) for r in out["repaired"]] == [("verified", f"{kenya} reports savings rose 12%."),
                                                                     ("removed", "")]
    assert [f["claim"] for f in out["flagged"]] == ["Both studies find huge effects."]
