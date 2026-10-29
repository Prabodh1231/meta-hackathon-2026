"""Reading Word documents in their own order, paragraphs and tables alike.

Used two ways: adding a .docx to the library as a source (plain text, tables included so
their contents can be searched and cited), and opening a .docx in the editor as a new draft
(the editor's JSON: headings, paragraphs, bulleted and numbered lists, bold, italic,
underline and line breaks). The editor has no tables or images, so tables become one
paragraph per row with cells separated by " | ", and images are left out; both are counted
so the user is told.
"""

import io
import re
from collections.abc import Iterator

import docx
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.hyperlink import Hyperlink
from docx.text.paragraph import Paragraph

_HEADING = re.compile(r"^heading\s*(\d)$", re.I)


def blocks(document) -> Iterator[Paragraph | Table]:
    """Top-level paragraphs and tables, in the order they appear in the document."""
    for child in document.element.body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, document)
        elif child.tag == qn("w:tbl"):
            yield Table(child, document)


def table_rows(table: Table) -> list[list[str]]:
    rows = []
    for row in table.rows:
        cells, seen = [], set()
        for cell in row.cells:  # a merged cell is returned once per grid column it spans
            if id(cell._tc) in seen:
                continue
            seen.add(id(cell._tc))
            cells.append(" ".join(p.text.strip() for p in cell.paragraphs if p.text.strip()))
        if any(cells):
            rows.append(cells)
    return rows


def plain_text(document) -> str:
    """The document's text for the library: paragraphs, then each table row as "a | b | c"."""
    parts = []
    for b in blocks(document):
        if isinstance(b, Paragraph):
            if b.text.strip():
                parts.append(b.text)
        else:
            rows = table_rows(b)
            if rows:
                parts.append("\n".join(" | ".join(r) for r in rows))
    return "\n\n".join(parts)


def _style_name(p: Paragraph) -> str:
    try:
        return (p.style.name or "") if p.style is not None else ""
    except (KeyError, ValueError):
        return ""


def heading_level(p: Paragraph) -> int | None:
    name = _style_name(p)
    if name.lower() == "title":
        return 1
    m = _HEADING.match(name)
    return min(max(int(m.group(1)), 1), 6) if m else None


def _num_format(document, p: Paragraph) -> str | None:
    """Word's number format for a numbered paragraph ("bullet", "decimal", …), or None if it isn't in a list."""
    ppr = p._p.pPr
    num_pr = ppr.numPr if ppr is not None else None
    if num_pr is None or num_pr.numId is None or num_pr.numId.val == 0:  # numId 0 switches numbering off
        return None
    ilvl = num_pr.ilvl.val if num_pr.ilvl is not None else 0
    try:
        numbering = document.part.numbering_part.element
    except (KeyError, NotImplementedError):
        return "bullet"
    for num in numbering.findall(qn("w:num")):
        if num.get(qn("w:numId")) != str(num_pr.numId.val):
            continue
        abstract = num.find(qn("w:abstractNumId"))
        for a in numbering.findall(qn("w:abstractNum")):
            if abstract is not None and a.get(qn("w:abstractNumId")) == abstract.get(qn("w:val")):
                for lvl in a.findall(qn("w:lvl")):
                    if lvl.get(qn("w:ilvl")) == str(ilvl):
                        fmt = lvl.find(qn("w:numFmt"))
                        return fmt.get(qn("w:val")) if fmt is not None else "bullet"
    return "bullet"


def list_kind(document, p: Paragraph) -> str | None:
    """"bulletList", "orderedList" or None. Uses the paragraph's own numbering, else its style name."""
    fmt = _num_format(document, p)
    if fmt is not None:
        return "bulletList" if fmt in ("bullet", "none") else "orderedList"
    name = _style_name(p).lower()
    if "list number" in name:
        return "orderedList"
    if "list bullet" in name:
        return "bulletList"
    return None


def _inline(p: Paragraph) -> list[dict]:
    """Text nodes with bold/italic/underline marks; line breaks become hardBreak nodes."""
    out: list[dict] = []

    def add_run(run) -> None:
        marks = [{"type": m} for m, on in (("bold", run.bold), ("italic", run.italic), ("underline", run.underline)) if on]
        for i, piece in enumerate(run.text.replace("\t", " ").split("\n")):
            if i:
                out.append({"type": "hardBreak"})
            if piece:
                node = {"type": "text", "text": piece}
                if marks:
                    node["marks"] = marks
                out.append(node)

    for item in p.iter_inner_content():
        if isinstance(item, Hyperlink):
            for run in item.runs:
                add_run(run)
        else:
            add_run(item)
    while out and out[-1]["type"] == "hardBreak":
        out.pop()
    return out


def to_editor(data: bytes) -> tuple[dict, str, dict]:
    """A .docx as the editor's document JSON, a title for the draft, and counts of what was
    converted ("headings", "paragraphs", "list_items") or simplified ("tables", "images")."""
    document = docx.Document(io.BytesIO(data))
    content: list[dict] = []
    stats = {"headings": 0, "paragraphs": 0, "list_items": 0, "tables": 0, "images": 0}
    first_text = ""
    for b in blocks(document):
        if isinstance(b, Table):
            rows = table_rows(b)
            if rows:
                stats["tables"] += 1
                content += [{"type": "paragraph", "content": [{"type": "text", "text": " | ".join(r)}]} for r in rows]
            continue
        stats["images"] += len(b._p.xpath(".//w:drawing | .//w:pict"))
        inline = _inline(b)
        if not any(n["type"] == "text" and n["text"].strip() for n in inline):
            continue
        first_text = first_text or b.text.strip()
        level = heading_level(b)
        kind = None if level else list_kind(document, b)
        if level:
            stats["headings"] += 1
            content.append({"type": "heading", "attrs": {"level": level}, "content": inline})
        elif kind:
            stats["list_items"] += 1
            item = {"type": "listItem", "content": [{"type": "paragraph", "content": inline}]}
            if content and content[-1]["type"] == kind:
                content[-1]["content"].append(item)
            else:
                content.append({"type": kind, "content": [item]})
        else:
            stats["paragraphs"] += 1
            content.append({"type": "paragraph", "content": inline})
    title = (document.core_properties.title or "").strip() or first_text[:80]
    return {"type": "doc", "content": content}, title, stats
