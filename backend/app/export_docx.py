"""Export a draft (the editor's ProseMirror JSON) to .docx, or to HTML for PDF and printing.

Citation chips become in-text citations in the chosen style (APA and MLA author-page,
IEEE numbered), moved before the sentence's closing punctuation as the styles require.
Adjacent chips merge into one citation, and a reference list closes the document. Every
chip is re-resolved against the library first, so page numbers are current. Citations
that didn't pass verification get a Word comment, so nothing questionable ships unnoticed.
A "cite" marker the writer never confirmed is left out of the text and becomes a comment on
its sentence, saying what the search found.

The writing toolbar's formatting comes along: alignment, line spacing, indents, colours and
highlights (stored by name in the draft), super/subscript, links, images, checklists, page
breaks, footnotes (real Word footnotes; notes at the end in PDF), a table of contents (a Word
TOC field), the writer's comments to self (Word comments) and the draft's page setup (paper,
margins, page numbers, line numbers). The names used here are the editor's (desktop/src/editor/
docFormat.ts): change both together.
"""

import base64
import html as _html
import io
import re
from dataclasses import dataclass
from datetime import date

import docx
from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_COLOR_INDEX
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.opc.packuri import PackURI
from docx.opc.part import Part
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

from .references import _split_name, format_references

DOCX_STYLES = ("apa", "mla", "ieee")
REFERENCE_HEADING = {"apa": "References", "mla": "Works Cited", "ieee": "References"}
COMMENT_AUTHOR = "Groundwork"
NOTE_AUTHOR = "Note to self"  # the writer's own comments
FLAGS = {
    "weak": "Citation check: the source only partly supports this.",
    "unsupported": "Citation check: the source does not support this claim.",
    "quote_not_found": "Citation check: the quoted passage was not found in the source.",
    "pending": "Citation check: not verified yet.",
}
# Said on every citation of a retracted paper, whatever its quote check found: the passage can be
# in the paper and the paper still withdrawn. Citing it stays allowed (a writer may mean to).
RETRACTED_FLAG = "Citation check: this source has been retracted. Check why before relying on it."
_END_PUNCT = re.compile(r"([.!?]+)(\s*)$")
# What an unconfirmed cite marker's search had found, for its comment.
MARK_STATE = {
    "searching": "the search for a source hadn't finished",
    "verified": "a supporting source was found but not confirmed",
    "weak": "only a partly supporting source was found",
    "unsupported": "no source in the library supports it",
    "none": "nothing in the library matches it",
    "error": "the search for a source didn't finish",
}

# ---------- the draft's page setup and formatting names (shared with docFormat.ts) ----------

PAPER = {"a4": (8.27, 11.69), "letter": (8.5, 11.0)}  # inches, portrait
MARGINS = {"narrow": (0.5, 0.5), "normal": (1.0, 1.0), "wide": (1.0, 1.25)}  # (top and bottom, sides), inches
DEFAULT_PAGE = {"size": "a4", "orientation": "portrait", "margins": "normal", "pageNumbers": True, "lineNumbers": False}
LINE_HEIGHTS = {"1.15": 1.15, "1.5": 1.5, "2": 2.0}
INDENT_STEP = 0.5  # inches per indent step
# The light theme's colours: what a printed page shows.
TEXT_HEX = {"red": "B42318", "orange": "B54708", "green": "1F7A4D", "blue": "175CD3", "purple": "6941C6", "grey": "667085"}
HIGHLIGHT_HEX = {"yellow": "FFF0A0", "green": "CDF3DB", "blue": "D4E6FF", "pink": "FFD6E5", "orange": "FFDFBD"}
# Word's own highlighter where it has the colour; orange it hasn't, so that one is shaded instead.
HIGHLIGHT_WORD = {"yellow": WD_COLOR_INDEX.YELLOW, "green": WD_COLOR_INDEX.BRIGHT_GREEN,
                  "blue": WD_COLOR_INDEX.TURQUOISE, "pink": WD_COLOR_INDEX.PINK}
FIGURE_WIDTH = {"s": 0.35, "m": 0.6, "l": 1.0}  # share of the text width
ALIGN_WORD = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER,
              "right": WD_ALIGN_PARAGRAPH.RIGHT, "justify": WD_ALIGN_PARAGRAPH.JUSTIFY}
CHECKBOX = {False: "☐ ", True: "☒ "}
BODY_SPACING = Pt(10)  # after a paragraph, when the draft keeps space between paragraphs
FOOTNOTES_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"
_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def page_setup(content: dict) -> dict:
    """The draft's page setup, with defaults for what it doesn't say (or says wrongly)."""
    given = ((content or {}).get("attrs") or {}).get("page") or {}
    page = dict(DEFAULT_PAGE)
    if given.get("size") in PAPER:
        page["size"] = given["size"]
    if given.get("orientation") in ("portrait", "landscape"):
        page["orientation"] = given["orientation"]
    if given.get("margins") in MARGINS:
        page["margins"] = given["margins"]
    for flag in ("pageNumbers", "lineNumbers"):
        if isinstance(given.get(flag), bool):
            page[flag] = given[flag]
    return page


def _text_of(node: dict) -> str:
    if node.get("type") == "text":
        return node.get("text") or ""
    return "".join(_text_of(c) for c in node.get("content") or [])


def contents_of(content: dict) -> list[tuple[dict, int, str]]:
    """(heading node, level, text) for a table of contents: levels 1 to 3, leaving out a first-line
    heading 1, which is the draft's title (as TableOfContents.tsx does)."""
    blocks = (content or {}).get("content") or []
    title = blocks[0] if blocks and blocks[0].get("type") == "heading" and ((blocks[0].get("attrs") or {}).get("level") or 1) == 1 else None
    out = []

    def walk(nodes):
        for n in nodes:
            if n.get("type") == "heading":
                level = int((n.get("attrs") or {}).get("level") or 1)
                text = _text_of(n).strip()
                if text and level <= 3 and n is not title:
                    out.append((n, level, text))
            elif n.get("content") and n.get("type") not in ("paragraph", "codeBlock"):
                walk(n["content"])

    walk(blocks)
    return out


def _image_bytes(src: str) -> tuple[bytes, str] | None:
    """A data-URL image as bytes Word can take (PNG, JPEG, GIF, BMP, TIFF; WebP is converted).
    Pictures that live on the web are not fetched: None, and the export says so in the text."""
    m = re.match(r"data:(image/[\w.+-]+);base64,(.*)$", src or "", re.S)
    if not m:
        return None
    mime, data = m.group(1).lower(), base64.b64decode(m.group(2))
    if mime in ("image/png", "image/jpeg", "image/jpg", "image/gif", "image/bmp", "image/tiff"):
        return data, mime
    if mime == "image/webp":
        try:
            from PIL import Image as PILImage

            out = io.BytesIO()
            PILImage.open(io.BytesIO(data)).save(out, "PNG")
            return out.getvalue(), "image/png"
        except Exception:  # noqa: BLE001 - an unreadable picture is left out, not the whole export
            return None
    return None  # SVG and the rest


@dataclass
class Cite:
    doc: dict | None  # None when the source is no longer in the library
    locator: str | None  # "342" or "slide 3"; None when there's no meaningful page
    status: str
    reason: str
    quote: str
    matrix: bool = False  # written from a review matrix and checked against it


def export_docx(library, content: dict, style: str, title: str = "", flag_pending: bool = True,
                landscape: bool = False) -> bytes:
    """`flag_pending=False` leaves citations that weren't judged yet without a comment (a review
    matrix's cells, whose quotes were found but not judged); `landscape` turns the page for wide tables."""
    style = style.lower()
    if style not in DOCX_STYLES:
        raise ValueError(f"Word export supports {', '.join(DOCX_STYLES)}; got {style!r}")
    return _DocxWriter(library, style, content, flag_pending, landscape).render(content, title)


def export_html(library, content: dict, style: str, title: str = "") -> str:
    """The draft as one HTML page for PDF and printing: the same citations and reference list as
    Word, the page setup as CSS. Footnotes are listed as notes at the end; the citation checks'
    comments and the writer's comments to self stay out (a PDF is what gets sent)."""
    style = style.lower()
    if style not in DOCX_STYLES:
        raise ValueError(f"PDF export supports {', '.join(DOCX_STYLES)}; got {style!r}")
    return _HtmlWriter(library, style, content).render(content, title)


class _Base:
    """What both outputs share: resolving citations, the in-text form, and a paragraph's inline items."""

    def __init__(self, library, style: str, content: dict, flag_pending: bool = True):
        self.lib = library
        self.style = style
        self.flag_pending = flag_pending
        self.page = page_setup(content)
        self.spaced = ((content or {}).get("attrs") or {}).get("spaced") is not False
        self.contents = contents_of(content)
        self.order: list[int] = []  # cited document ids in order of first appearance
        self._pages: dict = {}  # shared by every citation's lookup, so each document's pages are read once

    # ---------- citations ----------

    def _resolve(self, attrs: dict) -> Cite:
        status, reason = attrs.get("status") or "pending", attrs.get("reason") or ""
        if attrs.get("finding") and not attrs.get("quote"):
            # A gap from a review matrix cites each of the matrix's papers as a whole: no quote, no page.
            try:
                doc = self.lib.get_document(attrs.get("docId") or 0)
            except LookupError:
                return Cite(None, None, "quote_not_found", "The paper is no longer in your library.", "")
            if doc["id"] not in self.order:
                self.order.append(doc["id"])
            return Cite(doc, None, status, reason, "", True)
        r = self.lib.resolve_citation(attrs.get("docId") or 0, attrs.get("page") or 1, attrs.get("quote") or "",
                                      _cache=self._pages)
        if not r:
            return Cite(None, None, "quote_not_found", reason or "The passage is no longer in your library.",
                        attrs.get("quote") or "")
        doc = self.lib.get_document(r["doc_id"])
        if r["doc_id"] not in self.order:
            self.order.append(r["doc_id"])
        return Cite(doc, _locator(doc, r["page"], r["page_label"]), status, reason, attrs.get("quote") or "",
                    bool(attrs.get("finding")))

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

    # ---------- a paragraph's inline content ----------

    def _items(self, nodes: list[dict]) -> list[list]:
        """The paragraph as items: ["text", str, marks] | ["cites", [Cite], suffix] | ["break"] |
        ["mark", attrs] (an unconfirmed cite marker) | ["footnote", note]. Adjacent chips (only
        whitespace between them) merge into one citation, placed before the sentence's closing
        punctuation."""
        items: list[list] = []
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
            elif kind == "citeMark":
                items.append(["mark", node.get("attrs") or {}])
            elif kind == "footnote":
                items.append(["footnote", ((node.get("attrs") or {}).get("note") or "").strip()])

        # An unconfirmed marker leaves no text behind, and no double space where it stood.
        for i, item in enumerate(items):
            if item[0] != "mark":
                continue
            prev = next((x for x in reversed(items[:i]) if x[0] != "mark"), None)
            nxt = next((x for x in items[i + 1:] if x[0] != "mark"), None)
            if prev and prev[0] == "text" and prev[1].endswith(" ") and (nxt is None or (nxt[0] == "text" and nxt[1][:1].isspace())):
                prev[1] = prev[1].rstrip(" ")

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
        return items


# =====================================================================================
# Word
# =====================================================================================


class _DocxWriter(_Base):
    def __init__(self, library, style: str, content: dict, flag_pending: bool = True, landscape: bool = False):
        super().__init__(library, style, content, flag_pending)
        self.doc = docx.Document()
        self.footnotes: list[str] = []
        self.notes: dict[str, dict] = {}  # comment id -> {"note", "runs"}: the writer's comments to self
        section = self.doc.sections[0]
        width, height = PAPER[self.page["size"]]
        if landscape or self.page["orientation"] == "landscape":
            section.orientation = WD_ORIENT.LANDSCAPE
            width, height = height, width
        section.page_width, section.page_height = Inches(width), Inches(height)
        if landscape:  # a wide review matrix: narrow sides, whatever the page setup says
            vertical, sides = MARGINS[self.page["margins"]][0], 0.6
        else:
            vertical, sides = MARGINS[self.page["margins"]]
        section.top_margin = section.bottom_margin = Inches(vertical)
        section.left_margin = section.right_margin = Inches(sides)
        self.text_width = width - 2 * sides  # inches, for pictures
        if self.page["pageNumbers"]:
            _page_number_footer(section)
        if self.page["lineNumbers"]:
            _line_numbers(section)

    def render(self, content: dict, title: str) -> bytes:
        self.doc.core_properties.title = title or "Draft"
        self.doc.core_properties.author = ""
        for node in content.get("content") or []:
            self._block(node, list_depth=0)
        self._references()
        for note in self.notes.values():
            runs = note["runs"]
            if runs and note["note"]:
                self.doc.add_comment([runs[0], runs[-1]], text=note["note"], author=NOTE_AUTHOR, initials="N")
        self._save_footnotes()
        out = io.BytesIO()
        self.doc.save(out)
        return out.getvalue()

    # ---------- blocks ----------

    def _paragraph(self, style: str | None, attrs: dict | None, body: bool) -> object:
        """A new paragraph with the editor's paragraph formatting. `body` paragraphs (not list items
        or quotes) take the draft's space between paragraphs and its indent."""
        p = self.doc.add_paragraph(style=style)
        attrs = attrs or {}
        fmt = p.paragraph_format
        if attrs.get("textAlign") in ALIGN_WORD:
            p.alignment = ALIGN_WORD[attrs["textAlign"]]
        if str(attrs.get("lineHeight")) in LINE_HEIGHTS:
            fmt.line_spacing = LINE_HEIGHTS[str(attrs["lineHeight"])]
        if body:
            indent = int(attrs.get("indent") or 0)
            if indent > 0:
                fmt.left_indent = Inches(INDENT_STEP * min(indent, 8))
            if style is None:
                fmt.space_after = BODY_SPACING if self.spaced else Pt(0)
        return p

    def _block(self, node: dict, list_depth: int, list_style: str | None = None, quote: bool = False,
               prefix: str = "") -> None:
        kind = node.get("type")
        children = node.get("content") or []
        attrs = node.get("attrs") or {}
        if kind == "paragraph":
            style = list_style or ("Quote" if quote else None)
            p = self._paragraph(style, attrs, body=not list_style and not quote)
            if prefix:
                p.add_run(prefix)
                p.paragraph_format.left_indent = Inches(0.3 * max(list_depth, 1))
            self._inline(p, children)
        elif kind == "heading":
            level = min(max(int(attrs.get("level") or 1), 1), 9)
            self._inline(self._paragraph(f"Heading {level}", attrs, body=True), children)
        elif kind in ("bulletList", "orderedList"):
            base = "List Bullet" if kind == "bulletList" else "List Number"
            depth = min(list_depth + 1, 3)
            for item in children:
                for i, child in enumerate(item.get("content") or []):
                    if child.get("type") in ("bulletList", "orderedList", "taskList"):
                        self._block(child, depth, quote=quote)
                    else:
                        # The first paragraph carries the bullet; later ones continue the item.
                        style = (base if i == 0 else "List Continue") + ("" if depth == 1 else f" {depth}")
                        self._block(child, depth, list_style=style, quote=quote)
        elif kind == "taskList":
            depth = list_depth + 1
            for item in children:
                done = bool((item.get("attrs") or {}).get("checked"))
                for i, child in enumerate(item.get("content") or []):
                    if child.get("type") in ("bulletList", "orderedList", "taskList"):
                        self._block(child, depth, quote=quote)
                    else:
                        self._block(child, depth, quote=quote, prefix=CHECKBOX[done] if i == 0 else "   ")
        elif kind == "blockquote":
            for child in children:
                self._block(child, list_depth, list_style, quote=True)
        elif kind == "codeBlock":
            p = self.doc.add_paragraph()
            run = p.add_run("".join(c.get("text", "") for c in children))
            run.font.name = "Consolas"
            run.font.size = Pt(9.5)
        elif kind == "table":
            self._table(children)
        elif kind == "horizontalRule":
            self.doc.add_paragraph("* * *").alignment = WD_ALIGN_PARAGRAPH.CENTER
        elif kind == "pageBreak":
            self.doc.add_page_break()
        elif kind == "image":
            self._image(attrs)
        elif kind == "tableOfContents":
            self._toc()
        else:  # unknown block: keep its text rather than drop it
            self._inline(self.doc.add_paragraph(), children)

    def _table(self, rows: list[dict]) -> None:
        """A table from the editor (tableRow > tableHeader | tableCell > paragraphs), header row bold."""
        rows = [r for r in rows if r.get("type") == "tableRow"]
        width = max((sum(int((c.get("attrs") or {}).get("colspan") or 1) for c in r.get("content") or []) for r in rows), default=0)
        if not rows or not width:
            return
        table = self.doc.add_table(rows=len(rows), cols=width)
        table.style = "Table Grid"
        for i, row in enumerate(rows):
            j = 0
            for cell in row.get("content") or []:
                if j >= width:
                    break
                span = max(1, int((cell.get("attrs") or {}).get("colspan") or 1))
                target = table.cell(i, j)
                if span > 1:
                    target = target.merge(table.cell(i, min(width, j + span) - 1))
                paragraphs = [b for b in cell.get("content") or [] if b.get("type") in ("paragraph", "heading")] or [{}]
                for k, block in enumerate(paragraphs):
                    para = target.paragraphs[0] if k == 0 else target.add_paragraph()
                    if (block.get("attrs") or {}).get("textAlign") in ALIGN_WORD:
                        para.alignment = ALIGN_WORD[block["attrs"]["textAlign"]]
                    self._inline(para, block.get("content") or [])
                    for run in para.runs:
                        run.font.size = Pt(9)
                        if cell.get("type") == "tableHeader":
                            run.bold = True
                j += span
        self.doc.add_paragraph()

    def _image(self, attrs: dict) -> None:
        p = self.doc.add_paragraph()
        p.alignment = ALIGN_WORD.get(attrs.get("align") or "center", WD_ALIGN_PARAGRAPH.CENTER)
        got = _image_bytes(attrs.get("src") or "")
        if not got:
            alt = (attrs.get("alt") or "").strip()
            p.add_run(f"[Picture{': ' + alt if alt else ''} — not included; insert it in Word]").italic = True
            return
        share = FIGURE_WIDTH.get(attrs.get("size") or "m", 0.6)
        try:
            p.add_run().add_picture(io.BytesIO(got[0]), width=Inches(self.text_width * share))
        except Exception:  # noqa: BLE001 - a picture Word can't take is named, not fatal
            p.add_run("[Picture — not included; insert it in Word]").italic = True
            return
        alt = (attrs.get("alt") or "").strip()
        if alt:
            for pr in p._p.iter(qn("wp:docPr")):
                pr.set("descr", alt)

    def _toc(self) -> None:
        """A Word table-of-contents field. Its result already lists the headings, so it reads right
        before Word updates it; right-click → Update Field adds the page numbers."""
        head = self.doc.add_paragraph()
        head.add_run("Contents").bold = True
        entries = self.contents or [(None, 1, "Right-click and choose Update Field to list the headings.")]
        for i, (_node, level, text) in enumerate(entries):
            p = self.doc.add_paragraph()
            p.paragraph_format.left_indent = Inches(0.25 * (level - 1))
            p.paragraph_format.space_after = Pt(2)
            if i == 0:
                _field_char(p, "begin")
                instr = p.add_run()._r
                el = OxmlElement("w:instrText")
                el.set(qn("xml:space"), "preserve")
                el.text = ' TOC \\o "1-3" \\h \\z \\u '
                instr.append(el)
                _field_char(p, "separate")
            p.add_run(text)
            if i == len(entries) - 1:
                _field_char(p, "end")

    # ---------- inline ----------

    def _inline(self, para, nodes: list[dict]) -> None:
        last_run = None
        for item in self._items(nodes):
            if item[0] == "text":
                last_run = self._text_run(para, item[1], item[2]) or last_run
            elif item[0] == "break":
                para.add_run().add_break()
            elif item[0] == "mark":
                self._mark_comment(para, last_run, item[1])
            elif item[0] == "footnote":
                if item[1]:
                    last_run = self._footnote(para, item[1])
            else:
                cites, suffix = item[1], item[2]
                run = last_run = para.add_run(self._in_text(cites))
                for c in cites:
                    if c.doc is not None and c.doc.get("retracted"):
                        self.doc.add_comment(run, text=RETRACTED_FLAG, author=COMMENT_AUTHOR, initials="GW")
                    if c.status in FLAGS and (self.flag_pending or c.status != "pending"):
                        flag = FLAGS[c.status]
                        if c.matrix:
                            flag = flag.replace("the source", "the review matrix")
                        note = flag + (f" {c.reason}" if c.reason else "") + (f"\nQuoted: “{c.quote}”" if c.quote else "")
                        self.doc.add_comment(run, text=note, author=COMMENT_AUTHOR, initials="GW")
                if suffix:
                    para.add_run(suffix)

    def _text_run(self, para, text: str, marks: list[dict]):
        if not text:
            return None
        link = next(((m.get("attrs") or {}).get("href") for m in marks if m.get("type") == "link"), None)
        run = _styled_run(para, text, marks)
        if link and re.match(r"^(https?|mailto):", link, re.I):
            _into_hyperlink(para, run, link)
        for m in marks:
            if m.get("type") == "comment":
                a = m.get("attrs") or {}
                if a.get("id"):
                    self.notes.setdefault(a["id"], {"note": (a.get("note") or "").strip(), "runs": []})["runs"].append(run)
        return run

    def _footnote(self, para, note: str):
        """A footnote reference here, with its note kept for footnotes.xml."""
        self.footnotes.append(note)
        run = para.add_run()
        run.font.superscript = True
        ref = OxmlElement("w:footnoteReference")
        ref.set(qn("w:id"), str(len(self.footnotes)))
        run._r.append(ref)
        return run

    def _save_footnotes(self) -> None:
        """Word keeps footnotes in their own part, which python-docx doesn't make: write it here.
        Ids -1 and 0 are the separator lines Word puts above the notes, as Word itself writes them."""
        if not self.footnotes:
            return

        def esc(t: str) -> str:
            return _html.escape(t, quote=False)

        notes = []
        for i, note in enumerate(self.footnotes, 1):
            lines = note.split("\n")
            paras = []
            for k, line in enumerate(lines):
                ref = ('<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>'
                       '<w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve"> </w:t></w:r>') if k == 0 else ""
                paras.append(f'<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>{ref}'
                             f'<w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">{esc(line)}</w:t></w:r></w:p>')
            notes.append(f'<w:footnote w:id="{i}">{"".join(paras)}</w:footnote>')
        xml = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:footnotes xmlns:w="{_W}">'
               '<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
               '<w:r><w:separator/></w:r></w:p></w:footnote>'
               '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
               '<w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
               + "".join(notes) + "</w:footnotes>")
        part = Part(PackURI("/word/footnotes.xml"), FOOTNOTES_CT, xml.encode("utf-8"), self.doc.part.package)
        self.doc.part.relate_to(part, RT.FOOTNOTES)

    def _mark_comment(self, para, run, attrs: dict) -> None:
        """A comment on the text the marker followed (its sentence), saying what the search found."""
        state = attrs.get("state") or "searching"
        note = f"Citation not confirmed: {MARK_STATE.get(state, MARK_STATE['searching'])}."
        results = attrs.get("results") or []
        if results and state in ("verified", "weak"):
            note += f"\nBest match: {results[0].get('label', '')}, “{results[0].get('quote', '')}”"
        if attrs.get("claim"):
            note += f"\nSentence: “{attrs['claim']}”"
        self.doc.add_comment(run or para.add_run(" "), text=note, author=COMMENT_AUTHOR, initials="GW")

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


# Kept for callers that knew the writer by its old name.
_Writer = _DocxWriter


def _styled_run(para, text: str, marks: list[dict]):
    run = para.add_run(text)
    for mark in marks:
        kind = mark.get("type")
        attrs = mark.get("attrs") or {}
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
        elif kind == "superscript":
            run.font.superscript = True
        elif kind == "subscript":
            run.font.subscript = True
        elif kind == "link":
            run.underline = True
            run.font.color.rgb = RGBColor(0x1F, 0x4E, 0xD8)
        elif kind == "highlight":
            colour = attrs.get("color") or "yellow"
            if colour in HIGHLIGHT_WORD:
                run.font.highlight_color = HIGHLIGHT_WORD[colour]
            elif colour in HIGHLIGHT_HEX:
                _shade(run, HIGHLIGHT_HEX[colour])
        elif kind == "textStyle":  # font family / size / colour from the editor toolbar
            if family := _font_name(attrs.get("fontFamily")):
                run.font.name = family
            if size := _points(attrs.get("fontSize")):
                run.font.size = Pt(size)
            if attrs.get("textColor") in TEXT_HEX:
                run.font.color.rgb = RGBColor.from_string(TEXT_HEX[attrs["textColor"]])
    return run


def _shade(run, fill: str) -> None:
    """Shade a run's background (a highlight colour Word's highlighter doesn't have)."""
    rpr = run._r.get_or_add_rPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    rpr.insert_element_before(shd, "w:fitText", "w:vertAlign", "w:rtl", "w:cs", "w:em", "w:lang",
                              "w:eastAsianLayout", "w:specVanish", "w:oMath")


def _into_hyperlink(para, run, url: str) -> None:
    """Make a run a real link, opened from Word with Ctrl+click."""
    rid = para.part.relate_to(url, RT.HYPERLINK, is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), rid)
    run._r.addprevious(link)
    link.append(run._r)


def _field_char(para, kind: str) -> None:
    fc = OxmlElement("w:fldChar")
    fc.set(qn("w:fldCharType"), kind)
    para.add_run()._r.append(fc)


def _page_number_footer(section) -> None:
    p = section.footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    r = OxmlElement("w:r")
    t = OxmlElement("w:t")
    t.text = "1"
    r.append(t)
    field.append(r)
    p._p.append(field)


def _line_numbers(section) -> None:
    sect = section._sectPr
    ln = OxmlElement("w:lnNumType")
    ln.set(qn("w:countBy"), "1")
    ln.set(qn("w:restart"), "newPage")
    # The section's properties have a fixed order: line numbering comes before the columns.
    later = next((sect.find(qn(t)) for t in ("w:pgNumType", "w:cols", "w:formProt", "w:vAlign", "w:noEndnote",
                                            "w:titlePg", "w:textDirection", "w:bidi", "w:rtlGutter", "w:docGrid")
                  if sect.find(qn(t)) is not None), None)
    if later is not None:
        later.addprevious(ln)
    else:
        sect.append(ln)


# =====================================================================================
# HTML, for PDF and printing
# =====================================================================================

_HTML_FONTS = 'Charter, "Bitstream Charter", Georgia, "Times New Roman", serif'


class _HtmlWriter(_Base):
    def __init__(self, library, style: str, content: dict):
        super().__init__(library, style, content)
        self.anchors = {id(node): f"h{i}" for i, (node, _l, _t) in enumerate(self.contents)}
        self.notes: list[str] = []
        self.out: list[str] = []

    def render(self, content: dict, title: str) -> str:
        for node in content.get("content") or []:
            self._block(node)
        body = "".join(self.out)
        if self.notes:
            body += '<section class="notes"><h2>Notes</h2><ol>' + "".join(
                f'<li id="fn{i}">{_html.escape(n).replace(chr(10), "<br>")}</li>' for i, n in enumerate(self.notes, 1)) + "</ol></section>"
        if self.order:
            docs = [self.lib.get_document(d) for d in self.order]
            body += f'<section class="refs"><h1>{REFERENCE_HEADING[self.style]}</h1>' + "".join(
                f'<p class="ref {self.style}">{_html.escape(e)}</p>' for e in format_references(docs, self.style)) + "</section>"
        width, height = PAPER[self.page["size"]]
        if self.page["orientation"] == "landscape":
            width, height = height, width
        vertical, sides = MARGINS[self.page["margins"]]
        css = f"""
@page {{ size: {width}in {height}in; margin: {vertical}in {sides}in; }}
html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
body {{ margin: 0; font: 12pt/1.5 {_HTML_FONTS}; color: #111; }}
h1 {{ font-size: 20pt; margin: 18pt 0 8pt; }} h2 {{ font-size: 16pt; margin: 16pt 0 6pt; }} h3 {{ font-size: 13pt; margin: 14pt 0 4pt; }}
h1, h2, h3 {{ break-after: avoid; line-height: 1.25; }}
p {{ margin: 0 0 {"10pt" if self.spaced else "0"}; orphans: 2; widows: 2; }}
li p, td p, th p, blockquote p {{ margin: 0; }}
blockquote {{ margin: 0 0 10pt; padding-left: 14pt; border-left: 2.5pt solid #ccc; color: #444; }}
ul.tasks {{ list-style: none; padding-left: 4pt; }}
table {{ border-collapse: collapse; width: 100%; margin: 8pt 0 12pt; font-size: 9pt; line-height: 1.35; }}
th, td {{ border: 0.75pt solid #999; padding: 4pt 6pt; vertical-align: top; text-align: left; }}
th {{ background: #f0f0f0; }}
tr {{ break-inside: avoid; }}
figure {{ margin: 8pt 0; }} figure img {{ display: block; height: auto; }}
hr {{ border: 0; text-align: center; margin: 12pt 0; }} hr::after {{ content: "* * *"; }}
.page-break {{ break-after: page; }}
pre {{ font: 9.5pt Consolas, monospace; white-space: pre-wrap; }}
a {{ color: #1f4ed8; }}
sup.fn a {{ text-decoration: none; }}
nav.toc {{ margin: 0 0 14pt; }} nav.toc b {{ display: block; margin-bottom: 4pt; }}
nav.toc a {{ display: block; color: inherit; text-decoration: none; padding: 1pt 0; }}
nav.toc .l2 {{ padding-left: 14pt; }} nav.toc .l3 {{ padding-left: 28pt; }}
.notes {{ margin-top: 18pt; border-top: 0.75pt solid #999; font-size: 10pt; }} .notes h2 {{ font-size: 11pt; }}
.ref.apa, .ref.mla {{ padding-left: 0.5in; text-indent: -0.5in; }}
"""
        return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{_html.escape(title or "Draft")}</title>'
                f"<style>{css}</style></head><body>{body}</body></html>")

    # ---------- blocks ----------

    def _pstyle(self, attrs: dict, body: bool = True) -> str:
        css = []
        if attrs.get("textAlign") in ALIGN_WORD:
            css.append(f"text-align:{attrs['textAlign']}")
        if str(attrs.get("lineHeight")) in LINE_HEIGHTS:
            css.append(f"line-height:{LINE_HEIGHTS[str(attrs['lineHeight'])]}")
        if body and int(attrs.get("indent") or 0) > 0:
            css.append(f"margin-left:{INDENT_STEP * min(int(attrs['indent']), 8)}in")
        return f' style="{";".join(css)}"' if css else ""

    def _block(self, node: dict, body: bool = True) -> None:
        kind = node.get("type")
        children = node.get("content") or []
        attrs = node.get("attrs") or {}
        w = self.out.append
        if kind == "paragraph":
            w(f"<p{self._pstyle(attrs, body)}>{self._inline(children) or '&nbsp;'}</p>")
        elif kind == "heading":
            level = min(max(int(attrs.get("level") or 1), 1), 6)
            anchor = self.anchors.get(id(node))
            id_attr = f' id="{anchor}"' if anchor else ""
            w(f"<h{level}{id_attr}{self._pstyle(attrs)}>{self._inline(children)}</h{level}>")
        elif kind in ("bulletList", "orderedList"):
            tag = "ul" if kind == "bulletList" else "ol"
            w(f"<{tag}>")
            for item in children:
                w("<li>")
                for child in item.get("content") or []:
                    self._block(child, body=False)
                w("</li>")
            w(f"</{tag}>")
        elif kind == "taskList":
            w('<ul class="tasks">')
            for item in children:
                done = bool((item.get("attrs") or {}).get("checked"))
                w(f"<li>{CHECKBOX[done]}")
                for child in item.get("content") or []:
                    if child.get("type") == "paragraph":
                        w(self._inline(child.get("content") or []))
                    else:
                        self._block(child, body=False)
                w("</li>")
            w("</ul>")
        elif kind == "blockquote":
            w("<blockquote>")
            for child in children:
                self._block(child, body=False)
            w("</blockquote>")
        elif kind == "codeBlock":
            w(f"<pre>{_html.escape(''.join(c.get('text', '') for c in children))}</pre>")
        elif kind == "table":
            w("<table>")
            for row in children:
                w("<tr>")
                for cell in row.get("content") or []:
                    tag = "th" if cell.get("type") == "tableHeader" else "td"
                    span = int((cell.get("attrs") or {}).get("colspan") or 1)
                    span_attr = f' colspan="{span}"' if span > 1 else ""
                    w(f"<{tag}{span_attr}>")
                    for block in cell.get("content") or []:
                        self._block(block, body=False)
                    w(f"</{tag}>")
                w("</tr>")
            w("</table>")
        elif kind == "horizontalRule":
            w("<hr>")
        elif kind == "pageBreak":
            w('<div class="page-break"></div>')
        elif kind == "image":
            src = attrs.get("src") or ""
            if src.startswith("data:image/"):
                share = FIGURE_WIDTH.get(attrs.get("size") or "m", 0.6) * 100
                margin = {"left": "0 auto 0 0", "right": "0 0 0 auto"}.get(attrs.get("align") or "", "0 auto")
                w(f'<figure><img src="{_html.escape(src)}" alt="{_html.escape(attrs.get("alt") or "")}" '
                  f'style="width:{share:g}%;margin:{margin}"></figure>')
        elif kind == "tableOfContents":
            w("<nav class=\"toc\"><b>Contents</b>" + "".join(
                f'<a class="l{level}" href="#{self.anchors[id(n)]}">{_html.escape(text)}</a>' for n, level, text in self.contents) + "</nav>")
        else:
            w(f"<p>{self._inline(children)}</p>")

    # ---------- inline ----------

    def _inline(self, nodes: list[dict]) -> str:
        parts = []
        for item in self._items(nodes):
            if item[0] == "text":
                parts.append(_html_run(item[1], item[2]))
            elif item[0] == "break":
                parts.append("<br>")
            elif item[0] == "footnote":
                if item[1]:
                    self.notes.append(item[1])
                    n = len(self.notes)
                    parts.append(f'<sup class="fn"><a href="#fn{n}">{n}</a></sup>')
            elif item[0] == "cites":
                parts.append(_html.escape(self._in_text(item[1])) + _html.escape(item[2]))
        return "".join(parts)


def _html_run(text: str, marks: list[dict]) -> str:
    out = _html.escape(text)
    styles = []
    for mark in marks:
        kind = mark.get("type")
        attrs = mark.get("attrs") or {}
        tag = {"bold": "b", "italic": "i", "underline": "u", "strike": "s", "code": "code",
               "superscript": "sup", "subscript": "sub"}.get(kind)
        if tag:
            out = f"<{tag}>{out}</{tag}>"
        elif kind == "link" and re.match(r"^(https?|mailto):", attrs.get("href") or "", re.I):
            out = f'<a href="{_html.escape(attrs["href"])}">{out}</a>'
        elif kind == "highlight":
            styles.append(f"background:#{HIGHLIGHT_HEX.get(attrs.get('color') or 'yellow', HIGHLIGHT_HEX['yellow'])}")
        elif kind == "textStyle":
            if family := _font_name(attrs.get("fontFamily")):
                styles.append(f"font-family:'{family}'")
            if size := _points(attrs.get("fontSize")):
                styles.append(f"font-size:{size:g}pt")
            if attrs.get("textColor") in TEXT_HEX:
                styles.append(f"color:#{TEXT_HEX[attrs['textColor']]}")
    if styles:
        out = f'<span style="{_html.escape(";".join(styles))}">{out}</span>'
    return out


READING_ORDERS = ("author", "year")
STYLE_NAME = {"apa": "APA 7", "mla": "MLA 9", "ieee": "IEEE"}


def _reading_key(order: str):
    """By first author's surname (then year, title), or by year, oldest first (then author)."""
    def key(d: dict):
        last = _split_name(d["authors"][0])[0].lower() if d.get("authors") else (d.get("title") or "").lower()
        year = d.get("year") or 9999  # undated last
        title = (d.get("title") or "").lower()
        return (year, last, title) if order == "year" else (last, year, title)
    return key


def export_reading_list(library, highlights, doc_ids: list[int], style: str, title: str = "",
                        order: str = "author") -> bytes:
    """An annotated reading list: for each paper its reference in `style`, the summary Muse wrote
    when it was added, and the reader's highlights and notes with their pages. The user's own
    reading notes come last, apart from the papers. Built from what is stored; no model calls."""
    style, order = style.lower(), order.lower()
    if style not in DOCX_STYLES:
        raise ValueError(f"A reading list is written in {', '.join(DOCX_STYLES)}; got {style!r}")
    if order not in READING_ORDERS:
        raise ValueError(f"A reading list is ordered by {' or '.join(READING_ORDERS)}; got {order!r}")
    ids = list(dict.fromkeys(doc_ids))
    if not ids:
        raise ValueError("Choose at least one paper for the reading list")
    docs = [library.get_document(i) for i in ids]  # LookupError for one that's gone
    key = _reading_key(order)
    papers = sorted((d for d in docs if d.get("kind") != "text"), key=key)
    notes = sorted((d for d in docs if d.get("kind") == "text"), key=key)

    out = docx.Document()
    title = " ".join(title.split()) or "Reading list"
    out.core_properties.title = title
    out.core_properties.author = ""
    out.add_paragraph(style="Title").add_run(title)
    counts = [f"{len(papers)} paper{'s' if len(papers) != 1 else ''}"] + (
        [f"{len(notes)} note{'s' if len(notes) != 1 else ''}"] if notes else [])
    made = date.today()
    sub = out.add_paragraph(" · ".join([" and ".join(counts), f"by {order}", STYLE_NAME[style],
                                        f"{made.day} {made.strftime('%B %Y')}"]))
    sub.runs[0].font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    def entry(d: dict, n: int) -> None:
        # One paper at a time: format_references sorts APA and MLA lists itself, and this order is the reader's.
        ref = format_references([d], style)[0]
        if style == "ieee":
            ref = re.sub(r"^\[1\]", f"[{n}]", ref)
        p = out.add_paragraph(ref)
        p.paragraph_format.space_before = Pt(12)
        p.paragraph_format.left_indent = Inches(0.5)
        p.paragraph_format.first_line_indent = Inches(-0.5)
        if d.get("summary") and d.get("kind") != "text":
            _label(out, "Summary (by Muse)")
            _markdown(out, d["summary"])
        marks = highlights.for_document(d["id"])
        if marks:
            _label(out, "Your highlights")
        for h in marks:
            q = out.add_paragraph()
            q.paragraph_format.left_indent = Inches(0.25)
            q.add_run(f"“{h['text']}”")
            where = _pp(_locator(d, h["page"], h.get("page_label")))
            if where:
                q.add_run(f" ({where})").font.color.rgb = RGBColor(0x66, 0x66, 0x66)
            if h.get("note"):
                note = out.add_paragraph()
                note.paragraph_format.left_indent = Inches(0.5)
                note.add_run(f"Note: {h['note']}").italic = True

    for n, d in enumerate(papers, 1):
        entry(d, n)
    if notes:
        out.add_paragraph(style="Heading 1").add_run("Your notes")
        for n, d in enumerate(notes, len(papers) + 1):
            entry(d, n)
    buf = io.BytesIO()
    out.save(buf)
    return buf.getvalue()


_EMPHASIS = re.compile(r"(\*\*[^*\n]+\*\*|\*[^*\n]+\*)")


def _markdown(out, text: str) -> None:
    """A summary as Muse wrote it: paragraphs split by blank lines, **bold** and *italic* kept as
    such rather than printed with their asterisks (some summaries are written that way)."""
    for block in re.split(r"\n\s*\n", text.strip()):
        para = out.add_paragraph()
        for part in _EMPHASIS.split(" ".join(block.split())):
            if part.startswith("**") and part.endswith("**") and len(part) > 4:
                para.add_run(part[2:-2]).bold = True
            elif part.startswith("*") and part.endswith("*") and len(part) > 2:
                para.add_run(part[1:-1]).italic = True
            elif part:
                para.add_run(part)


def _label(out, text: str) -> None:
    run = out.add_paragraph().add_run(text)
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
    run.bold = True


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
