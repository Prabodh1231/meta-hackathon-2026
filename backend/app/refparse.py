"""Reference lists: find the section, split it into entries, read each entry's fields, and match
entries to documents already in the library. Local and deterministic; a model can read the
fields of the entries this finds, but segmenting and matching stay here."""

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache

_HEADING = re.compile(
    r"^\s*(?:(?:\d+|[IVX]+)\.?\s*)?(?:references|bibliography|reference list|works cited|literature cited)"
    r"(?:\s+and\s+notes)?\s*:?\s*$",
    re.I | re.M,
)
_AFTER_REFERENCES = re.compile(r"^\s*(?:appendix|appendices|supplementary|supporting information)\b", re.I | re.M)
_NUMBERED = re.compile(r"^\s*(?:\[(\d{1,3})\.?\]|\((\d{1,3})\)|(\d{1,3})\.)\s+(?=\S)")
# "Allen, F.," "Abel, Andrew B.," "Abraham A," -- how an author-led entry begins.
_LETTER = r"[^\W\d_]"
_AUTHOR_LED = re.compile(
    rf"^(?:{_LETTER}[^\W\d_'’`\-]*(?:['’`\-]{_LETTER}+)?(?:\s(?:de|van|von|der|di|le|la|del|da|al|el|bin|ben)?\s?{_LETTER}[\w'’`\-]+)*"
    rf"(?:,\s+(?:{_LETTER}\.|{_LETTER}{{2,}})|\s+[A-Z]{{1,3}}[\s,(])"
    rf"|(?:[A-Z]\.\s?){{1,3}}{_LETTER}[\w'’`\-]{{2,}}[,.\s]"  # initials first: "A. Akerman, I. Gaarder"
    rf"|{_LETTER}[\w'’`\-]+\s+{_LETTER}[\w'’`\-]+,\s+(?:19|20)\d{{2}}[a-z]?[.,\s])"  # "Vissing-Jorgensen Annette, 2003."
)
_DOI = re.compile(r"10\.\d{4,9}/[^\s\"<>,;)\]]+", re.I)
_YEAR_PAREN = re.compile(r"\(\s*((?:19|20)\d{2})[a-z]?\s*\)")
_YEAR_ANY = re.compile(r"(?<![\d/])((?:19|20)\d{2})[a-z]?(?![\d/])")
_VENUE = re.compile(
    r"\b(?:journal|review|proceedings|quarterly|letters|transactions|econometrica|annals|bulletin|"
    r"working paper|conference|economics|finance|science|econ|financ)\b",
    re.I,
)
_QUOTED = re.compile(r"[\"“”‘’']([^\"“”]{12,}?)[,.]?[\"“”’']")


@lru_cache(maxsize=65536)
def norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


@dataclass
class Reference:
    raw: str
    number: int | None = None  # the [n] it was listed under, when numbered
    year: int | None = None
    doi: str = ""
    title: str = ""
    first_author: str = ""  # surname when it can be told


def find_section(text: str) -> str:
    """The reference list at the end of a paper ('' if none): from the last References heading
    that has a real list after it, up to any appendix."""
    for m in reversed(list(_HEADING.finditer(text))):
        section = text[m.end():]
        if len(section.strip()) < 300:
            continue
        cut = _AFTER_REFERENCES.search(section, 200)
        section = (section[: cut.start()] if cut else section).strip()
        section = re.sub("­\\s*\\n?\\s*", "", section)  # soft hyphens, which mark a word split across lines
        return re.sub("[‐‑‒−]", "-", section)  # typographic hyphens -> "-" (not the en dash of page ranges)
    return ""


def _join(lines: list[str]) -> str:
    """Hard-wrapped lines back into one string; 'bor-' 'der' rejoins, 'Sub-' 'Saharan' keeps its hyphen."""
    out = ""
    for line in (l.strip() for l in lines):
        if out.endswith("-") and line[:1].islower():
            out = out[:-1] + line
        elif out.endswith("-"):
            out += line
        else:
            out = f"{out} {line}".strip()
    # a DOI link wrapped across lines: "https://doi." "org/10.1093/..." and "10.1093/" "rof/rfn005"
    return re.sub(r"(10\.\d{4,9}/)\s+", r"\1", re.sub(r"(doi\.)\s+(org/)", r"\1\2", out))


def split_entries(section: str) -> list[tuple[int | None, str]]:
    """(number, text) per entry. Numbered lists split on their markers. Author-led lists
    (APA, Harvard, Elsevier, Springer) split where a line begins like an author name and the
    entry before it is complete, which a year inside it shows."""
    lines = section.split("\n")
    numbered = sum(1 for l in lines if _NUMBERED.match(l))
    entries: list[tuple[int | None, list[str]]] = []
    if numbered >= 3:
        expected = None
        for line in lines:
            m = _NUMBERED.match(line)
            n = int(next(g for g in m.groups() if g)) if m else None
            # a marker only starts an entry if it continues the sequence (a page range or a year can look like one)
            if m and (expected is None or n == expected):
                entries.append((n, [line[m.end():]]))
                expected = n + 1
            elif entries and line.strip():
                entries[-1][1].append(line)
    else:
        for line in lines:
            if not line.strip():
                if entries:
                    entries[-1][1].append("")  # a blank line also closes an entry
                continue
            complete = bool(entries) and (not entries[-1][1][-1] or _YEAR_ANY.search(" ".join(entries[-1][1])))
            if _AUTHOR_LED.match(line) and (not entries or complete):
                entries.append((None, [line]))
            elif entries:
                entries[-1][1].append(line)
    return [(n, _join([l for l in ls if l])) for n, ls in entries if _join(ls)]


def parse_entry(raw: str, number: int | None = None) -> Reference:
    ref = Reference(raw=raw, number=number)
    m = _DOI.search(raw)
    if m:
        ref.doi = m.group().lower().rstrip(".,;")
    # The publication year is the first one printed: authors come first, so a later year is a
    # volume or access date ("Bioinformatics 26, 10 (2010), 1340-1347" after "Lengauer. 2010.").
    candidates = [m for m in (_YEAR_PAREN.search(raw), _YEAR_ANY.search(raw)) if m]
    y = min(candidates, key=lambda m: m.start()) if candidates else None
    after = None
    if y:
        ref.year, after = int(y.group(1)), raw[y.end():]
    q = _QUOTED.search(raw)
    # A quoted title sits next to the year ("Author, 1991, "Title,"" or "Author. "Title." Journal (1991)");
    # a quote far from it belongs to some other entry that got glued on.
    if q and (y is None or q.start() <= y.end() + 4):
        ref.title = q.group(1).strip()
    elif after is not None:
        # the title runs from just after the year to the first sentence end that isn't an initial
        rest = after.lstrip(" .,:;)")
        end = len(rest)
        for s in re.finditer(r"[.?!](?=\s)", rest):
            if s.group() == ".":
                if not re.search(r"(?:^|\s)[A-Z]$", rest[: s.start()]):
                    end = s.start()
                    break
            elif _VENUE.search(re.split(r"[.,]", rest[s.end():].lstrip(), maxsplit=1)[0]):
                end = s.end()  # "...the evidence? Journal of X": the question mark ends the title
                break
        ref.title = rest[:end].strip(" .")
    if not re.search(r"[A-Za-z]{4}", ref.title):  # none, or just pages: the year is at the end ("Authors. Title. Journal, 2008.")
        ref.title = _title_after_authors(raw)
    lead = raw[: y.start()] if y else raw[:80]
    ref.first_author = _first_surname(lead)
    return ref


def _title_after_authors(raw: str) -> str:
    """For entries whose year comes last: the sentence after the author list, which ends at the
    first period that doesn't follow an initial ('M. Mogstad. The skill complementarity ... Journal')."""
    ends = [m for m in re.finditer(r"\.\s+(?=\S)", raw) if not re.search(r"(?:^|[\s,.])[A-Z]$", raw[: m.start()])]
    for i, m in enumerate(ends):
        rest = raw[m.end():]
        if re.match(r"(?:19|20)\d{2}[a-z]?\b", rest):  # a year between authors and title
            continue
        nxt = ends[i + 1].start() - m.end() if i + 1 < len(ends) else len(rest)
        return rest[:nxt].strip(" .")
    return ""


def _first_surname(lead: str) -> str:
    lead = lead.strip()
    m = re.match(rf"({_LETTER}[\w'’`\-]*(?:\s(?:de|van|von|der|di|le|la|del|da|al|el|bin|ben)\s{_LETTER}[\w'’`\-]+)?),\s", lead)
    if m:  # "Allen, F." "Abel, Andrew B."
        return m.group(1)
    m = re.match(rf"({_LETTER}[\w'’`\-]*)\s+[A-Z]{{1,3}}(?:[\s,(]|$)", lead)
    if m:  # "Abraham A, ..."
        return m.group(1)
    m = re.match(rf"(?:{_LETTER}[\w'’`\-]*\s)+?({_LETTER}[\w'’`\-]*)[.,]", lead)
    return m.group(1) if m else ""  # "Chainarong Amornbunchornvej." -> surname last


def _stands_alone(title: str, raw: str) -> bool:
    """The title appears in the entry as a title of its own: not continued after it by a subtitle
    (a colon or dash) and not itself the tail of a longer title (preceded by a colon)."""
    words = norm(title).split()
    pattern = r"[\W_]+".join(re.escape(w) for w in words)
    text = unicodedata.normalize("NFKC", raw)
    for m in re.finditer(pattern, text, re.I):
        before, after = text[: m.start()].rstrip(), text[m.end():].lstrip()
        # a title starts the entry, or follows a sentence end, a quote, or the year ("1995, Why ..." "(2024): Existence ...")
        starts = before == "" or before[-1] in ".)\"“‘'" or re.search(r"(?:19|20)\d{2}[a-z]?\)?[,:.]?$", before)
        if starts and (after == "" or after[0] in ".,?!”\"'’)"):
            return True
    return False


def _author_surname(author: str) -> str:
    """'Okafor, Dana' -> Okafor; 'Dana Okafor' -> Okafor."""
    return author.split(",")[0].strip() if "," in author else (author.split() or [""])[-1]


def _looks_like_reference(ref: Reference) -> bool:
    """Not a table or figure that follows the list (a model called 109 of 160 entries in one paper
    non-references): a real entry has a year and isn't mostly numbers and symbols."""
    tokens = ref.raw.split()
    numeric = sum(1 for t in tokens if re.fullmatch(r"[-–.\d,%()/:]+", t))
    return ref.year is not None and len(ref.raw) >= 25 and numeric / max(len(tokens), 1) <= 0.35


def parse_references(text: str) -> list[Reference]:
    refs = (parse_entry(raw, n) for n, raw in split_entries(find_section(text)))
    return [r for r in refs if _looks_like_reference(r)]


def _similar(a: str, b: str, cutoff: float = 0.9) -> bool:
    """SequenceMatcher ratio >= cutoff, skipping the slow exact ratio when a cheap upper bound already rules it out."""
    wa, wb = set(a.split()), set(b.split())
    if len(wa & wb) < 0.6 * max(len(wa), len(wb), 1):
        return False  # a ratio of 0.9 needs nearly every word shared
    m = SequenceMatcher(None, a, b)
    return m.real_quick_ratio() >= cutoff and m.quick_ratio() >= cutoff and m.ratio() >= cutoff


@dataclass
class Match:
    doc_id: int
    how: str  # "doi", "title+author", "title+year", "title"
    score: float


def match_reference(ref: Reference, docs: list[dict], citing_year: int | None = None, citing_id: int | None = None) -> Match | None:
    """The library document a reference points at, or None. DOI first, then title: the
    reference's own title (or the document's title inside the entry) with the author or year
    to confirm it. A paper can't cite one published after it, which rejects look-alikes."""
    raw_n = norm(ref.raw)
    best: Match | None = None
    for d in docs:
        if d["id"] == citing_id:
            continue
        if citing_year and d.get("year") and d["year"] > citing_year + 1:
            continue  # published after the citing paper (a year of slack for working papers)
        if ref.doi and d.get("doi") and ref.doi == d["doi"].lower().rstrip(".,;"):
            return Match(d["id"], "doi", 1.0)
        title_n = norm(d["title"])
        if len(title_n.split()) < 4:
            continue  # too short to match on: "Reading notes", "Introduction"
        # The entry's own title must be (nearly) the document's title, or the document's title must
        # stand alone in the entry. Merely containing it is not enough: "Trusting the stock market:
        # Further evidence from IPOs" and "Fearless woman: Financial literacy and ..." are other papers.
        similar = bool(ref.title) and _similar(norm(ref.title), title_n)
        if not (similar or (title_n in raw_n and _stands_alone(d["title"], ref.raw))):
            continue
        inside = similar or title_n in raw_n
        surname = norm(_author_surname(d["authors"][0])) if d.get("authors") else ""
        author_ok = bool(surname) and surname in norm(ref.raw[:160])
        year_ok = bool(ref.year and d.get("year") and abs(ref.year - d["year"]) <= 1)
        how = "title+author" if author_ok else "title+year" if year_ok else "title"
        score = {"title+author": 0.95, "title+year": 0.9, "title": 0.75}[how] - (0.0 if inside else 0.05)
        if best is None or score > best.score:
            best = Match(d["id"], how, score)
    return best
