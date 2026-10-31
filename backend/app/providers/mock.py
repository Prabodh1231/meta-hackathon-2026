"""Offline stand-in for Muse. Deterministic heuristics, so the whole pipeline runs
(and can be demoed and tested) without API access."""

import re
from collections import Counter

from ..text_utils import keywords, sentences, tokenize
from .base import LLMProvider, Passage

_DOI = re.compile(r"\b10\.\d{4,9}/[^\s\"<>]+", re.I)
_YEAR = re.compile(r"\b(19[5-9]\d|20[0-4]\d)\b")
_NAME = re.compile(r"^[A-Z][a-zA-Z.\-']+(?: [A-Z][a-zA-Z.\-']+)+$")
# Words must be whitespace-separated: with an optional separator, an all-caps line
# ("NATIONAL BUREAU OF ECONOMIC RESEARCH") splits into words exponentially many ways.
_VENUE = re.compile(r"^((?:[A-Z][\w&\-]*\s+)*\b(?:Journal|Proceedings|Conference|Review|Transactions|"
                    r"Letters|Series|Annals|Bulletin)\b[^,.\d]*)")


class MockProvider(LLMProvider):
    name = "mock"

    def chat(self, messages, *, schema=None, max_tokens=1024, temperature=0.2) -> str:
        if schema is not None:
            raise NotImplementedError("MockProvider answers task methods directly, not raw JSON chat")
        last = messages[-1]["content"] if messages else ""
        return f"[mock reply] {last[:200]}"

    def transcribe_image(self, data: bytes, mime: str) -> str:
        return "[Mock provider: OCR is unavailable offline. Connect Muse to transcribe this image.]"

    def extract_metadata(self, text: str) -> dict:
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        title = next((ln for ln in lines[:5] if 8 <= len(ln) <= 200), "")
        authors: list[str] = []
        if title in lines:
            for ln in lines[lines.index(title) + 1 : lines.index(title) + 3]:
                parts = [p.strip() for p in re.split(r",| and |;", ln) if p.strip()]
                if parts and all(_NAME.match(p) for p in parts):
                    authors = parts
                    break
        doi = _DOI.search(text)
        year = _YEAR.search(text)
        venue = next((m.group(1).strip() for ln in lines[1:8] if (m := _VENUE.match(ln))), "")
        return {
            "title": title,
            "authors": authors,
            "year": int(year.group()) if year else None,
            "venue": venue,
            "doi": doi.group().rstrip(".,;)") if doi else "",
        }

    def summarize(self, title: str, text: str) -> str:
        sents = [s for s in sentences(text[:4000]) if len(s) > 40]
        return " ".join(sents[:2])[:400]

    def tag_document(self, title: str, text: str) -> list[str]:
        return keywords([title, *sentences(text[:8000])], n=5)

    def name_topic(self, samples: list[str]) -> dict:
        words = keywords(samples, n=3) or ["misc"]
        return {
            "label": " · ".join(w.capitalize() for w in words[:2]),
            "description": f"Documents that discuss {', '.join(words)}.",
        }

    def score_folders(self, title: str, summary: str, text: str, folders: list[str]) -> dict[str, int]:
        # Offline stand-in: how fully the words of a folder's name show up in the document,
        # matching word stems so "finances" counts for "finance".
        counts = Counter(re.findall(r"[a-z]+", f"{title} {summary} {text[:8000]}".lower()))
        scores = {}
        for name in folders:
            words = re.findall(r"[a-z]{2,}", name.lower())
            coverage = []
            for w in words:
                stem = w if len(w) <= 3 else w[: max(4, len(w) - 2)]
                hits = sum(n for tok, n in counts.items() if tok == w or (len(w) > 3 and tok.startswith(stem)))
                coverage.append(0 if hits == 0 else 0.6 if hits == 1 else 0.8 if hits == 2 else 1.0)
            scores[name] = round(100 * sum(coverage) / len(coverage)) if coverage else 0
        return scores

    def draft(self, instruction: str, context: str, passages: list[Passage]) -> list[dict]:
        # No paraphrasing offline: pick each passage's most on-topic sentence and quote it.
        query = set(tokenize(instruction))
        out = []
        for p in passages[:4]:
            candidates = [s for s in sentences(p.text) if len(s) >= 40]
            if not candidates:
                continue
            best = max(candidates, key=lambda s: len(query & set(tokenize(s))))
            text = " ".join(best.lstrip("-*#> ").split())  # drop markdown markers and line wraps
            out.append({"text": text, "citations": [{"passage": p.pid, "quote": best}]})
        return out

    def extract_matrix_row(self, title: str, columns: list[dict], passages: list[Passage]) -> list[dict]:
        # Offline: for each column, the sentence sharing most words with the column's search terms,
        # quoted as it stands. Nothing shared means not reported.
        out = []
        for col in columns:
            want = set(tokenize(f"{col.get('query') or ''} {col['label']} {col.get('instruction') or ''}"))
            best, best_pid, score = "", "", 0
            for p in passages:
                for s in sentences(p.text):
                    n = len(want & set(tokenize(s)))
                    if len(s) >= 30 and n > score:
                        best, best_pid, score = s.strip(), p.pid, n
            if score == 0:
                out.append({"column": col["key"], "answer": "", "passage": "", "quote": ""})
            else:
                answer = " ".join(best.split()[:30])
                out.append({"column": col["key"], "answer": answer, "passage": best_pid, "quote": best})
        return out

    def find_gaps(self, topic: str, table: str) -> list[dict]:
        # Offline: a column most studies leave empty is a gap.
        lines = [line for line in table.splitlines() if line.strip()]
        missing = Counter(m for line in lines for m in re.findall(r"(\w[\w ]*): not reported", line))
        return [{"title": f"Little on {name.lower()}", "detail": f"{n} of {len(lines)} studies don't report it."}
                for name, n in missing.most_common(6) if n]

    # Words a sentence about the studies as a set uses (a gap, a comparison) that no table cell does.
    _ACROSS = {"little", "studies", "study", "don", "doesn", "didn", "report", "reports", "reported", "none", "few",
               "both", "all", "most", "while", "whereas", "across", "compared"}

    def judge_against_matrix(self, claim: str, topic: str, table: str) -> dict:
        words = [w for w in tokenize(claim) if w not in self._ACROSS]
        out = self.judge_support(" ".join(words), table) if words else self.judge_support(claim, table)
        out["reason"] = out["reason"].replace("in the source", "in the matrix")
        return out

    def judge_support(self, claim: str, passage: str) -> dict:
        claim_words = set(tokenize(claim))
        if not claim_words:
            return {"verdict": "unsupported", "reason": "The claim has no checkable content."}
        overlap = len(claim_words & set(tokenize(passage))) / len(claim_words)
        verdict = "supported" if overlap >= 0.6 else "partial" if overlap >= 0.3 else "unsupported"
        return {
            "verdict": verdict,
            "reason": f"Mock check: {overlap:.0%} of the claim's key terms appear in the source.",
        }
