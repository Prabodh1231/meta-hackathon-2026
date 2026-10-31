"""Reference list formatting (APA 7, MLA 9, IEEE, BibTeX) from stored document metadata."""

import re

STYLES = ("apa", "mla", "ieee", "bibtex")


def _split_name(name: str) -> tuple[str, str]:
    """Return (last, first) for 'First Middle Last' or 'Last, First'."""
    name = name.strip()
    if "," in name:
        last, first = (p.strip() for p in name.split(",", 1))
        return last, first
    parts = name.split()
    if len(parts) == 1:
        return parts[0], ""
    return parts[-1], " ".join(parts[:-1])


def _initials(first: str) -> str:
    return " ".join(p[0] + "." for p in first.replace("-", " ").split() if p)


def _join(items: list[str], conj: str, oxford: bool = True) -> str:
    if len(items) <= 1:
        return "".join(items)
    if len(items) == 2:
        return f"{items[0]} {conj} {items[1]}"
    return ", ".join(items[:-1]) + ("," if oxford else "") + f" {conj} {items[-1]}"


def _link(doc: dict) -> str:
    if doc.get("doi"):
        return f"https://doi.org/{doc['doi']}"
    return doc.get("url") or ""


def _pp(doc: dict) -> str:
    """'pp. 341–355' from the printed page range; empty when only PDF indexes are known."""
    rng = doc.get("page_range") or ""
    if not rng:
        return ""
    return f"pp. {rng}" if "–" in rng else f"p. {rng}"


def _vol(doc: dict, style: str) -> list[str]:
    """Volume and issue as each style writes them: APA "12(3)", the others "vol. 12" and "no. 3"."""
    vol, issue = str(doc.get("volume") or ""), str(doc.get("issue") or "")
    if style == "apa":
        return [vol + (f"({issue})" if issue else "")] if vol else [f"({issue})"] if issue else []
    return [x for x in (vol and f"vol. {vol}", issue and f"no. {issue}") if x]


def _title(doc: dict) -> str:
    return (doc.get("title") or "Untitled").rstrip(".")


def apa(doc: dict) -> str:
    names = [_split_name(a) for a in doc.get("authors", [])][:20]
    authors = [f"{last}, {_initials(first)}".rstrip(", ") for last, first in names]
    if len(authors) >= 2:  # APA puts a comma before "&" even for two authors
        who = ", ".join(authors[:-1]) + ", & " + authors[-1]
    else:
        who = authors[0] if authors else _title(doc)
    year = doc.get("year") or "n.d."
    parts = [f"{who} ({year}).", f"{_title(doc)}." if authors else ""]
    if doc.get("venue"):
        parts.append(", ".join([doc["venue"], *_vol(doc, "apa"), *([doc["page_range"]] if doc.get("page_range") else [])]) + ".")
    parts.append(_link(doc))
    return " ".join(p for p in parts if p)


def mla(doc: dict) -> str:
    names = [_split_name(a) for a in doc.get("authors", [])]
    if not names:
        who = ""
    elif len(names) == 1:
        who = f"{names[0][0]}, {names[0][1]}".rstrip(", ") + "."
    elif len(names) == 2:
        who = f"{names[0][0]}, {names[0][1]}, and {names[1][1]} {names[1][0]}.".replace(" ,", ",")
    else:
        who = f"{names[0][0]}, {names[0][1]}, et al."
    parts = [who, f"“{_title(doc)}.”"]
    tail = ", ".join(str(x) for x in (doc.get("venue"), *_vol(doc, "mla"), doc.get("year"), _pp(doc)) if x)
    if tail:
        parts.append(tail + ".")
    link = _link(doc)
    if link:
        parts.append(link + ".")
    return " ".join(p for p in parts if p)


def ieee(doc: dict, n: int) -> str:
    names = [_split_name(a) for a in doc.get("authors", [])]
    formatted = [f"{_initials(first)} {last}".strip() for last, first in names]
    who = f"{formatted[0]} et al." if len(formatted) > 6 else _join(formatted, "and")
    parts = [f"[{n}]", f"{who}," if who else "", f"“{_title(doc)},”"]
    if doc.get("venue"):
        parts.append(f"{doc['venue']},")
    parts += [f"{v}," for v in _vol(doc, "ieee")]
    if _pp(doc):
        parts.append(f"{_pp(doc)},")
    parts.append(f"{doc['year']}." if doc.get("year") else "n.d.")
    if doc.get("doi"):
        parts.append(f"doi: {doc['doi']}.")
    elif doc.get("url"):
        parts.append(f"[Online]. Available: {doc['url']}")
    return " ".join(p for p in parts if p)


def bibtex_key(doc: dict) -> str:
    authors = doc.get("authors") or []
    last = _split_name(authors[0])[0] if authors else "anon"
    word = next((w for w in re.findall(r"[A-Za-z]+", _title(doc)) if len(w) > 3), "doc")
    return re.sub(r"[^A-Za-z0-9]", "", f"{last}{doc.get('year') or ''}{word}").lower()


def bibtex(doc: dict) -> str:
    entry = "online" if doc.get("kind") == "web" else "article" if doc.get("venue") else "misc"
    fields = {
        "title": _title(doc),
        "author": " and ".join(doc.get("authors") or []),
        "year": str(doc.get("year") or ""),
        "journal" if entry == "article" else "howpublished": doc.get("venue") or "",
        "volume": str(doc.get("volume") or ""),
        "number": str(doc.get("issue") or ""),
        "pages": (doc.get("page_range") or "").replace("–", "--"),
        "publisher": doc.get("publisher") or "",
        "doi": doc.get("doi") or "",
        "url": doc.get("url") or "",
    }
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields.items() if v)
    return f"@{entry}{{{bibtex_key(doc)},\n{body}\n}}"


def format_references(docs: list[dict], style: str) -> list[str]:
    style = style.lower()
    if style not in STYLES:
        raise ValueError(f"Unknown style {style!r}; expected one of {', '.join(STYLES)}")
    if style == "ieee":  # numbered in citation order
        return [ieee(d, i + 1) for i, d in enumerate(docs)]
    if style == "bibtex":
        return [bibtex(d) for d in docs]
    fmt = apa if style == "apa" else mla
    return sorted((fmt(d) for d in docs), key=str.lower)
