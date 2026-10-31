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
    "additionalProperties": False,
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
    "additionalProperties": False,
}

TOPIC_SYSTEM = (
    "These documents were clustered together. Name the shared research theme in 2-5 words "
    "and describe it in one sentence."
)
TOPIC_SCHEMA = {
    "type": "object",
    "properties": {"label": {"type": "string"}, "description": {"type": "string"}},
    "required": ["label", "description"],
    "additionalProperties": False,
}

FOLDER_FIT_SYSTEM = (
    "The user keeps virtual folders, each defined by a subject they typed. For each folder, "
    "rate from 0 to 100 how well this document belongs in it, judging by what the document "
    "is about and never by its file name or type. 0 = unrelated, 50 = the subject is a "
    "meaningful part of the document, 100 = the subject is what the document is mainly about. "
    "Return every folder exactly once, with its name copied as given."
)
FOLDER_FIT_SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"folder": {"type": "string"}, "score": {"type": "integer"}},
                "required": ["folder", "score"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["scores"],
    "additionalProperties": False,
}

DRAFT_SYSTEM = (
    "You are a research writing assistant. Write in the researcher's voice using ONLY the "
    "numbered passages provided. Every sentence must cite at least one passage id (e.g. P2) "
    "and include a quote copied verbatim from that passage, at most 40 words, that supports "
    "the sentence. Write each sentence in your own words as finished prose: the quote goes "
    "only in the citation, never into the sentence, and the sentence does not mention "
    "passages, ids or quotes. If the passages cannot support a point, leave it out."
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
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["text", "citations"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["sentences"],
    "additionalProperties": False,
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
    "additionalProperties": False,
}

MATRIX_JUDGE_SYSTEM = (
    "Decide whether a literature review matrix supports a sentence written from it. The matrix has "
    "one line per study: its details, and for each column a short answer with the quote it rests on. "
    "The sentence may compare studies, generalise across them, or name what none of them covers; "
    "judge it against the whole table. 'supported' means the table states or directly implies it; "
    "'partial' means it backs only part, or the sentence overstates it (a claim about all studies that "
    "holds for most); 'unsupported' means the table does not back it or contradicts it. "
    "Give a one-sentence reason naming the studies that matter."
)

ROLES = ["independent", "dependent", "mediator", "moderator", "control"]

VARIABLES_SYSTEM = (
    "You help plan a study that addresses gaps found in a literature review. You are given review "
    "matrices (one line per study, its id in brackets: its details, and for each column a short answer "
    "with the quote behind it) and the gaps the study should address. List the variables (constructs) "
    "such a study would work with, at most 10, most central first. For each: a short name; the role it "
    "would most likely play (independent, dependent, mediator, moderator or control); one sentence on "
    "why it matters for the gaps; and how the reviewed studies measured or operationalised it, citing "
    "each study by its id and using only what its line says. Leave the measures empty for a variable "
    "no study measured."
)
VARIABLES_SCHEMA = {
    "type": "object",
    "properties": {
        "variables": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "role": {"type": "string", "enum": ROLES},
                    "why": {"type": "string"},
                    "measures": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"study": {"type": "string"}, "how": {"type": "string"}},
                            "required": ["study", "how"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["name", "role", "why", "measures"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["variables"],
    "additionalProperties": False,
}

PROPOSAL_SYSTEM = (
    "Write a research proposal for one study that addresses the chosen gaps, based on the review "
    "matrices given (one line per study, its id in brackets). Two kinds of content, kept apart:\n"
    "1. Background and gap describe the reviewed studies. Each paragraph lists, by id, every study it "
    "relies on, and says nothing about a study that its line doesn't state. In the text, refer to "
    "studies by author and year as their line shows, never by id.\n"
    "2. Everything else (research questions, hypotheses, design, data, analysis, contribution, "
    "limitations, timeline) is proposed for the new study: write it without citing anyone.\n"
    "Use the variables exactly as given, in the roles given; for each, say how this study would measure "
    "it and, by id, how the reviewed studies measured it (only what their lines say). The writer's "
    "exclusions are strict: propose nothing they rule out, not even as an option. Fit the design, data "
    "and timeline to what the writer says they have. Be concrete and plain; no filler."
)
_PARAS = {"type": "array", "items": {"type": "string"}}
_CITED = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {"text": {"type": "string"}, "studies": {"type": "array", "items": {"type": "string"}}},
        "required": ["text", "studies"],
        "additionalProperties": False,
    },
}
PROPOSAL_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "background": _CITED,
        "gap": _CITED,
        "research_questions": _PARAS,
        "hypotheses": _PARAS,
        "variables": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "role": {"type": "string", "enum": ROLES},
                    "measure": {"type": "string"},
                    "earlier": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"study": {"type": "string"}, "how": {"type": "string"}},
                            "required": ["study", "how"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["name", "role", "measure", "earlier"],
                "additionalProperties": False,
            },
        },
        "design": _PARAS,
        "data": _PARAS,
        "analysis": _PARAS,
        "contribution": _PARAS,
        "limitations": _PARAS,
        "timeline": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"when": {"type": "string"}, "what": {"type": "string"}},
                "required": ["when", "what"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "background", "gap", "research_questions", "hypotheses", "variables", "design", "data",
                 "analysis", "contribution", "limitations", "timeline"],
    "additionalProperties": False,
}

EXCLUSIONS_SYSTEM = (
    "Check a research proposal against what its writer ruled out. List every place where the proposal "
    "does, requires or offers as an option something an exclusion rules out: the exclusion, the "
    "section, and one sentence on what breaks it. Mentioning that something is avoided is fine. If "
    "nothing breaks an exclusion, return an empty list."
)
EXCLUSIONS_SCHEMA = {
    "type": "object",
    "properties": {
        "violations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"rule": {"type": "string"}, "section": {"type": "string"}, "why": {"type": "string"}},
                "required": ["rule", "section", "why"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["violations"],
    "additionalProperties": False,
}

MATRIX_SYSTEM = (
    "You fill one row of a literature review matrix for a single research paper, using ONLY the "
    "numbered passages from it. For each column, write a short, specific answer (at most 35 words: "
    "numbers, places, periods, designs, effect directions), give the id of the passage it comes "
    "from, and copy a verbatim quote from that passage (at most 40 words). Every fact in the answer "
    "must be stated in or right around that quote: a reader checks the answer against it. If the "
    "full answer is spread over several passages, answer with the most important part, the part "
    "your quote shows, rather than adding facts from elsewhere: no extra numbers, sample sizes, "
    "datasets, software, dates or demographics from other passages. If the passages do not report it, "
    "give an empty answer, passage and quote: never guess or fill in from general knowledge. "
    "Limitations count only when the authors state them."
)
MATRIX_SCHEMA = {
    "type": "object",
    "properties": {
        "cells": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "column": {"type": "string"},
                    "answer": {"type": "string"},
                    "passage": {"type": "string"},
                    "quote": {"type": "string"},
                },
                "required": ["column", "answer", "passage", "quote"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["cells"],
    "additionalProperties": False,
}

GAPS_SYSTEM = (
    "You are given a literature review matrix: one line per study with its sample, setting, "
    "method, findings and the like. Name the gaps a researcher could address: populations, "
    "places, periods or methods the studies leave out, questions none answers, and findings "
    "that conflict. Base every gap on the table only; name the studies it rests on. At most six, "
    "most important first, each a short title and one or two sentences."
)
GAPS_SCHEMA = {
    "type": "object",
    "properties": {
        "gaps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"title": {"type": "string"}, "detail": {"type": "string"}},
                "required": ["title", "detail"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["gaps"],
    "additionalProperties": False,
}

OCR_PROMPT = (
    "Transcribe all text in this image exactly, preserving reading order and line breaks. "
    "Describe diagrams in one bracketed line. Output only the transcription."
)


def format_passages(passages) -> str:
    return "\n\n".join(f"[{p.pid}] ({p.label})\n{p.text}" for p in passages)
