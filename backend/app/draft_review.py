"""Reading a draft (the editor's ProseMirror JSON) as text, at three levels: the whole document,
its sections (split at headings) and its paragraphs. Version history compares two drafts at
each level, and duplication detection looks for passages repeated inside the draft.

Everything here is plain text comparison, with no model calls: difflib for the change
between versions, and overlapping word sequences (n-grams) for duplicated passages.
"""

import json
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from .text_utils import sentence_spans

_WORD = re.compile(r"\w+(?:['’\-]\w+)*")
SHINGLE = 3  # words per n-gram when measuring overlap

# Within the draft: sentences sharing this share of the shorter one's word n-grams count as
# repeated, paragraphs a little less (a reworded paragraph keeps fewer long runs of words).
MIN_SENTENCE_WORDS = 6
MIN_PARAGRAPH_WORDS = 20
SENTENCE_REPEAT = 0.6
PARAGRAPH_REPEAT = 0.5


@dataclass
class Block:
    kind: str  # "heading" or "paragraph" (list items and quotes read as paragraphs)
    text: str
    level: int = 0  # heading level
    cites: list[tuple[int, int]] = field(default_factory=list)  # (offset in text, doc id) per citation chip


def parse(content: str | dict | None) -> dict:
    """The editor's document from its stored JSON string; an empty document if it isn't one."""
    if isinstance(content, dict):
        return content
    try:
        doc = json.loads(content or "")
    except ValueError:
        return {"type": "doc", "content": []}
    return doc if isinstance(doc, dict) else {"type": "doc", "content": []}


def blocks(content: str | dict | None) -> list[Block]:
    out: list[Block] = []

    def inline(nodes: list[dict], block: Block) -> None:
        for node in nodes:
            kind = node.get("type")
            if kind == "text":
                block.text += node.get("text") or ""
            elif kind == "hardBreak":
                block.text += " "
            elif kind == "citation":
                block.cites.append((len(block.text), (node.get("attrs") or {}).get("docId") or 0))
            elif node.get("content"):
                inline(node["content"], block)

    def walk(nodes: list[dict]) -> None:
        for node in nodes:
            kind = node.get("type")
            if kind in ("paragraph", "heading", "codeBlock"):
                b = Block("heading" if kind == "heading" else "paragraph", "",
                          int((node.get("attrs") or {}).get("level") or 1) if kind == "heading" else 0)
                inline(node.get("content") or [], b)
                b.text = re.sub(r"[ \t]+", " ", b.text).strip()
                if b.text:
                    out.append(b)
            elif node.get("content"):  # lists, list items, blockquotes
                walk(node["content"])

    walk(parse(content).get("content") or [])
    return out


def plain_text(content: str | dict | None) -> str:
    return "\n\n".join(b.text for b in blocks(content))


def words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def word_count(text: str) -> int:
    return len(_WORD.findall(text))


def shingles(tokens: list[str], n: int = SHINGLE) -> set[tuple[str, ...]]:
    if len(tokens) < n:
        return {tuple(tokens)} if tokens else set()
    return {tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1)}


def overlap(a: set, b: set) -> float:
    """Shared n-grams over the smaller set's: 1.0 when one passage is contained in the other."""
    return len(a & b) / min(len(a), len(b)) if a and b else 0.0


def containment(a: set, b: set) -> float:
    """Share of a's n-grams that also appear in b."""
    return len(a & b) / len(a) if a else 0.0


def pct(x: float) -> int:
    return int(round(100 * x))


# ---------- versions ----------

def _ratio(a: list[str], b: list[str]) -> float:
    if not a and not b:
        return 1.0
    return SequenceMatcher(None, a, b, autojunk=False).ratio()


def change_pct(old_text: str, new_text: str) -> int:
    """How much of the text changed, 0-100 (100 minus word-level similarity)."""
    return 100 - pct(_ratio(words(old_text), words(new_text)))


def word_diff(old: str, new: str) -> list[list[str]]:
    """[op, text] runs, op "=" kept, "-" removed, "+" added; words keep their original spelling."""
    a, b = old.split(), new.split()
    ops: list[list[str]] = []

    def push(op: str, ws: list[str]) -> None:
        if not ws:
            return
        if ops and ops[-1][0] == op:
            ops[-1][1] += " " + " ".join(ws)
        else:
            ops.append([op, " ".join(ws)])

    for tag, i1, i2, j1, j2 in SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            push("=", a[i1:i2])
        else:
            push("-", a[i1:i2])
            push("+", b[j1:j2])
    return ops


def _counts(ops: list[list[str]]) -> tuple[int, int]:
    added = sum(len(t.split()) for op, t in ops if op == "+")
    removed = sum(len(t.split()) for op, t in ops if op == "-")
    return added, removed


def _paragraph_entry(old: str | None, new: str | None) -> dict:
    if old is None:
        return {"status": "added", "change": 100, "old": "", "new": new, "ops": [["+", new]]}
    if new is None:
        return {"status": "removed", "change": 100, "old": old, "new": "", "ops": [["-", old]]}
    if old == new:
        return {"status": "unchanged", "change": 0, "old": old, "new": new, "ops": [["=", new]]}
    return {"status": "modified", "change": change_pct(old, new), "old": old, "new": new, "ops": word_diff(old, new)}


def _align(old: list[str], new: list[str]) -> list[tuple[str | None, str | None]]:
    """Pair up two lists of paragraphs: equal ones by difflib, and inside a changed run each new
    paragraph with the most similar old one that's left (similar enough to be an edit of it)."""
    pairs: list[tuple[str | None, str | None]] = []
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if tag == "equal":
            pairs += [(o, o) for o in old[i1:i2]]
            continue
        left = list(range(i1, i2))
        for j in range(j1, j2):
            best, score = None, 0.35
            for i in left:
                r = _ratio(words(old[i]), words(new[j]))
                if r > score:
                    best, score = i, r
            if best is None:
                pairs.append((None, new[j]))
            else:
                # Old paragraphs passed over on the way to this match were deleted here.
                while left and left[0] != best:
                    pairs.append((old[left.pop(0)], None))
                left.pop(0)
                pairs.append((old[best], new[j]))
        pairs += [(old[i], None) for i in left]
    return pairs


@dataclass
class Section:
    title: str  # "" for text before the first heading
    level: int
    paragraphs: list[str]

    @property
    def text(self) -> str:
        return "\n".join(self.paragraphs)


def sections(bs: list[Block]) -> list[Section]:
    out = [Section("", 0, [])]
    for b in bs:
        if b.kind == "heading":
            out.append(Section(b.text, b.level, []))
        else:
            out[-1].paragraphs.append(b.text)
    return [s for s in out if s.title or s.paragraphs]


def _norm(title: str) -> str:
    return " ".join(words(title))


def compare(old_content: str | dict | None, new_content: str | dict | None) -> dict:
    """Changes from one draft to another at three levels: the document, each section and each paragraph."""
    old_b, new_b = blocks(old_content), blocks(new_content)
    old_t = "\n".join(b.text for b in old_b)
    new_t = "\n".join(b.text for b in new_b)
    doc_ops = word_diff(old_t, new_t)
    added, removed = _counts(doc_ops)

    # Sections match by heading, so moving or editing one section doesn't mark the others changed.
    old_s, new_s = sections(old_b), sections(new_b)
    by_title = {}
    for s in old_s:
        by_title.setdefault(_norm(s.title), s)
    used: set[int] = set()
    sec_out = []
    for s in new_s:
        match = by_title.get(_norm(s.title))
        if match is not None and id(match) in used:
            match = None
        if match is not None:
            used.add(id(match))
        paras = [_paragraph_entry(o, n) for o, n in _align(match.paragraphs if match else [], s.paragraphs)]
        status = "added" if match is None else "unchanged" if match.text == s.text else "modified"
        sec_out.append({
            "title": s.title, "level": s.level, "status": status,
            "change": 100 if match is None else change_pct(match.text, s.text),
            "words": word_count(s.text), "paragraphs": paras,
        })
    for s in old_s:
        if id(s) not in used:
            sec_out.append({
                "title": s.title, "level": s.level, "status": "removed", "change": 100, "words": 0,
                "paragraphs": [_paragraph_entry(p, None) for p in s.paragraphs],
            })

    paras = [p for s in sec_out for p in s["paragraphs"]]
    return {
        "document": {
            "change": change_pct(old_t, new_t),
            "similarity": pct(_ratio(words(old_t), words(new_t))),
            "added_words": added, "removed_words": removed,
            "old_words": word_count(old_t), "new_words": word_count(new_t),
        },
        "sections": sec_out,
        "paragraph_counts": {k: sum(p["status"] == k for p in paras) for k in ("added", "removed", "modified", "unchanged")},
    }


# ---------- duplication inside the draft ----------

@dataclass
class Sentence:
    text: str
    block: int  # index into the draft's blocks
    tokens: list[str]
    cited_docs: set[int]


def draft_sentences(bs: list[Block]) -> list[Sentence]:
    out = []
    for i, b in enumerate(bs):
        if b.kind != "paragraph":
            continue
        spans = sentence_spans(b.text)
        for k, (s, e) in enumerate(spans):
            # A chip belongs to the sentence it follows: it sits after that sentence's end,
            # before the next one starts.
            nxt = spans[k + 1][0] if k + 1 < len(spans) else len(b.text) + 1
            docs = {d for off, d in b.cites if s <= off < nxt or (k == 0 and off < s)}
            out.append(Sentence(b.text[s:e], i, words(b.text[s:e]), docs))
    return out


def internal_duplicates(bs: list[Block]) -> dict:
    """Sentences and paragraphs the draft says twice, nearly word for word."""
    every = draft_sentences(bs)
    idx = [k for k, s in enumerate(every) if len(s.tokens) >= MIN_SENTENCE_WORDS]
    grams = {k: shingles(every[k].tokens) for k in idx}
    sentence_pairs = []
    repeated: set[int] = set()  # indexes into draft_sentences(); later copies only, the first isn't the duplicate
    for n, j in enumerate(idx):
        for i in idx[:n]:
            sim = overlap(grams[i], grams[j])
            if sim >= SENTENCE_REPEAT:
                sentence_pairs.append({"similarity": pct(sim), "first": every[i].text, "second": every[j].text,
                                       "first_block": every[i].block, "second_block": every[j].block})
                repeated.add(j)
                break

    paras = [(i, b) for i, b in enumerate(bs) if b.kind == "paragraph" and word_count(b.text) >= MIN_PARAGRAPH_WORDS]
    pgrams = [shingles(words(b.text)) for _, b in paras]
    paragraph_pairs = []
    for j in range(len(paras)):
        for i in range(j):
            sim = overlap(pgrams[i], pgrams[j])
            if sim >= PARAGRAPH_REPEAT:
                paragraph_pairs.append({"similarity": pct(sim), "first": paras[i][1].text, "second": paras[j][1].text,
                                        "first_block": paras[i][0], "second_block": paras[j][0]})
                break
    return {"sentences": sentence_pairs, "paragraphs": paragraph_pairs, "repeated": sorted(repeated)}


def matched_span(sentence: str, text: str) -> tuple[int, int] | None:
    """Character span in `text` covering the words it shares with `sentence` (first to last shared run)."""
    tw = [(m.group().lower(), m.start(), m.end()) for m in _WORD.finditer(text)]
    sw = words(sentence)
    blocks_ = [m for m in SequenceMatcher(None, sw, [w for w, _, _ in tw], autojunk=False).get_matching_blocks()
               if m.size >= 2]
    if not blocks_:
        return None
    first, last = blocks_[0], blocks_[-1]
    return tw[first.b][1], tw[last.b + last.size - 1][2]
