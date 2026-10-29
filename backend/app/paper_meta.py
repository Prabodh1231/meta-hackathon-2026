"""Keywords and JEL codes that authors print on a paper's first page, read with patterns:
no model call, and exactly what the authors wrote."""

import re
import unicodedata

# Top-level JEL (Journal of Economic Literature) classification areas.
JEL_AREAS = {
    "A": "General Economics and Teaching",
    "B": "History of Economic Thought, Methodology, and Heterodox Approaches",
    "C": "Mathematical and Quantitative Methods",
    "D": "Microeconomics",
    "E": "Macroeconomics and Monetary Economics",
    "F": "International Economics",
    "G": "Financial Economics",
    "H": "Public Economics",
    "I": "Health, Education, and Welfare",
    "J": "Labor and Demographic Economics",
    "K": "Law and Economics",
    "L": "Industrial Organization",
    "M": "Business Administration and Business Economics; Marketing; Accounting",
    "N": "Economic History",
    "O": "Economic Development, Innovation, Technological Change, and Growth",
    "P": "Political Economy and Comparative Economic Systems",
    "Q": "Agricultural and Natural Resource Economics; Environmental and Ecological Economics",
    "R": "Urban, Rural, Regional, Real Estate, and Transportation Economics",
    "Y": "Miscellaneous Categories",
    "Z": "Other Special Topics",
}

# "Keywords:", "Key words -", "Index Terms", "Author Keywords", "Additional Key Words and Phrases:".
_KEYWORDS = re.compile(
    r"^[ \t]*(?:(?:additional|author)\s+)?(?:key[\s-]*words?|index\s+terms)(?:\s+and\s+phrases)?"
    r"[ \t]*(?:[:–—-]|\bin\b)?[ \t]*",
    re.I | re.M,
)
# A line that starts something else, so a keyword list has ended.
_NEXT_SECTION = re.compile(
    r"^\s*(?:JEL\b|abstract\b|introduction\b|summary\b|\d+(?:\.\d+)*[.)]?\s+[A-Z]|[IVX]+[.)]\s|received\b|"
    r"e-?mail\b|corresponding\b|©|copyright\b|doi\b|https?:|article\s+info|how\s+to\s+cite|acm\b|"
    r"ccs\s+concepts)",
    re.I,
)
_SPACED_HEADING = re.compile(r"^\s*(?:\w\s+){3,}\w\s*$")  # Elsevier's "A B S T R A C T"
_JEL = re.compile(
    r"\bJEL\b\s*(?i:classifications?|codes?|class\.?|subject\s+classification|nos?\.?)?\s*[:.–—-]?\s*"
    r"((?:[A-Z]\d{1,2}(?:\s*(?:[,;/&]|and)\s*|\s+)?){1,20})"
)
_CODE = re.compile(r"[A-Z]\d{1,2}")


def _clean(text: str) -> str:
    return unicodedata.normalize("NFKC", text)  # "classiﬁcation" -> "classification", "eﬀects" -> "effects"


def extract_keywords(text: str) -> list[str]:
    """The author-supplied keyword list (lowercased, de-duplicated), [] if the page has none."""
    text = _clean(text)
    m = _KEYWORDS.search(text)
    if not m:
        return []
    lines = text[m.end():].split("\n")
    first, rest = lines[0].strip(), []
    for line in lines[1:]:
        if not line.strip() or _NEXT_SECTION.match(line) or _SPACED_HEADING.match(line) or len(line) > 120:
            break
        rest.append(line.strip())
    if not first and rest and not any(c in " ".join(rest) for c in ";,·•"):
        raw_items = rest  # one keyword per line (Elsevier layout)
        sep = "\n"
        raw = "\n".join(rest)
    else:
        raw = first
        for part in rest:  # PDF text is hard-wrapped; a word split across lines ("bor-" "der") is rejoined
            if raw.endswith("-") and part[:1].islower():
                raw = raw[:-1] + part
            elif raw.endswith("-"):
                raw += part  # "Sub-" "Saharan": a real hyphen, keep it
            else:
                raw = f"{raw} {part}".strip()
        raw = re.split(r"\bJEL\b", raw)[0].strip()  # "Keywords: a; b JEL: G21" on one line
        sep = ";" if ";" in raw else "·" if "·" in raw else "•" if "•" in raw else ","
        raw_items = raw.split(sep)
    out: list[str] = []
    for token in raw_items:
        token = " ".join(token.strip(" .;,·•|-").lower().split())
        if 2 <= len(token) <= 60 and len(token.split()) <= 8 and token not in out:
            out.append(token)
    return out[:12]


def extract_jel(text: str) -> list[str]:
    """JEL codes printed after a 'JEL' label, in order, e.g. ['G21', 'O16']."""
    out: list[str] = []
    for m in _JEL.finditer(_clean(text)):
        for code in _CODE.findall(m.group(1)):
            if code[0] in JEL_AREAS and code not in out:
                out.append(code)
    return out[:20]


def extract(text: str) -> tuple[list[str], list[str]]:
    """(keywords, JEL codes) from the opening text of a paper."""
    return extract_keywords(text), extract_jel(text)


def jel_area(code: str) -> str:
    return JEL_AREAS.get(code[:1], "")
