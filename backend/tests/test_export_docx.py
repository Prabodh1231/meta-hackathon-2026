import io

import docx
import fitz
import pytest
from fastapi.testclient import TestClient

from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings

CHEN_Q = "Spindle density after each cue predicted recall of the cued word pairs."
OKAFOR_Q = "Reefs exposed to moderate heat stress showed lower bleaching mortality."


@pytest.fixture
def setup(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    client = TestClient(create_app(settings, Library(settings, provider=MockProvider())))

    chen = tmp_path / "chen.pdf"
    d = fitz.open()
    for i, text in enumerate(["Introduction to sleep and memory research in adults.", CHEN_Q]):
        page = d.new_page()
        page.insert_textbox(fitz.Rect(72, 100, 520, 700), text, fontsize=10)
        page.insert_text((290, 815), str(341 + i), fontsize=8)
    d.save(chen)
    okafor = tmp_path / "okafor.md"
    okafor.write_text(f"# Reef notes\n{OKAFOR_Q}\n", encoding="utf-8")

    ids = {}
    for name, path, meta in [
        ("chen", chen, {"authors": ["Alice Chen", "Bob Martinez"], "year": 2021, "venue": "J. Sleep Res."}),
        ("okafor", okafor, {"authors": ["Dana Okafor"], "year": 2019, "venue": "Mar. Ecol."}),
    ]:
        doc = client.post("/ingest/path", json={"path": str(path)}).json()["results"][0]["document"]
        client.patch(f"/documents/{doc['id']}", json=meta)
        ids[name] = doc["id"]
    return client, ids


def chip(doc_id, page, quote, status="verified", reason=""):
    # Deliberately stale label: export must use the library's current page numbers.
    return {"type": "citation", "attrs": {"cid": f"c{doc_id}{page}", "docId": doc_id, "page": page, "quote": quote,
                                          "label": "stale label", "status": status, "reason": reason}}


def text(t, *marks):
    node = {"type": "text", "text": t}
    if marks:
        node["marks"] = [{"type": m} for m in marks]
    return node


def draft(ids, extra=()):
    return {"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 1}, "content": [text("Chapter 2")]},
        {"type": "paragraph", "content": [
            text("Spindles "), text("gate", "italic"), text(" reactivation. "), chip(ids["chen"], 2, CHEN_Q),
            text(" "), text("Reefs acclimate too. "), chip(ids["chen"], 2, CHEN_Q), text(" "),
            chip(ids["okafor"], 1, OKAFOR_Q), text(" "),
        ]},
        {"type": "bulletList", "content": [
            {"type": "listItem", "content": [{"type": "paragraph", "content": [text("A bullet")]}]},
        ]},
        {"type": "blockquote", "content": [{"type": "paragraph", "content": [text("Quoted words")]}]},
        *extra,
    ]}


def export(client, content, style):
    res = client.post("/export/docx", json={"content": content, "style": style, "title": "Chapter 2"})
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("application/vnd.openxmlformats")
    return docx.Document(io.BytesIO(res.content))


def paragraphs(d):
    return [(p.style.name, p.text) for p in d.paragraphs]


def test_apa_export(setup):
    client, ids = setup
    d = export(client, draft(ids), "apa")
    paras = paragraphs(d)
    assert paras[0] == ("Heading 1", "Chapter 2")
    # Citation moves inside the sentence; adjacent chips merge; page is the printed one.
    assert paras[1][1] == (
        "Spindles gate reactivation (Chen & Martinez, 2021, p. 342). "
        "Reefs acclimate too (Chen & Martinez, 2021, p. 342; Okafor, 2019). "
    )
    assert any(r.italic and r.text == "gate" for r in d.paragraphs[1].runs)
    assert paras[2] == ("List Bullet", "A bullet")
    assert paras[3] == ("Quote", "Quoted words")
    assert paras[4] == ("Heading 1", "References")
    refs = d.paragraphs[5:]
    assert [p.text.split(" (")[0] for p in refs] == ["Chen, A., & Martinez, B.", "Okafor, D."]
    assert "J. Sleep Res., 341–342." in refs[0].text
    assert refs[0].paragraph_format.first_line_indent < 0  # hanging indent
    assert d.core_properties.title == "Chapter 2"
    assert len(d.comments) == 0  # all verified: nothing flagged


def test_mla_export(setup):
    client, ids = setup
    paras = paragraphs(export(client, draft(ids), "mla"))
    assert "reactivation (Chen and Martinez 342)." in paras[1][1]
    assert "(Chen and Martinez 342; Okafor)." in paras[1][1]  # notes have no page numbers
    assert ("Heading 1", "Works Cited") in paras


def test_ieee_export_numbers_by_first_appearance(setup):
    client, ids = setup
    content = draft(ids)
    # Cite Okafor first so it becomes [1].
    content["content"].insert(1, {"type": "paragraph", "content": [text("Reefs first. "), chip(ids["okafor"], 1, OKAFOR_Q)]})
    paras = paragraphs(export(client, content, "ieee"))
    assert paras[1][1] == "Reefs first [1]."
    assert "reactivation [2, p. 342]." in paras[2][1]
    assert "[2, p. 342], [1]." in paras[2][1]
    refs = [t for _, t in paras[paras.index(("Heading 1", "References")) + 1 :]]
    assert refs[0].startswith("[1] D. Okafor") and refs[1].startswith("[2] A. Chen")


def test_unverified_and_missing_citations_get_word_comments(setup):
    client, ids = setup
    flagged = {"type": "paragraph", "content": [
        text("Overclaim. "), chip(ids["chen"], 2, CHEN_Q, status="unsupported", reason="Says recall, not memory."),
        text(" Gone. "), chip(999, 1, "A quote that exists nowhere in the library at all."),
    ]}
    d = export(client, draft(ids, extra=[flagged]), "apa")
    assert "Gone (missing source)." in d.paragraphs[4].text
    notes = [c.text for c in d.comments]
    assert len(notes) == 2
    assert "does not support" in notes[0] and "Says recall, not memory." in notes[0] and CHEN_Q in notes[0]
    assert "not found" in notes[1]
    assert all(c.author == "Research Companion" for c in d.comments)


def test_unconfirmed_cite_markers_leave_no_text_and_become_comments(setup):
    client, ids = setup
    found = [{"label": "Chen & Martinez 2021, p. 342", "quote": CHEN_Q, "status": "verified", "doc_id": ids["chen"]}]
    mark = lambda state, claim, results=(): {"type": "citeMark", "attrs": {  # noqa: E731
        "cid": f"k-{state}", "claim": claim, "state": state, "results": list(results)}}
    content = {"type": "doc", "content": [
        {"type": "paragraph", "content": [
            text("Spindles predict recall. "), mark("verified", "Spindles predict recall.", found),
            text(" Coral reefs glow at night. "), mark("none", "Coral reefs glow at night."),
        ]},
        {"type": "paragraph", "content": [mark("searching", "")]},  # nothing before it to comment on
    ]}
    d = export(client, content, "apa")
    assert d.paragraphs[0].text == "Spindles predict recall. Coral reefs glow at night."  # no "cite", no double spaces
    notes = [c.text for c in d.comments]
    assert len(notes) == 3
    assert "not confirmed" in notes[0] and "Best match: Chen & Martinez 2021, p. 342" in notes[0]
    assert "nothing in the library matches" in notes[1] and "Coral reefs glow at night." in notes[1]
    assert "hadn't finished" in notes[2]
    assert ("Heading 1", "References") not in paragraphs(d)  # an unconfirmed source isn't cited


def test_toolbar_fonts_and_sizes_carry_into_word(setup):
    client, _ = setup
    styled = lambda t, **attrs: {"type": "text", "text": t, "marks": [{"type": "textStyle", "attrs": attrs}, {"type": "bold"}]}
    content = {"type": "doc", "content": [{"type": "paragraph", "content": [
        styled("Serif", fontFamily='"Times New Roman", serif', fontSize="14pt"),
        styled(" pixels", fontSize="16px"),
        styled(" generic", fontFamily="monospace"),
    ]}]}
    runs = export(client, content, "apa").paragraphs[0].runs
    assert (runs[0].font.name, runs[0].font.size.pt, runs[0].bold) == ("Times New Roman", 14.0, True)
    assert (runs[1].font.name, runs[1].font.size.pt) == (None, 12.0)
    assert runs[2].font.name is None  # generic families have no Word equivalent: keep the default


def test_bibtex_is_not_a_document_style(setup):
    client, ids = setup
    res = client.post("/export/docx", json={"content": draft(ids), "style": "bibtex"})
    assert res.status_code == 400


def test_empty_draft_exports(setup):
    client, _ = setup
    d = export(client, {"type": "doc", "content": []}, "apa")
    assert [p.text for p in d.paragraphs] == []
