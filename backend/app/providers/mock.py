"""Offline stand-in for Muse. Deterministic heuristics, so the whole pipeline runs
(and can be demoed and tested) without API access."""

import re

from ..text_utils import keywords, sentences, tokenize
from .base import LLMProvider, Passage

_DOI = re.compile(r"\b10\.\d{4,9}/[^\s\"<>]+", re.I)
_YEAR = re.compile(r"\b(19[5-9]\d|20[0-4]\d)\b")
_NAME = re.compile(r"^[A-Z][a-zA-Z.\-']+(?: [A-Z][a-zA-Z.\-']+)+$")


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
        return {
            "title": title,
            "authors": authors,
            "year": int(year.group()) if year else None,
            "venue": "",
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

    def draft(self, instruction: str, context: str, passages: list[Passage]) -> list[dict]:
        # No paraphrasing offline: pick each passage's most on-topic sentence and quote it.
        query = set(tokenize(instruction + " " + context[-500:]))
        out = []
        for p in passages[:4]:
            candidates = [s for s in sentences(p.text) if len(s) >= 40]
            if not candidates:
                continue
            best = max(candidates, key=lambda s: len(query & set(tokenize(s))))
            text = " ".join(best.lstrip("-*#> ").split())  # drop markdown markers and line wraps
            out.append({"text": text, "citations": [{"passage": p.pid, "quote": best}]})
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
