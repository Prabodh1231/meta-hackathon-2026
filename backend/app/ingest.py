"""Turn files and URLs into page-addressed text. Each parser returns a ParsedDocument whose
`pages` list is what citations point into (page numbers are 1-based indexes into it)."""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .text_utils import sentence_spans

OCR = Callable[[bytes, str], str]

KINDS = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".pptx": "pptx",
    ".md": "text",
    ".markdown": "text",
    ".txt": "text",
    ".html": "html",
    ".htm": "html",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
}
_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


@dataclass
class ParsedDocument:
    kind: str
    pages: list[str]
    metadata: dict = field(default_factory=dict)  # title/authors/year/url found by the parser


def is_supported(path: Path) -> bool:
    return path.suffix.lower() in KINDS and not path.name.startswith((".", "~$"))


def parse_file(path: Path, ocr: OCR) -> ParsedDocument:
    kind = KINDS.get(path.suffix.lower())
    if kind is None:
        raise ValueError(f"Unsupported file type: {path.suffix or path.name}")
    if kind == "pdf":
        return _parse_pdf(path, ocr)
    if kind == "docx":
        return _parse_docx(path)
    if kind == "pptx":
        return _parse_pptx(path)
    if kind == "html":
        return _parse_html(path.read_text(encoding="utf-8", errors="replace"), url="")
    if kind == "image":
        return ParsedDocument("image", [ocr(path.read_bytes(), _MIME[path.suffix.lower()])])
    text = path.read_text(encoding="utf-8", errors="replace")
    return ParsedDocument("text", [text], {"title": _first_heading(text)})


def parse_url(url: str) -> ParsedDocument:
    import trafilatura

    html = trafilatura.fetch_url(url)
    if not html:
        raise ValueError(f"Could not fetch {url}")
    return _parse_html(html, url)


def _parse_pdf(path: Path, ocr: OCR) -> ParsedDocument:
    import fitz  # PyMuPDF

    pages = []
    with fitz.open(path) as doc:
        for page in doc:
            text = page.get_text("text")
            if len(text.strip()) < 20 and page.get_images():
                # Probably a scanned page: render it and OCR with the model.
                text = ocr(page.get_pixmap(dpi=200).tobytes("png"), "image/png")
            pages.append(text)
        meta = doc.metadata or {}
    authors = [a.strip() for a in (meta.get("author") or "").replace(";", ",").split(",") if a.strip()]
    return ParsedDocument("pdf", pages, {"title": meta.get("title") or "", "authors": authors})


def _parse_docx(path: Path) -> ParsedDocument:
    import docx

    d = docx.Document(str(path))
    text = "\n\n".join(p.text for p in d.paragraphs if p.text.strip())
    props = d.core_properties
    # core_properties.created is a file timestamp (python-docx even stamps 2013), not a
    # publication year, so the year is left to metadata extraction.
    authors = [props.author] if props.author else []
    return ParsedDocument("docx", [text], {"title": props.title or _first_heading(text), "authors": authors})


def _parse_pptx(path: Path) -> ParsedDocument:
    from pptx import Presentation

    pages = []
    for slide in Presentation(str(path)).slides:
        parts = [sh.text_frame.text for sh in slide.shapes if sh.has_text_frame and sh.text_frame.text.strip()]
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
            parts.append("Notes: " + slide.notes_slide.notes_text_frame.text)
        pages.append("\n".join(parts))
    return ParsedDocument("pptx", pages, {"title": pages[0].split("\n", 1)[0] if pages else ""})


def _parse_html(html: str, url: str) -> ParsedDocument:
    import trafilatura

    raw = trafilatura.extract(html, output_format="json", with_metadata=True, url=url or None)
    if not raw:
        raise ValueError("No readable text found in page")
    data = json.loads(raw)
    year = None
    if data.get("date") and str(data["date"])[:4].isdigit():
        year = int(str(data["date"])[:4])
    authors = [a.strip() for a in (data.get("author") or "").split(";") if a.strip()]
    meta = {"title": data.get("title") or "", "authors": authors, "year": year, "url": url, "venue": data.get("sitename") or ""}
    return ParsedDocument("web", [data.get("text") or ""], meta)


def _first_heading(text: str) -> str:
    for line in text.splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return line[:200]
    return ""


def chunk_page(text: str, max_chars: int = 900, overlap: int = 1) -> list[tuple[int, int]]:
    """Split a page into sentence-aligned (start, end) spans of at most ~max_chars,
    overlapping by `overlap` sentences so a quote rarely straddles two chunks."""
    spans = sentence_spans(text)
    out: list[tuple[int, int]] = []
    i = 0
    while i < len(spans):
        start, j = spans[i][0], i
        while j + 1 < len(spans) and spans[j + 1][1] - start <= max_chars:
            j += 1
        end = spans[j][1]
        if end - start > max_chars * 2:  # one enormous "sentence" (tables, code): hard split
            out.extend((s, min(s + max_chars, end)) for s in range(start, end, max_chars))
        else:
            out.append((start, end))
        if j + 1 >= len(spans):
            break
        i = max(j + 1 - overlap, i + 1)
    return out
