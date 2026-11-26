"""The writing toolbar's formatting (desktop/src/editor/docFormat.ts) in Word and in the PDF/print page."""

import base64
import io

from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_COLOR_INDEX
from PIL import Image as PILImage

from test_export_docx import draft, export, setup, text  # noqa: F401 - setup is a fixture


def _png(w=40, h=20) -> str:
    out = io.BytesIO()
    PILImage.new("RGB", (w, h), (31, 92, 70)).save(out, "PNG")
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()


def marked(t, *marks):
    """A text node with marks given as (type, attrs) pairs or plain type names."""
    node = {"type": "text", "text": t, "marks": []}
    for m in marks:
        kind, attrs = (m, None) if isinstance(m, str) else m
        node["marks"].append({"type": kind, **({"attrs": attrs} if attrs else {})})
    return node


def test_paragraph_and_text_formatting_reach_word(setup):
    client, _ = setup
    content = {"type": "doc", "content": [
        {"type": "paragraph", "attrs": {"textAlign": "center", "lineHeight": "1.5", "indent": 2}, "content": [
            marked("red ", ("textStyle", {"textColor": "red"})),
            marked("green ", ("highlight", {"color": "green"})),
            marked("orange ", ("highlight", {"color": "orange"})),
            marked("2", "superscript"), marked("x", "subscript"),
            marked(" site", ("link", {"href": "https://example.org/a"})),
        ]},
    ]}
    d = export(client, content, "apa")
    p = d.paragraphs[0]
    assert p.alignment == WD_ALIGN_PARAGRAPH.CENTER
    assert p.paragraph_format.line_spacing == 1.5
    assert abs(p.paragraph_format.left_indent.inches - 1.0) < 0.01
    assert p.paragraph_format.space_after.pt == 10  # the draft keeps space between paragraphs
    runs = {r.text: r for r in p.iter_inner_content() if hasattr(r, "font")}
    assert str(runs["red "].font.color.rgb) == "B42318"
    assert runs["green "].font.highlight_color == WD_COLOR_INDEX.BRIGHT_GREEN
    assert 'w:fill="FFDFBD"' in runs["orange "]._r.xml  # no orange highlighter in Word: shaded
    assert runs["2"].font.superscript and runs["x"].font.subscript
    assert "<w:hyperlink" in p._p.xml and p.text.endswith(" site")
    assert "https://example.org/a" in [r.target_ref for r in d.part.rels.values() if r.is_external]


def test_tight_paragraphs_when_the_draft_says_so(setup):
    client, _ = setup
    d = export(client, {"type": "doc", "attrs": {"spaced": False}, "content": [{"type": "paragraph", "content": [text("One")]}]}, "apa")
    assert d.paragraphs[0].paragraph_format.space_after.pt == 0


def test_page_setup_default_and_chosen(setup):
    client, _ = setup
    body = [{"type": "paragraph", "content": [text("Words")]}]
    d = export(client, {"type": "doc", "content": body}, "apa")
    s = d.sections[0]
    assert round(s.page_width.inches, 2) == 8.27 and round(s.left_margin.inches, 2) == 1.0  # A4, normal
    assert 'w:instr="PAGE"' in s.footer.paragraphs[0]._p.xml  # page numbers
    assert "lnNumType" not in s._sectPr.xml

    page = {"size": "letter", "orientation": "landscape", "margins": "wide", "pageNumbers": False, "lineNumbers": True}
    d = export(client, {"type": "doc", "attrs": {"page": page}, "content": body}, "apa")
    s = d.sections[0]
    assert round(s.page_width.inches, 2) == 11.0 and round(s.page_height.inches, 2) == 8.5
    assert round(s.left_margin.inches, 2) == 1.25
    assert "PAGE" not in s.footer.paragraphs[0]._p.xml
    sect = s._sectPr.xml
    assert sect.index("lnNumType") < sect.index("w:cols")  # the order Word requires


def test_footnotes_become_word_footnotes(setup):
    client, _ = setup
    content = {"type": "doc", "content": [{"type": "paragraph", "content": [
        text("Claim"), {"type": "footnote", "attrs": {"note": "First note."}},
        text(" and more"), {"type": "footnote", "attrs": {"note": "Second & <last> note.\nOn two lines."}},
        text(" end."), {"type": "footnote", "attrs": {"note": "  "}},  # empty: left out
    ]}]}
    d = export(client, content, "apa")
    body = d.paragraphs[0]._p.xml
    assert body.count("<w:footnoteReference") == 2 and 'w:id="1"' in body and 'w:id="2"' in body
    part = next(r.target_part for r in d.part.rels.values() if r.reltype.endswith("/footnotes"))
    xml = part.blob.decode()
    assert part.partname == "/word/footnotes.xml"
    assert "First note." in xml and "Second &amp; &lt;last&gt; note." in xml and "On two lines." in xml
    assert 'w:type="separator" w:id="-1"' in xml


def test_table_of_contents_page_break_checklist_and_image(setup):
    client, _ = setup
    content = {"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 1}, "content": [text("The title")]},
        {"type": "tableOfContents"},
        {"type": "heading", "attrs": {"level": 2}, "content": [text("Methods")]},
        {"type": "heading", "attrs": {"level": 3}, "content": [text("Sample")]},
        {"type": "pageBreak"},
        {"type": "taskList", "content": [
            {"type": "taskItem", "attrs": {"checked": True}, "content": [{"type": "paragraph", "content": [text("Done thing")]}]},
            {"type": "taskItem", "attrs": {"checked": False}, "content": [{"type": "paragraph", "content": [text("To do")]}]},
        ]},
        {"type": "image", "attrs": {"src": _png(), "alt": "A green box", "size": "s", "align": "right"}},
        {"type": "image", "attrs": {"src": "data:image/svg+xml;base64,PHN2Zy8+", "alt": "Diagram"}},
    ]}
    d = export(client, content, "apa")
    texts = [p.text for p in d.paragraphs]
    # The contents list the headings, not the title, inside a TOC field Word can update.
    start = texts.index("Contents")
    assert texts[start + 1: start + 3] == ["Methods", "Sample"]
    xml = d.element.body.xml
    assert 'TOC \\o "1-3"' in xml and 'w:fldCharType="end"' in xml
    assert 'w:type="page"' in xml
    assert "☒ Done thing" in texts and "☐ To do" in texts
    pics = d.inline_shapes
    assert len(pics) == 1
    s = d.sections[0]
    assert abs(pics[0].width.inches - 0.35 * (s.page_width.inches - 2 * s.left_margin.inches)) < 0.02
    assert 'descr="A green box"' in xml
    assert any("Diagram" in t and "not included" in t for t in texts)  # SVG: named, not dropped silently


def test_comments_to_self_become_word_comments(setup):
    client, _ = setup
    c = ("comment", {"id": "n1", "note": "Check this number", "at": 1})
    content = {"type": "doc", "content": [{"type": "paragraph", "content": [
        text("Before "), marked("137 ", c), marked("countries", c, "bold"), text(" after."),
    ]}]}
    d = export(client, content, "apa")
    assert [(x.author, x.text) for x in d.comments] == [("Note to self", "Check this number")]


def test_html_page_for_pdf_and_print(setup):
    client, ids = setup
    content = draft(ids, extra=[
        {"type": "tableOfContents"},
        {"type": "heading", "attrs": {"level": 2}, "content": [text("Second part")]},
        {"type": "paragraph", "attrs": {"textAlign": "justify"}, "content": [
            text("Noted"), {"type": "footnote", "attrs": {"note": "A <note>."}},
            marked(" commented", ("comment", {"id": "n1", "note": "private"})),
        ]},
        {"type": "pageBreak"},
    ])
    content["attrs"] = {"page": {"size": "letter", "margins": "narrow"}}
    res = client.post("/export/html", json={"content": content, "style": "apa", "title": "Chapter <2>"})
    assert res.status_code == 200 and res.headers["content-type"].startswith("text/html")
    page = res.text
    assert "<title>Chapter &lt;2&gt;</title>" in page
    assert "@page { size: 8.5in 11.0in; margin: 0.5in 0.5in; }" in page
    assert "Spindles <i>gate</i> reactivation (Chen &amp; Martinez, 2021, p. 342)." in page
    assert '<section class="refs"><h1>References</h1>' in page and "Okafor, D." in page
    assert '<sup class="fn"><a href="#fn1">1</a></sup>' in page and '<li id="fn1">A &lt;note&gt;.</li>' in page
    # The first-line heading is the title: not in the contents, so the next heading is the first entry.
    assert 'href="#h0">Second part</a>' in page and '<h2 id="h0">Second part</h2>' in page
    assert "<h1>Chapter 2</h1>" in page
    assert '<p style="text-align:justify">' in page
    assert "private" not in page  # comments to self stay out of what gets sent
    assert '<div class="page-break"></div>' in page
