"""Literature review matrices, read by the offline mock from small papers written for the test."""
import io
import time

import docx
import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings

PAPERS = {
    "kenya.md": "# Mobile money and savings in Kenya\n\nWanjiru, A.\n\n"
                "Our sample is 412 farmers surveyed with a household questionnaire. "
                "The study was conducted in rural Kenya over the period 2015 to 2018. "
                "Our method is a panel regression model with household fixed effects. "
                "Our main finding is a significant effect: mobile money increased household savings by 12 percent. "
                "A limitation is the short period covered and self-reported savings.",
    "india.md": "# Digital payments in Indian cities\n\nRao, B.\n\n"
                "The sample consists of 1,200 small firms observed in 2020. "
                "The study was conducted in Mumbai and Delhi, India. "
                "Our method is a difference-in-differences design around the 2016 demonetisation. "
                "We find a significant effect: firms adopting digital payments grew sales faster.",
}


def wait(client_or_matrices, mid, timeout=20.0):
    get = (lambda: client_or_matrices.get(f"/matrices/{mid}").json()) if isinstance(client_or_matrices, TestClient) \
        else (lambda: client_or_matrices.get(mid))
    end = time.time() + timeout
    while True:
        m = get()
        if not m["pending"]:
            return m
        assert time.time() < end, "the matrix never finished reading"
        time.sleep(0.05)


@pytest.fixture
def setup(tmp_path):
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), embedder=HashEmbedder())
    ids = {}
    for name, text in PAPERS.items():
        f = tmp_path / name
        f.write_text(text, encoding="utf-8")
        ids[name] = lib.ingest_path(str(f))[0]["document"]["id"]
    client = TestClient(create_app(lib.settings, lib))
    return client, lib, ids


def cell(m, doc_id, key):
    return next(r for r in m["rows"] if r["doc_id"] == doc_id)["cells"][key]


def test_every_cell_is_a_located_quote_or_not_reported(setup):
    client, lib, ids = setup
    r = client.post("/matrices", json={"name": "Digital finance", "doc_ids": list(ids.values())})
    assert r.status_code == 200
    m = wait(client, r.json()["id"])
    assert [c["key"] for c in m["columns"]] == [
        "sample", "setting", "method", "findings", "limitations", "@year", "@venue", "@cited_by_count"]
    assert len(m["rows"]) == 2 and m["cells"] == 10  # the paper details aren't read: no cells
    sample = cell(m, ids["kenya.md"], "sample")
    assert sample["status"] == "found" and "412 farmers" in sample["answer"]
    page = lib.get_page(ids["kenya.md"], sample["page"])["text"]
    assert page[sample["start"]:sample["end"]].strip() in sample["quote"] or sample["quote"] in page[sample["start"]:sample["end"]]
    assert cell(m, ids["india.md"], "limitations")["status"] == "not_reported"  # no limitation is stated


def test_editing_and_reading_again(setup):
    client, lib, ids = setup
    mid = client.post("/matrices", json={"name": "M", "doc_ids": [ids["kenya.md"]]}).json()["id"]
    wait(client, mid)
    m = client.put(f"/matrices/{mid}/cells/{ids['kenya.md']}/method", json={"answer": "Panel FE regression"}).json()
    c = cell(m, ids["kenya.md"], "method")
    assert c["answer"] == "Panel FE regression" and c["edited"] == 1 and c["quote"]  # the evidence stays
    m = wait(client, client.post(f"/matrices/{mid}/rerun", json={"doc_id": ids["kenya.md"], "column": "method"}).json()["id"])
    c = cell(m, ids["kenya.md"], "method")
    assert c["edited"] == 0 and c["answer"] != "Panel FE regression"


def test_columns_can_be_added_renamed_and_removed(setup):
    client, lib, ids = setup
    mid = client.post("/matrices", json={"name": "M", "doc_ids": [ids["kenya.md"]],
                                         "columns": [{"label": "Sample"}, {"label": "Findings"}]}).json()["id"]
    m = wait(client, mid)
    cols = m["columns"] + [{"label": "Outcome measure", "instruction": "What outcome was measured, e.g. savings."}]
    cols[0] = {**cols[0], "label": "Participants"}  # a new name only: nothing to read again
    m = wait(client, client.patch(f"/matrices/{mid}", json={"columns": cols}).json()["id"])
    assert [c["label"] for c in m["columns"]] == ["Participants", "Findings", "Outcome measure"]
    assert cell(m, ids["kenya.md"], "outcome_measure")["status"] in ("found", "not_reported")
    m = client.patch(f"/matrices/{mid}", json={"columns": m["columns"][1:]}).json()
    assert "sample" not in m["rows"][0]["cells"]


def test_papers_from_a_folder_or_a_topic_and_adding_rows(setup):
    client, lib, ids = setup
    papers = client.post("/matrices/papers", json={"topic": "mobile money"}).json()
    assert [p["id"] for p in papers] == [ids["kenya.md"]]
    lib.create_folder("Payments", 0)
    folder = lib.list_folders()[0]["id"]
    assert {p["id"] for p in client.post("/matrices/papers", json={"folder_id": folder}).json()} == set(ids.values())
    mid = client.post("/matrices", json={"name": "M", "doc_ids": [ids["kenya.md"]]}).json()["id"]
    m = wait(client, client.patch(f"/matrices/{mid}", json={"add_doc_ids": [ids["india.md"]]}).json()["id"])
    assert len(m["rows"]) == 2 and m["cells"] == 10
    m = client.patch(f"/matrices/{mid}", json={"remove_doc_ids": [ids["kenya.md"]]}).json()
    assert [r["doc_id"] for r in m["rows"]] == [ids["india.md"]] and m["cells"] == 5


def test_gaps_and_synthesis(setup):
    client, lib, ids = setup
    mid = client.post("/matrices", json={"name": "Digital finance", "doc_ids": list(ids.values())}).json()["id"]
    wait(client, mid)
    gaps = client.post(f"/matrices/{mid}/gaps").json()["gaps"]
    assert any("limitations" in g["title"].lower() for g in gaps)
    assert client.get(f"/matrices/{mid}").json()["gaps"] == gaps  # kept with the matrix
    out = client.post(f"/matrices/{mid}/synthesis", json={}).json()
    assert out["sentences"] and all(c["start"] is not None for s in out["sentences"] for c in s["citations"])


def test_table_for_the_draft_cites_each_cell(setup):
    client, lib, ids = setup
    mid = client.post("/matrices", json={"name": "M", "doc_ids": [ids["kenya.md"]]}).json()["id"]
    wait(client, mid)
    doc = client.get(f"/matrices/{mid}/table", params={"columns": "sample,findings"}).json()
    table = doc["content"][0]
    assert table["type"] == "table" and len(table["content"]) == 2  # header and one paper
    header = [c["content"][0]["content"][0]["text"] for c in table["content"][0]["content"]]
    assert header == ["Study", "Sample", "Findings"]
    chips = [n for c in table["content"][1]["content"] for n in c["content"][0].get("content", []) if n["type"] == "citation"]
    assert len(chips) == 2 and all(ch["attrs"]["docId"] == ids["kenya.md"] and ch["attrs"]["quote"] for ch in chips)


def test_exports(setup):
    client, lib, ids = setup
    mid = client.post("/matrices", json={"name": "Digital finance", "doc_ids": list(ids.values())}).json()["id"]
    wait(client, mid)
    csv_text = client.get(f"/matrices/{mid}/export", params={"format": "csv"}).content.decode("utf-8-sig")
    assert csv_text.splitlines()[0].startswith("Study,Title,Year,Sample,Sample: evidence")
    wb = load_workbook(io.BytesIO(client.get(f"/matrices/{mid}/export", params={"format": "xlsx"}).content))
    ws = wb.active
    assert ws["D1"].value == "Sample" and "412 farmers" in "".join(str(c.value) for c in ws[2] + ws[3])
    word = docx.Document(io.BytesIO(client.get(f"/matrices/{mid}/export", params={"format": "docx"}).content))
    assert len(word.tables) == 1 and word.tables[0].cell(0, 1).text == "Sample"
    text = "\n".join(c.text for row in word.tables[0].rows for c in row.cells)
    assert "Not reported" in text and ", 2015)" in text  # cells cite in the chosen style (APA: author or title, year)
    assert client.get(f"/matrices/{mid}/export", params={"format": "pdf"}).status_code == 400


def test_a_half_read_matrix_resumes_when_the_backend_starts(tmp_path, setup):
    client, lib, ids = setup
    mid = client.post("/matrices", json={"name": "M", "doc_ids": [ids["kenya.md"]]}).json()["id"]
    wait(client, mid)
    with lib.conn:  # as if the app closed while it was reading
        lib.conn.execute("UPDATE matrix_cells SET status = 'pending' WHERE matrix_id = ?", (mid,))
    from app.matrix import Matrices

    assert wait(Matrices(lib), mid)["pending"] == 0


def test_deleting_a_paper_or_the_matrix(setup):
    client, lib, ids = setup
    mid = client.post("/matrices", json={"name": "M", "doc_ids": list(ids.values())}).json()["id"]
    wait(client, mid)
    lib.delete_document(ids["india.md"])
    assert [r["doc_id"] for r in client.get(f"/matrices/{mid}").json()["rows"]] == [ids["kenya.md"]]
    assert client.get("/matrices").json()[0]["papers"] == 1
    assert client.delete(f"/matrices/{mid}").status_code == 200
    assert client.get(f"/matrices/{mid}").status_code == 404


def test_copies_of_one_paper_are_offered_once(setup, tmp_path):
    client, lib, ids = setup
    copy = tmp_path / "kenya-copy.md"
    copy.write_text(PAPERS["kenya.md"], encoding="utf-8")
    lib.ingest_path(str(copy))
    assert [p["id"] for p in client.post("/matrices/papers", json={"topic": "mobile money"}).json()] == [ids["kenya.md"]]


def test_hex_page_labels_are_decoded(setup):
    from app.ingest import clean_page_label

    client, lib, ids = setup
    assert [clean_page_label(x) for x in ("<FEFF0038>", "<FEFF00310031>", "342", " ", None)] == ["8", "11", "342", None, None]
    with lib.conn:  # a label stored before the fix
        lib.conn.execute("UPDATE pages SET label = '<FEFF00310032>' WHERE doc_id = ?", (ids["kenya.md"],))
    again = Library(lib.settings, provider=MockProvider(), embedder=HashEmbedder())
    assert again.get_page(ids["kenya.md"], 1)["label"] == "12"


# ---------- detail columns: the paper's record beside the questions ----------

def details_only(*fields):
    return [{"kind": "detail", "field": f} for f in fields]


def test_detail_columns_show_the_record_and_cost_no_reading(setup):
    client, lib, ids = setup
    with lib.conn:
        lib.conn.execute("UPDATE documents SET year = 2019, venue = 'J Dev Econ', volume = '140', issue = '2', "
                         "cited_by_count = 812, abstract = 'We study mobile money.', authors = '[\"Ana Wanjiru\"]' WHERE id = ?",
                         (ids["kenya.md"],))
    cols = [{"label": "Sample", "instruction": "Who was studied"}, *details_only("year", "volume", "cited_by_count", "abstract")]
    m = wait(client, client.post("/matrices", json={"name": "M", "doc_ids": list(ids.values()), "columns": cols}).json()["id"])
    assert [(c["key"], c["kind"], c["label"]) for c in m["columns"]][1:] == [
        ("@year", "detail", "Year"), ("@volume", "detail", "Volume (issue)"), ("@cited_by_count", "detail", "Cited"),
        ("@abstract", "detail", "Abstract")]
    assert m["cells"] == 2  # one question, two papers
    kenya = next(r for r in m["rows"] if r["doc_id"] == ids["kenya.md"])
    assert {k: kenya["details"][k] for k in ("year", "volume", "cited_by_count", "abstract", "authors")} == {
        "year": 2019, "volume": "140(2)", "cited_by_count": 812, "abstract": "We study mobile money.", "authors": ["Ana Wanjiru"]}

    # A correction in the library shows at once: details are the record, not a copy.
    client.patch(f"/documents/{ids['kenya.md']}", json={"year": 2020})
    assert next(r for r in client.get(f"/matrices/{m['id']}").json()["rows"] if r["doc_id"] == ids["kenya.md"])["details"]["year"] == 2020

    # Adding or removing a detail column reads nothing.
    m = client.patch(f"/matrices/{m['id']}", json={"columns": [*m["columns"], *details_only("publisher")]}).json()
    assert m["pending"] == 0 and m["columns"][-1]["key"] == "@publisher"


def test_a_matrix_of_details_alone_and_the_limits(setup):
    client, lib, ids = setup
    r = client.post("/matrices", json={"name": "Years", "doc_ids": list(ids.values()), "columns": details_only("year", "year", "doi")})
    assert r.status_code == 200
    assert [c["key"] for c in r.json()["columns"]] == ["@year", "@doi"]  # the same detail once
    assert r.json()["pending"] == 0 and r.json()["cells"] == 0
    bad = client.post("/matrices", json={"name": "X", "doc_ids": list(ids.values()), "columns": details_only("shoe_size")})
    assert bad.status_code == 400
    # Twelve questions and every detail fit: the limit is on questions, which cost reading.
    every = [d["field"] for d in client.get("/matrices/details").json()]
    many = [{"label": f"Q{i}", "instruction": "x"} for i in range(12)] + details_only(*every)
    assert client.post("/matrices", json={"name": "Big", "doc_ids": [ids["kenya.md"]], "columns": many}).status_code == 200
    # A column keyed like a detail ("@year") is that detail.
    q = client.post("/matrices", json={"name": "Q", "doc_ids": [ids["kenya.md"]], "columns": [{"key": "@year", "label": "Year"}]})
    assert q.status_code == 200 and q.json()["columns"][0]["kind"] == "detail"


def test_details_in_exports_gaps_and_synthesis(setup, monkeypatch):
    client, lib, ids = setup
    with lib.conn:
        lib.conn.execute("UPDATE documents SET venue = 'J Dev Econ', cited_by_count = 812 WHERE id = ?", (ids["kenya.md"],))
    cols = [{"label": "Sample", "instruction": "Who was studied", "key": "sample"}, *details_only("year", "venue", "cited_by_count")]
    mid = client.post("/matrices", json={"name": "M", "doc_ids": list(ids.values()), "columns": cols}).json()["id"]
    wait(client, mid)

    csv = client.get(f"/matrices/{mid}/export", params={"format": "csv"}).content.decode("utf-8-sig").splitlines()
    assert csv[0] == "Study,Title,Year,Sample,Sample: evidence,Journal,Cited"  # no evidence for a detail, and Year once
    assert any(line.endswith(",J Dev Econ,812") for line in csv[1:])

    seen = {}
    monkeypatch.setattr(lib.provider, "find_gaps", lambda name, table: seen.setdefault("table", table) and [])
    client.post(f"/matrices/{mid}/gaps")
    assert "Journal: J Dev Econ | Cited: 812" in seen["table"]  # (after Year: unknown)

    monkeypatch.setattr(lib.provider, "draft", lambda instruction, context, passages: seen.setdefault("task", instruction) and [])
    client.post(f"/matrices/{mid}/synthesis", json={})
    assert "Journal: J Dev Econ; Cited: 812" in seen["task"] and "cite only the passages" in seen["task"]


def test_what_a_new_matrix_starts_with(setup):
    client, _, _ = setup
    cols = client.get("/matrices/columns").json()
    assert [c["key"] for c in cols if c["kind"] == "detail"] == ["@year", "@venue", "@cited_by_count"]
    assert len([c for c in cols if c["kind"] == "question"]) == 5
    assert {"field": "abstract", "label": "Abstract"} in client.get("/matrices/details").json()


def test_gaps_and_passages_are_kept_as_findings(setup):
    client, lib, ids = setup
    mid = client.post("/matrices", json={"name": "Digital finance", "doc_ids": list(ids.values())}).json()["id"]
    wait(client, mid)
    gaps = client.post(f"/matrices/{mid}/gaps").json()["gaps"]
    assert gaps and all(isinstance(g["id"], int) for g in gaps)
    written = client.post(f"/matrices/{mid}/synthesis", json={"columns": ["sample", "findings"]}).json()
    assert isinstance(written["finding"], int)

    assert [g["id"] for g in client.post(f"/matrices/{mid}/gaps").json()["gaps"]] == [g["id"] for g in gaps]  # kept once

    kept = client.get(f"/matrices/{mid}/findings").json()
    assert [f["kind"] for f in kept] == ["synthesis"] + ["gap"] * len(gaps)  # newest first
    assert kept[0]["text"] == " ".join(s["text"] for s in written["sentences"])
    assert not any(f["matrix_changed"] for f in kept)

    gap = client.get(f"/findings/{gaps[0]['id']}").json()
    assert gap["title"] == gaps[0]["title"] and gap["text"] == gaps[0]["detail"] and gap["matrix_exists"]
    assert sorted(r["doc_id"] for r in gap["snapshot"]) == sorted(ids.values())  # what a gap cites: every paper
    passage = client.get(f"/findings/{written['finding']}").json()
    assert [v["key"] for v in passage["snapshot"][0]["values"]] == ["sample", "findings"]  # the columns it used
    assert passage["sentences"] == written["sentences"]

    # Checked against the matrix, quotes included, not against one passage.
    seen = {}
    def judge(claim, topic, table):
        seen.update(claim=claim, topic=topic, table=table)
        return {"verdict": "partial", "reason": "Only Kenya reports it."}
    lib.provider.judge_against_matrix = judge
    out = client.post(f"/findings/{written['finding']}/check", json={"claim": "  Savings rose  in Kenya. "}).json()
    assert out == {"status": "weak", "reason": "Only Kenya reports it.", "against": "matrix", "matrix_changed": False}
    assert seen["claim"] == "Savings rose in Kenya." and seen["topic"] == "Digital finance"
    assert "412 farmers" in seen["table"] and '["' in seen["table"]
    assert client.post(f"/findings/{written['finding']}/check", json={"claim": " "}).status_code == 400


def test_a_finding_outlives_changes_to_its_matrix(setup):
    client, lib, ids = setup
    mid = client.post("/matrices", json={"name": "Digital finance", "doc_ids": list(ids.values())}).json()["id"]
    wait(client, mid)
    fid = client.post(f"/matrices/{mid}/gaps").json()["gaps"][0]["id"]

    client.put(f"/matrices/{mid}/cells/{ids['kenya.md']}/sample", json={"answer": "500 traders"})
    assert client.get(f"/findings/{fid}").json()["matrix_changed"]
    assert client.get(f"/matrices/{mid}/findings").json()[0]["matrix_changed"]

    client.delete(f"/matrices/{mid}")
    gone = client.get(f"/findings/{fid}").json()
    assert not gone["matrix_exists"] and gone["matrix_id"] is None and gone["matrix_name"] == "Digital finance"
    assert len(gone["snapshot"]) == 2
    out = client.post(f"/findings/{fid}/check", json={"claim": "Few studies report limitations."}).json()
    assert out["against"] == "saved" and out["status"] in ("verified", "weak", "unsupported")

    assert client.delete(f"/findings/{fid}").json() == {"ok": True}
    assert client.get(f"/findings/{fid}").status_code == 404


def test_gaps_found_before_findings_were_kept_get_ids(setup):
    client, lib, ids = setup
    mid = client.post("/matrices", json={"name": "M", "doc_ids": list(ids.values())}).json()["id"]
    wait(client, mid)
    with lib.conn:
        lib.conn.execute("UPDATE matrices SET gaps = ? WHERE id = ?", ('[{"title": "Old", "detail": "From before."}]', mid))
    gaps = client.get(f"/matrices/{mid}").json()["gaps"]
    assert gaps[0]["title"] == "Old" and isinstance(gaps[0]["id"], int)
    assert client.get(f"/matrices/{mid}").json()["gaps"] == gaps  # saved once, not on every read


def test_a_gap_in_the_draft_exports_citing_every_paper(setup):
    client, lib, ids = setup
    def chip(doc_id, status):
        return {"type": "citation", "attrs": {"cid": f"g{doc_id}", "docId": doc_id, "chunkId": None, "page": None,
                                              "quote": "", "finding": 1, "status": status, "reason": "Too broad."}}
    para = {"type": "paragraph", "content": [{"type": "text", "text": "No study looks beyond one country. "},
                                             chip(ids["kenya.md"], "verified"), {"type": "text", "text": " "},
                                             chip(ids["india.md"], "verified")]}
    flagged = {"type": "paragraph", "content": [{"type": "text", "text": "Every study is recent. "},
                                                chip(ids["kenya.md"], "weak")]}
    data = client.post("/export/docx", json={"content": {"type": "doc", "content": [para, flagged]}, "style": "apa"}).content
    word = docx.Document(io.BytesIO(data))
    text = "\n".join(p.text for p in word.paragraphs)
    assert "missing source" not in text and "p." not in text.split("References")[0]
    # One in-text citation naming both papers (by title: the test papers have no authors), and both in the references.
    assert "(“Mobile money and savings…”, 2015; “Digital payments in Indian…”, 2020)." in text
    assert text.split("References")[1].count("(20") == 2
    comments = [c.text for c in word.comments]
    assert len(comments) == 1  # none for the verified (blue) ones
    assert "review matrix only partly supports" in comments[0] and "Quoted" not in comments[0]
