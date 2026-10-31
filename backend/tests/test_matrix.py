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
    assert [c["key"] for c in m["columns"]] == ["sample", "setting", "method", "findings", "limitations"]
    assert len(m["rows"]) == 2 and m["cells"] == 10
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
