"""Reading Word documents in their own order, paragraphs and tables alike.

Used two ways: adding a .docx to the library as a source (plain text, tables included so
their contents can be searched and cited), and opening a .docx in the editor, as a new draft
or inserted into the open one (the editor's JSON: headings, paragraphs, bulleted and numbered
lists nested as in Word, quotes, bold, italic, underline, strikethrough, web links and line
breaks). The editor has no tables or images, so tables become one
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


class Numbering:
    """Word's list definitions, read once per document: (numId, level) -> number format
    ("bullet", "decimal", …). Searching the XML again for every paragraph is quadratic."""

    def __init__(self, document):
        self.formats: dict[tuple[str, str], str] = {}
        try:
            numbering = document.part.numbering_part.element
        except (KeyError, NotImplementedError):
            self.available = False
            return
        self.available = True
        abstract_levels: dict[str, dict[str, str]] = {}
        for a in numbering.findall(qn("w:abstractNum")):
            levels = abstract_levels.setdefault(a.get(qn("w:abstractNumId")), {})
            for lvl in a.findall(qn("w:lvl")):
                fmt = lvl.find(qn("w:numFmt"))
                levels[lvl.get(qn("w:ilvl"))] = fmt.get(qn("w:val")) if fmt is not None else "bullet"
        for num in numbering.findall(qn("w:num")):
            abstract = num.find(qn("w:abstractNumId"))
            levels = abstract_levels.get(abstract.get(qn("w:val")) if abstract is not None else "", {})
            for ilvl, fmt in levels.items():
                self.formats[(num.get(qn("w:numId")), ilvl)] = fmt

    def of(self, p: Paragraph) -> tuple[str, int] | None:
        """(number format, nesting level) of a numbered paragraph, or None if it isn't in a list."""
        ppr = p._p.pPr
        num_pr = ppr.numPr if ppr is not None else None
        if num_pr is None or num_pr.numId is None or num_pr.numId.val == 0:  # numId 0 switches numbering off
            return None
        ilvl = num_pr.ilvl.val if num_pr.ilvl is not None else 0
        if not self.available:
            return "bullet", ilvl
        return self.formats.get((str(num_pr.numId.val), str(ilvl)), "bullet"), ilvl


_LIST_STYLE = re.compile(r"^list (number|bullet)(?: (\d))?$")


def list_kind(numbering: Numbering, p: Paragraph) -> tuple[str, int] | None:
    """("bulletList" or "orderedList", nesting level from 0), or None. Uses the paragraph's own
    numbering, else its style name ("List Bullet 2" is a bullet one level in)."""
    found = numbering.of(p)
    if found is not None:
        fmt, level = found
        return ("bulletList" if fmt in ("bullet", "none") else "orderedList"), level
    m = _LIST_STYLE.match(_style_name(p).lower())
    if m:
        return ("orderedList" if m.group(1) == "number" else "bulletList"), int(m.group(2) or 1) - 1
    return None


def is_quote(p: Paragraph) -> bool:
    return _style_name(p).lower() in ("quote", "intense quote", "block text")


def _inline(p: Paragraph) -> list[dict]:
    """Text nodes with bold/italic/underline/strike and link marks; line breaks become hardBreak nodes."""
    out: list[dict] = []

    def add_run(run, href: str | None = None) -> None:
        flags = (("bold", run.bold), ("italic", run.italic), ("underline", run.underline), ("strike", run.font.strike))
        marks: list[dict] = [{"type": m} for m, on in flags if on]
        if href:
            marks.append({"type": "link", "attrs": {"href": href}})
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
            # Web and mail links only: an internal bookmark ("#_Toc…") points nowhere in the editor.
            href = item.address if re.match(r"^(https?|mailto):", item.address or "", re.I) else None
            for run in item.runs:
                add_run(run, href)
        else:
            add_run(item)
    while out and out[-1]["type"] == "hardBreak":
        out.pop()
    # Word splits text into runs freely; neighbours with the same formatting are one text node.
    merged: list[dict] = []
    for node in out:
        prev = merged[-1] if merged else None
        if prev and node["type"] == prev["type"] == "text" and node.get("marks") == prev.get("marks"):
            prev["text"] += node["text"]
        else:
            merged.append(node)
    return merged


def to_editor(data: bytes) -> tuple[dict, str, dict]:
    """A .docx as the editor's document JSON, a title for the draft, and counts of what was
    converted ("headings", "paragraphs", "list_items", "quotes", "links") or simplified
    ("tables", "images")."""
    document = docx.Document(io.BytesIO(data))
    numbering = Numbering(document)
    content: list[dict] = []
    stats = {"headings": 0, "paragraphs": 0, "list_items": 0, "quotes": 0, "links": 0, "tables": 0, "images": 0}
    first_text = ""
    lists: list[dict] = []  # the list open at each nesting level, outermost first

    def add_list_item(kind: str, level: int, inline: list[dict]) -> None:
        level = min(level, len(lists))  # Word can skip a level; the editor can't
        del lists[level + 1:]
        if level < len(lists) and lists[level]["type"] != kind:
            del lists[level:]  # bullets right after numbers at the same level start a new list
        if level == len(lists):
            new = {"type": kind, "content": []}
            if level == 0:
                content.append(new)
            else:  # nested inside the parent list's last item
                lists[level - 1]["content"][-1]["content"].append(new)
            lists.append(new)
        lists[level]["content"].append({"type": "listItem", "content": [{"type": "paragraph", "content": inline}]})

    for b in blocks(document):
        if isinstance(b, Table):
            lists.clear()
            rows = table_rows(b)
            if rows:
                stats["tables"] += 1
                content += [{"type": "paragraph", "content": [{"type": "text", "text": " | ".join(r)}]} for r in rows]
            continue
        stats["images"] += len(b._p.xpath(".//w:drawing | .//w:pict"))
        inline = _inline(b)
        if not any(n["type"] == "text" and n["text"].strip() for n in inline):
            continue
        stats["links"] += sum(any(m["type"] == "link" for m in n.get("marks", [])) for n in inline)
        first_text = first_text or b.text.strip()
        level = heading_level(b)
        in_list = None if level else list_kind(numbering, b)
        if in_list:
            stats["list_items"] += 1
            add_list_item(*in_list, inline)
            continue
        lists.clear()
        if level:
            stats["headings"] += 1
            content.append({"type": "heading", "attrs": {"level": level}, "content": inline})
        elif is_quote(b):
            stats["quotes"] += 1
            para = {"type": "paragraph", "content": inline}
            if content and content[-1]["type"] == "blockquote":
                content[-1]["content"].append(para)
            else:
                content.append({"type": "blockquote", "content": [para]})
        else:
            stats["paragraphs"] += 1
            content.append({"type": "paragraph", "content": inline})
    title = (document.core_properties.title or "").strip() or first_text[:80]
    return {"type": "doc", "content": content}, title, stats
