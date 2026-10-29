"""Export a draft (the editor's ProseMirror JSON) to .docx.

Citation chips become in-text citations in the chosen style (APA and MLA author-page,
IEEE numbered), moved before the sentence's closing punctuation as the styles require.
Adjacent chips merge into one citation, and a reference list closes the document. Every
chip is re-resolved against the library first, so page numbers are current. Citations
that didn't pass verification get a Word comment, so nothing questionable ships unnoticed.
"""

import io
import re
from dataclasses import dataclass

import docx
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt, RGBColor

from .references import _split_name, format_references

DOCX_STYLES = ("apa", "mla", "ieee")
REFERENCE_HEADING = {"apa": "References", "mla": "Works Cited", "ieee": "References"}
COMMENT_AUTHOR = "Research Companion"
FLAGS = {
    "weak": "Citation check: the source only partly supports this.",
    "unsupported": "Citation check: the source does not support this claim.",
    "quote_not_found": "Citation check: the quoted passage was not found in the source.",
    "pending": "Citation check: not verified yet.",
}
_END_PUNCT = re.compile(r"([.!?]+)(\s*)$")


@dataclass
class Cite:
    doc: dict | None  # None when the source is no longer in the library
    locator: str | None  # "342" or "slide 3"; None when there's no meaningful page
    status: str
    reason: str
    quote: str


def export_docx(library, content: dict, style: str, title: str = "") -> bytes:
    style = style.lower()
    if style not in DOCX_STYLES:
        raise ValueError(f"Word export supports {', '.join(DOCX_STYLES)}; got {style!r}")
    return _Writer(library, style).render(content, title)


class _Writer:
    def __init__(self, library, style: str):
        self.lib = library
        self.style = style
        self.doc = docx.Document()
        self.order: list[int] = []  # cited document ids in order of first appearance
        self._pages: dict = {}  # shared by every citation's lookup, so each document's pages are read once

    # ---------- citations ----------

    def _resolve(self, attrs: dict) -> Cite:
        status, reason = attrs.get("status") or "pending", attrs.get("reason") or ""
        r = self.lib.resolve_citation(attrs.get("docId") or 0, attrs.get("page") or 1, attrs.get("quote") or "",
                                      _cache=self._pages)
        if not r:
            return Cite(None, None, "quote_not_found", reason or "The passage is no longer in your library.",
                        attrs.get("quote") or "")
        doc = self.lib.get_document(r["doc_id"])
        if r["doc_id"] not in self.order:
            self.order.append(r["doc_id"])
        return Cite(doc, _locator(doc, r["page"], r["page_label"]), status, reason, attrs.get("quote") or "")

    def _in_text(self, cites: list[Cite]) -> str:
        if self.style == "ieee":
            parts = []
            for c in cites:
                if c.doc is None:
                    parts.append("[missing source]")
                    continue
                n = self.order.index(c.doc["id"]) + 1
                parts.append(f"[{n}, {_pp(c.locator)}]" if c.locator else f"[{n}]")
            return ", ".join(parts)
        parts = []
        for c in cites:
            if c.doc is None:
                parts.append("missing source")
            elif self.style == "apa":
                who = _who(c.doc, "&")
                parts.append(", ".join(x for x in (who, str(c.doc.get("year") or "n.d."), _pp(c.locator)) if x))
            else:  # MLA: (Author page), no comma, no "p."
                parts.append(" ".join(x for x in (_who(c.doc, "and"), c.locator or "") if x))
        return "(" + "; ".join(parts) + ")"

    # ---------- document structure ----------

    def render(self, content: dict, title: str) -> bytes:
        self.doc.core_properties.title = title or "Draft"
        self.doc.core_properties.author = ""
        for node in content.get("content") or []:
            self._block(node, list_depth=0)
        self._references()
        out = io.BytesIO()
        self.doc.save(out)
        return out.getvalue()

    def _block(self, node: dict, list_depth: int, list_style: str | None = None, quote: bool = False) -> None:
        kind = node.get("type")
        children = node.get("content") or []
        if kind == "paragraph":
            style = list_style or ("Quote" if quote else None)
            self._inline(self.doc.add_paragraph(style=style), children)
        elif kind == "heading":
            level = min(max(int((node.get("attrs") or {}).get("level") or 1), 1), 9)
            self._inline(self.doc.add_paragraph(style=f"Heading {level}"), children)
        elif kind in ("bulletList", "orderedList"):
            base = "List Bullet" if kind == "bulletList" else "List Number"
            depth = min(list_depth + 1, 3)
            for item in children:
                for i, child in enumerate(item.get("content") or []):
                    if child.get("type") in ("bulletList", "orderedList"):
                        self._block(child, depth, quote=quote)
                    else:
                        # The first paragraph carries the bullet; later ones continue the item.
                        style = (base if i == 0 else "List Continue") + ("" if depth == 1 else f" {depth}")
                        self._block(child, depth, list_style=style, quote=quote)
        elif kind == "blockquote":
            for child in children:
                self._block(child, list_depth, list_style, quote=True)
        elif kind == "codeBlock":
            p = self.doc.add_paragraph()
            run = p.add_run("".join(c.get("text", "") for c in children))
            run.font.name = "Consolas"
            run.font.size = Pt(9.5)
        elif kind == "horizontalRule":
            self.doc.add_paragraph("* * *").alignment = WD_ALIGN_PARAGRAPH.CENTER
        else:  # unknown block: keep its text rather than drop it
            self._inline(self.doc.add_paragraph(), children)

    def _inline(self, para, nodes: list[dict]) -> None:
        # Group adjacent citation chips (only whitespace between them) into one citation.
        items: list[list] = []  # ["text", str, marks] | ["cites", [Cite], suffix] | ["break"]
        for node in nodes:
            kind = node.get("type")
            if kind == "citation":
                cite = self._resolve(node.get("attrs") or {})
                if items and items[-1][0] == "cites":
                    items[-1][1].append(cite)
                elif len(items) >= 2 and items[-1][0] == "text" and not items[-1][1].strip() and items[-2][0] == "cites":
                    items.pop()
                    items[-1][1].append(cite)
                else:
                    items.append(["cites", [cite], ""])
            elif kind == "hardBreak":
                items.append(["break"])
            elif kind == "text":
                items.append(["text", node.get("text", ""), node.get("marks") or []])

        # Citations go before the sentence's closing punctuation: "… sleep (Chen, 2021)."
        for i, item in enumerate(items):
            if item[0] != "cites" or i == 0 or items[i - 1][0] != "text":
                continue
            prev = items[i - 1]
            m = _END_PUNCT.search(prev[1])
            if m:
                prev[1] = prev[1][: m.start()]
                item[2] = m.group(1)
            prev[1] = prev[1].rstrip() + " "

        for item in items:
            if item[0] == "text":
                _styled_run(para, item[1], item[2])
            elif item[0] == "break":
                para.add_run().add_break()
            else:
                cites, suffix = item[1], item[2]
                run = para.add_run(self._in_text(cites))
                for c in cites:
                    if c.status in FLAGS:
                        note = FLAGS[c.status] + (f" {c.reason}" if c.reason else "") + f"\nQuoted: “{c.quote}”"
                        self.doc.add_comment(run, text=note, author=COMMENT_AUTHOR, initials="RC")
                if suffix:
                    para.add_run(suffix)

    def _references(self) -> None:
        if not self.order:
            return
        docs = [self.lib.get_document(d) for d in self.order]
        self.doc.add_paragraph(style="Heading 1").add_run(REFERENCE_HEADING[self.style])
        for entry in format_references(docs, self.style):
            p = self.doc.add_paragraph(entry)
            if self.style in ("apa", "mla"):  # hanging indent
                p.paragraph_format.left_indent = Inches(0.5)
                p.paragraph_format.first_line_indent = Inches(-0.5)


def _styled_run(para, text: str, marks: list[dict]) -> None:
    if not text:
        return
    run = para.add_run(text)
    for mark in marks:
        kind = mark.get("type")
        if kind == "bold":
            run.bold = True
        elif kind == "italic":
            run.italic = True
        elif kind == "underline":
            run.underline = True
        elif kind == "strike":
            run.font.strike = True
        elif kind == "code":
            run.font.name = "Consolas"
        elif kind == "link":
            run.underline = True
            run.font.color.rgb = RGBColor(0x1F, 0x4E, 0xD8)
        elif kind == "textStyle":  # font family / size from the editor toolbar
            attrs = mark.get("attrs") or {}
            if family := _font_name(attrs.get("fontFamily")):
                run.font.name = family
            if size := _points(attrs.get("fontSize")):
                run.font.size = Pt(size)


_GENERIC_FONTS = {"serif", "sans-serif", "monospace", "system-ui", "cursive", "fantasy"}


def _font_name(css: str | None) -> str | None:
    """First concrete family in a CSS font-family list: '"Times New Roman", serif' -> 'Times New Roman'."""
    for name in (css or "").split(","):
        name = name.strip().strip("\"'")
        if name and name.lower() not in _GENERIC_FONTS:
            return name
    return None


def _points(css: str | None) -> float | None:
    """CSS font size to points: '14pt' -> 14, '16px' -> 12."""
    m = re.fullmatch(r"\s*([\d.]+)\s*(pt|px)\s*", css or "")
    if not m:
        return None
    value = float(m.group(1))
    return value if m.group(2) == "pt" else value * 0.75


def _locator(doc: dict, page: int, page_label: str | None) -> str | None:
    if doc.get("kind") == "pptx":
        return f"slide {page}"
    if doc.get("kind") != "pdf":
        return None  # notes, Word files and web pages have no stable pages
    if page_label:
        return page_label
    return str(page) if doc.get("page_numbering") == "index" else None


def _pp(locator: str | None) -> str:
    if not locator:
        return ""
    return locator if not locator[0].isdigit() else f"p. {locator}"


def _who(doc: dict, conj: str) -> str:
    """Author part of an in-text citation; a short quoted title when there are no authors."""
    lasts = [_split_name(a)[0] for a in doc.get("authors") or []]
    if not lasts:
        words = (doc.get("title") or "Untitled").split()
        return "“" + " ".join(words[:4]) + ("…" if len(words) > 4 else "") + "”"
    if len(lasts) == 1:
        return lasts[0]
    if len(lasts) == 2:
        return f"{lasts[0]} {conj} {lasts[1]}"
    return f"{lasts[0]} et al."
