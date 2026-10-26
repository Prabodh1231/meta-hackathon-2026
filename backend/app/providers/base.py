"""The provider interface every model backend implements.

A real provider only needs `chat` and `transcribe_image`; the task methods below build
prompts on top of `chat`. The mock overrides the task methods with offline heuristics.
"""

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass

from . import prompts


@dataclass
class Passage:
    pid: str  # "P1", "P2", ... as shown to the model
    chunk_id: int
    label: str  # e.g. "Smith 2021, p. 4"
    text: str


class LLMProvider(ABC):
    name = "base"

    @abstractmethod
    def chat(
        self,
        messages: list[dict],
        *,
        schema: dict | None = None,
        max_tokens: int = 1024,
        temperature: float = 0.2,
    ) -> str:
        """Return the assistant's text. With `schema`, the text must be JSON matching it."""

    @abstractmethod
    def transcribe_image(self, data: bytes, mime: str) -> str:
        """OCR a scan, photo or slide image."""

    def _json(self, system: str, user: str, schema: dict, max_tokens: int = 1024) -> dict:
        raw = self.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            schema=schema,
            max_tokens=max_tokens,
        )
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
        return json.loads(raw)

    def extract_metadata(self, text: str) -> dict:
        return self._json(prompts.METADATA_SYSTEM, text[:6000], prompts.METADATA_SCHEMA)

    def summarize(self, title: str, text: str) -> str:
        return self.chat(
            [
                {"role": "system", "content": prompts.SUMMARY_SYSTEM},
                {"role": "user", "content": f"Title: {title}\n\n{text[:12000]}"},
            ],
            max_tokens=300,
        ).strip()

    def tag_document(self, title: str, text: str) -> list[str]:
        out = self._json(prompts.TAGS_SYSTEM, f"Title: {title}\n\n{text[:8000]}", prompts.TAGS_SCHEMA)
        return [t.strip().lower() for t in out.get("tags", []) if t.strip()][:6]

    def name_topic(self, samples: list[str]) -> dict:
        user = "\n\n---\n\n".join(s[:1500] for s in samples[:10])
        return self._json(prompts.TOPIC_SYSTEM, user, prompts.TOPIC_SCHEMA, max_tokens=200)

    def draft(self, instruction: str, context: str, passages: list[Passage]) -> list[dict]:
        user = (
            f"Task: {instruction}\n\n"
            f"Text written so far (match its voice, do not repeat it):\n{context[-3000:] or '(empty)'}\n\n"
            f"Passages:\n{prompts.format_passages(passages)}"
        )
        out = self._json(prompts.DRAFT_SYSTEM, user, prompts.DRAFT_SCHEMA, max_tokens=2048)
        return out.get("sentences", [])

    def judge_support(self, claim: str, passage: str) -> dict:
        user = f"Claim: {claim}\n\nSource passage:\n{passage}"
        out = self._json(prompts.JUDGE_SYSTEM, user, prompts.JUDGE_SCHEMA, max_tokens=200)
        if out.get("verdict") not in ("supported", "partial", "unsupported"):
            out["verdict"] = "unsupported"
        return out
