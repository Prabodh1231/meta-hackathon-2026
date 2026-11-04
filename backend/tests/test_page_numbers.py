import sqlite3

import fitz
import pytest
from fastapi.testclient import TestClient

from app import db
from app.ingest import printed_page_labels
from app.library import Library, short_label
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings

BODY = [
    "Spindle density after each cue predicted recall of the cued word pairs the next morning.",
    "Reactivation delivered during REM sleep produced no measurable memory benefit at all.",
    "These findings suggest spindles gate hippocampal memory reactivation in slow-wave sleep.",
]


def make_pdf(path=None, footers=None, headers=None, labels_from=None, pages=3):
    """A PDF with body text, optional header/footer text per page and optional page labels."""
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page()  # A4: 595 x 842 pt
        page.insert_text((72, 140), "Targeted Memory Reactivation" if i == 0 else "Results", fontsize=12)
        page.insert_textbox(fitz.Rect(72, 160, 520, 700), BODY[i % len(BODY)], fontsize=10)
        if headers and headers[i]:
            page.insert_text((72, 40), headers[i], fontsize=8)
        if footers and footers[i]:
            page.insert_text((290, 815), footers[i], fontsize=8)
    if labels_from is not None:
        doc.set_page_labels([{"startpage": 0, "prefix": "", "style": "D", "firstpagenum": labels_from}])
    if path:
        doc.save(path)
    return doc


def test_pdf_page_labels_take_priority():
    doc = make_pdf(labels_from=1207, footers=["9", "10", "11"])
    assert printed_page_labels(doc) == (["1207", "1208", "1209"], "pdf_labels")


def test_page_labels_that_mirror_the_index_are_ignored():
    doc = make_pdf(labels_from=1, footers=["341", "342", "343"])
    assert printed_page_labels(doc) == (["341", "342", "343"], "printed")


def test_footer_numbers_detected_despite_running_header_noise():
    # Volume "12" and year "2021" repeat on every page; only the page numbers advance with the index.
    doc = make_pdf(
        headers=["Journal of Sleep Research 12 (2021)"] * 3,
        footers=["341", "342", "343"],
    )
    assert printed_page_labels(doc) == (["341", "342", "343"], "printed")


def test_unnumbered_cover_page_stays_unlabeled():
    doc = make_pdf(footers=[None, "1", "2"])
    assert printed_page_labels(doc) == ([None, "1", "2"], "printed")


@pytest.mark.parametrize(
    "footers, pages",
    [
        (None, 3),  # no numbers at all
        (["2021", "2021", "2021"], 3),  # a year is not a page number
        (["341"], 1),  # one page can't establish a numbering pattern
        (["5", "88", "13"], 3),  # numbers that don't advance with the pages
    ],
)
def test_falls_back_to_pdf_index(footers, pages):
    doc = make_pdf(footers=footers, pages=pages)
    assert printed_page_labels(doc) == ([None] * pages, "index")


def test_short_label_tolerates_odd_author_names():
    assert short_label({"authors": ["Chen, Wei", "Martinez, Ana"], "year": 2021}) == "Chen & Martinez 2021"
    assert short_label({"authors": ["", "  ", "Wei Chen"], "year": 2021}) == "Chen 2021"  # blank names used to crash
    assert short_label({"authors": [""], "title": "Reef notes"}) == "Reef notes"


def test_short_label_formats():
    pdf = {"authors": ["Alice Chen"], "year": 2021, "kind": "pdf"}
    assert short_label({**pdf, "page_numbering": "printed"}, page=2, page_label="342") == "Chen 2021, p. 342"
    assert short_label({**pdf, "page_numbering": "index"}, page=2) == "Chen 2021, p. 2"
    assert short_label({**pdf, "page_numbering": "printed"}, page=1) == "Chen 2021, PDF p. 1"
    assert short_label({**pdf, "kind": "pptx"}, page=3) == "Chen 2021, slide 3"


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    return TestClient(create_app(settings, Library(settings, provider=MockProvider())))


def test_printed_pages_flow_into_citations_viewer_and_references(client, tmp_path):
    pdf = tmp_path / "chen.pdf"
    make_pdf(pdf, footers=["341", "342", "343"])
    client.post("/ingest/path", json={"path": str(pdf)})
    doc = client.get("/documents").json()[0]
    assert doc["page_numbering"] == "printed"
    assert doc["page_range"] == "341–343"
    client.patch(f"/documents/{doc['id']}", json={"authors": ["Alice Chen"], "year": 2021, "venue": "J. Sleep Res."})

    draft = client.post("/write/draft", json={"instruction": "REM sleep reactivation benefit"}).json()
    cite = next(c for s in draft["sentences"] for c in s["citations"] if c["page"] == 2)
    assert cite["page_label"] == "342"
    assert cite["label"] == "Chen 2021, p. 342"
    assert any(p["label"] == "Chen 2021, p. 342" for p in draft["passages"])  # what the model sees

    page = client.get(f"/documents/{doc['id']}/pages/2").json()
    assert (page["label"], page["page_numbering"]) == ("342", "printed")

    refs = lambda style: client.post("/references", json={"doc_ids": [doc["id"]], "style": style}).json()["entries"][0]
    assert "J. Sleep Res., 341–343." in refs("apa")
    assert "pp. 341–343" in refs("mla")
    assert "J. Sleep Res., pp. 341–343, 2021." in refs("ieee")
    assert "pages = {341--343}" in refs("bibtex")


def test_index_numbered_pdf_has_no_page_range_in_references(client, tmp_path):
    pdf = tmp_path / "notes.pdf"
    make_pdf(pdf)
    client.post("/ingest/path", json={"path": str(pdf)})
    doc = client.get("/documents").json()[0]
    assert (doc["page_numbering"], doc["page_range"]) == ("index", "")
    client.patch(f"/documents/{doc['id']}", json={"venue": "Lab notes"})
    apa = client.post("/references", json={"doc_ids": [doc["id"]], "style": "apa"}).json()["entries"][0]
    assert "Lab notes." in apa and "–" not in apa


def test_existing_library_is_migrated(tmp_path):
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript(
        "CREATE TABLE documents (id INTEGER PRIMARY KEY, source TEXT NOT NULL UNIQUE, kind TEXT NOT NULL);"
        "CREATE TABLE pages (doc_id INTEGER, page INTEGER, text TEXT, PRIMARY KEY (doc_id, page));"
        "INSERT INTO documents (source, kind) VALUES ('a.pdf', 'pdf');"
        "INSERT INTO pages VALUES (1, 1, 'hello');"
    )
    old.commit()
    old.close()
    conn = db.connect(path)
    assert conn.execute("SELECT page_numbering FROM documents").fetchone()[0] == "index"
    assert conn.execute("SELECT label FROM pages").fetchone()[0] is None


def test_junk_pdf_titles_yield_to_the_model():
    from app.ingest import is_junk_pdf_title

    for junk in ["vissing_jpe_2002.dvi", "Microsoft Word - Corrected_Huirong_WS.docx", "DAP_2200023 1..17",
                 "arXiv:2407.03498v2  [cs.CV]  13 Jul 2024", "Untitled", "", "   ", "x.pdf"]:
        assert is_junk_pdf_title(junk), junk
    for real in ["Stock Market Participation and the Internet", "Is financial inclusion good for bank stability?",
                 "Entropy and Transfer Entropy: The Dow Jones and the build up to the 1997 Asian Crisis"]:
        assert not is_junk_pdf_title(real), real
