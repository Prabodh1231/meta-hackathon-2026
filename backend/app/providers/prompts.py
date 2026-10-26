"""Prompts and JSON schemas used by any chat-based provider (Muse, or a future swap)."""

METADATA_SYSTEM = (
    "You extract bibliographic metadata from the opening text of a document. "
    "Only report what the text states; use empty values when unsure. Never invent a DOI."
)
METADATA_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "authors": {"type": "array", "items": {"type": "string"}},
        "year": {"type": ["integer", "null"]},
        "venue": {"type": "string"},
        "doi": {"type": "string"},
    },
    "required": ["title", "authors", "year", "venue", "doi"],
}

SUMMARY_SYSTEM = (
    "Summarize the document for a researcher in at most three sentences: "
    "its question, its method, and its key finding."
)

TAGS_SYSTEM = (
    "Give 3 to 6 short lowercase topical tags (1-3 words each) for this document. "
    "Prefer specific research concepts over generic words."
)
TAGS_SCHEMA = {
    "type": "object",
    "properties": {"tags": {"type": "array", "items": {"type": "string"}}},
    "required": ["tags"],
}

TOPIC_SYSTEM = (
    "These documents were clustered together. Name the shared research theme in 2-5 words "
    "and describe it in one sentence."
)
TOPIC_SCHEMA = {
    "type": "object",
    "properties": {"label": {"type": "string"}, "description": {"type": "string"}},
    "required": ["label", "description"],
}

DRAFT_SYSTEM = (
    "You are a research writing assistant. Write in the researcher's voice using ONLY the "
    "numbered passages provided. Every sentence must cite at least one passage id (e.g. P2) "
    "and include a quote copied verbatim from that passage, at most 40 words, that supports "
    "the sentence. If the passages cannot support a point, leave it out."
)
DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "sentences": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "citations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "passage": {"type": "string"},
                                "quote": {"type": "string"},
                            },
                            "required": ["passage", "quote"],
                        },
                    },
                },
                "required": ["text", "citations"],
            },
        }
    },
    "required": ["sentences"],
}

JUDGE_SYSTEM = (
    "Decide whether the source passage supports the claim. 'supported' means the passage "
    "states or directly implies the claim; 'partial' means it supports only part of it or "
    "the claim overstates it; 'unsupported' means it does not back the claim. "
    "Give a one-sentence reason."
)
JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["supported", "partial", "unsupported"]},
        "reason": {"type": "string"},
    },
    "required": ["verdict", "reason"],
}

OCR_PROMPT = (
    "Transcribe all text in this image exactly, preserving reading order and line breaks. "
    "Describe diagrams in one bracketed line. Output only the transcription."
)


def format_passages(passages) -> str:
    return "\n\n".join(f"[{p.pid}] ({p.label})\n{p.text}" for p in passages)
