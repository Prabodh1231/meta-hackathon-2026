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

    def score_folders(self, title: str, summary: str, text: str, folders: list[str]) -> dict[str, int]:
        """How well a document fits each named folder, 0-100 (folder name -> score)."""
        # Filing can start before the summary is written; then it goes by the text alone.
        about = f"Title: {title}\n" + (f"Summary: {summary}\n" if summary else "")
        user = f"Folders: {json.dumps(folders)}\n\n{about}\n{text[:6000]}"
        out = self._json(prompts.FOLDER_FIT_SYSTEM, user, prompts.FOLDER_FIT_SCHEMA, max_tokens=60 + 40 * len(folders))
        by_name = {f.lower(): f for f in folders}
        scores: dict[str, int] = {}
        for item in out.get("scores", []):
            name = by_name.get(str(item.get("folder", "")).strip().lower())
            if name is not None and isinstance(item.get("score"), (int, float)):
                scores[name] = max(0, min(100, int(item["score"])))
        return scores

    def draft(self, instruction: str, context: str, passages: list[Passage]) -> list[dict]:
        user = (
            f"Task: {instruction}\n\n"
            f"Text written so far (match its voice, do not repeat it):\n{context[-3000:] or '(empty)'}\n\n"
            f"Passages:\n{prompts.format_passages(passages)}"
        )
        out = self._json(prompts.DRAFT_SYSTEM, user, prompts.DRAFT_SCHEMA, max_tokens=2048)
        return out.get("sentences", [])

    def ask(self, question: str, history: list[dict], context: str, selection: str) -> str:
        """A chatbot reply in Markdown. `history` is the conversation so far, [{question, reply}], oldest first."""
        messages = [{"role": "system", "content": prompts.CHAT_SYSTEM}]
        for t in history[-10:]:
            messages += [{"role": "user", "content": t["question"]}, {"role": "assistant", "content": t["reply"]}]
        about = (f"(The paragraph I'm writing: {context[-3000:]})\n\n" if context.strip() else "") + (
            f"(Selected text:\n{selection[:4000]})\n\n" if selection else "")
        messages.append({"role": "user", "content": about + question})
        return self.chat(messages, max_tokens=3000, temperature=0.5).strip()

    def extract_matrix_row(self, title: str, columns: list[dict], passages: list[Passage]) -> list[dict]:
        """One paper's row: for each column {column, answer, passage, quote}, empty when not reported."""
        cols = "\n".join(f"- {c['key']}: {c['label']}. {c.get('instruction') or ''}".rstrip() for c in columns)
        user = f"Paper: {title}\n\nColumns (answer each, by key):\n{cols}\n\nPassages:\n{prompts.format_passages(passages)}"
        out = self._json(prompts.MATRIX_SYSTEM, user, prompts.MATRIX_SCHEMA, max_tokens=300 + 220 * len(columns))
        return out.get("cells", [])

    def find_gaps(self, topic: str, table: str) -> list[dict]:
        """Gaps across a matrix's studies: [{title, detail}]."""
        out = self._json(prompts.GAPS_SYSTEM, f"Topic: {topic}\n\n{table[:60000]}", prompts.GAPS_SCHEMA, max_tokens=1200)
        return out.get("gaps", [])

    def judge_against_matrix(self, claim: str, topic: str, table: str) -> dict:
        """Does a review matrix (as text, one line per study) support a sentence written from it?"""
        user = f"Sentence: {claim}\n\nMatrix: {topic}\n{table[:60000]}"
        out = self._json(prompts.MATRIX_JUDGE_SYSTEM, user, prompts.JUDGE_SCHEMA, max_tokens=300)
        if out.get("verdict") not in ("supported", "partial", "unsupported"):
            out["verdict"] = "unsupported"
        return out

    def propose_variables(self, tables: str, gaps: str, focus: str) -> list[dict]:
        """Variables a study addressing these gaps would use: [{name, role, why, measures: [{study, how}]}]."""
        user = (f"Gaps to address:\n{gaps}\n\n" + (f"The writer's focus: {focus}\n\n" if focus else "")
                + f"Review matrices:\n{tables[:60000]}")
        return self._json(prompts.VARIABLES_SYSTEM, user, prompts.VARIABLES_SCHEMA, max_tokens=2000).get("variables", [])

    @staticmethod
    def _brief(gaps: str, focus: str, exclusions: str, resources: str, avoid: str) -> str:
        return (f"Gaps to address:\n{gaps or '(none chosen)'}\n\n"
                + (f"The writer's focus: {focus}\n\n" if focus else "")
                + f"The writer rules out (strict):\n{exclusions or '(nothing)'}\n\n"
                + f"What the writer has to work with:\n{resources or '(not said)'}\n\n"
                + (f"A previous draft broke these exclusions; do not repeat them:\n{avoid}\n\n" if avoid else ""))

    def plan_proposal(self, tables: str, gaps: str, focus: str, variables: str, exclusions: str, resources: str,
                      avoid: str = "") -> dict:
        """One study's title, core question, questions, hypotheses, variables, and the gaps it leaves out."""
        user = (self._brief(gaps, focus, exclusions, resources, avoid)
                + f"Variables and the writer's roles:\n{variables or '(choose them)'}\n\n"
                + f"Review matrices:\n{tables[:60000]}")
        return self._json(prompts.PLAN_SYSTEM, user, prompts.PLAN_SCHEMA, max_tokens=1800)

    def review_questions(self, plan: str) -> dict:
        """Each research question kept, revised or removed against the study's core question."""
        return self._json(prompts.QUESTIONS_SYSTEM, plan, prompts.QUESTIONS_SCHEMA, max_tokens=1500)

    def write_proposal(self, tables: str, plan: str, gaps: str, exclusions: str, resources: str,
                       avoid: str = "") -> dict:
        """The rest of a planned study's proposal (PROPOSAL_SCHEMA): background, gap, measures, design…"""
        user = (f"The planned study (fixed):\n{plan}\n\n" + self._brief(gaps, "", exclusions, resources, avoid)
                + f"Review matrices:\n{tables[:60000]}")
        return self._json(prompts.PROPOSAL_SYSTEM, user, prompts.PROPOSAL_SCHEMA, max_tokens=5000)

    def repair_claims(self, items: list[dict]) -> list[str]:
        """Rewrites of claims the matrix rows they cite don't back: items are {claim, reason, rows}."""
        user = "\n\n".join(f"Item {i + 1}\nSentence: {it['claim']}\nWhy it isn't backed: {it['reason']}\n"
                            f"Rows it cites:\n{it['rows']}" for i, it in enumerate(items))
        out = self._json(prompts.REPAIR_SYSTEM, user[:60000], prompts.REPAIR_SCHEMA, max_tokens=600 + 250 * len(items))
        return [str(r) for r in out.get("rewrites") or []]

    def check_exclusions(self, exclusions: str, proposal: str) -> list[dict]:
        """Where a proposal breaks what the writer ruled out: [{rule, section, why}]."""
        user = f"The writer rules out:\n{exclusions}\n\nThe proposal:\n{proposal[:30000]}"
        return self._json(prompts.EXCLUSIONS_SYSTEM, user, prompts.EXCLUSIONS_SCHEMA, max_tokens=1200).get("violations", [])

    def judge_support(self, claim: str, passage: str) -> dict:
        user = f"Claim: {claim}\n\nSource passage:\n{passage}"
        out = self._check_json(prompts.JUDGE_SYSTEM, user, prompts.JUDGE_SCHEMA, max_tokens=200)
        if out.get("verdict") not in ("supported", "partial", "unsupported"):
            out["verdict"] = "unsupported"
        return out

    def _check_json(self, system: str, user: str, schema: dict, max_tokens: int) -> dict:
        """One JSON call made for a support check. Muse overrides this to give the check its
        own reasoning effort; other providers use the ordinary JSON helper."""
        return self._json(system, user, schema, max_tokens=max_tokens)

    def _search_json(self, system: str, user: str, schema: dict, max_tokens: int) -> dict:
        """One JSON call made for search. Muse overrides this to keep search calls quick
        and at low reasoning effort; other providers use the ordinary JSON helper."""
        return self._json(system, user, schema, max_tokens=max_tokens)

    def expand_query(self, query: str) -> list[str]:
        """2-4 short keyword queries in the words a paper would likely use, for keyword
        search. Empty on any failure, so callers search with the query alone."""
        query = " ".join(str(query).split())
        if not query:
            return []
        try:
            out = self._search_json(prompts.EXPAND_QUERY_SYSTEM, f"Query: {query}",
                                    prompts.EXPAND_QUERY_SCHEMA, max_tokens=200)
        except Exception:
            return []
        queries: list[str] = []
        for item in out.get("queries", []) if isinstance(out, dict) else []:
            text = " ".join(str(item).split())
            if text and text.lower() != query.lower() and text.lower() not in {q.lower() for q in queries}:
                queries.append(text)
        return queries[:4]

    def rank_passages(self, query: str, passages: list[tuple[int, str]]) -> list[float] | None:
        """A relevance score per passage, in input order, from one call that sees every
        candidate (each trimmed to about 700 characters). None on any failure, so callers
        keep their keyword order."""
        if not passages:
            return []
        listing = "\n\n".join(f"[{pid}] {str(text)[:700]}" for pid, text in passages)
        try:
            out = self._search_json(prompts.RANK_PASSAGES_SYSTEM, f"Query: {query}\n\nPassages:\n{listing}",
                                    prompts.RANK_PASSAGES_SCHEMA, max_tokens=100 + 40 * len(passages))
        except Exception:
            return None
        ids = {pid for pid, _ in passages}
        by_id: dict[int, float] = {}
        for item in out.get("scores", []) if isinstance(out, dict) else []:
            if not isinstance(item, dict):
                continue
            pid, score = item.get("id"), item.get("score")
            if pid in ids and isinstance(score, (int, float)) and not isinstance(score, bool):
                by_id[pid] = max(0.0, min(1.0, float(score)))
        if any(pid not in by_id for pid, _ in passages):
            return None
        return [by_id[pid] for pid, _ in passages]
