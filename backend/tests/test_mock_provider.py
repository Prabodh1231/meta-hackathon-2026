"""The offline provider's heuristics: what the app does without a model."""
from app.providers.mock import MockProvider

mock = MockProvider()


def test_expansion_never_repeats_the_query():
    assert mock.expand_query("memory consolidation") == ["memory", "consolidation"]
    assert "Memory  consolidation".lower() not in [q.lower() for q in mock.expand_query("Memory  consolidation")]


def test_repair_keeps_the_first_reported_answer():
    rows = '[Smith 2021] "T": Sample: not reported | Setting: unknown | Finding: grew'
    assert mock.repair_claims([{"claim": "x", "reason": "y", "rows": rows}]) == ["Smith 2021 reports grew."]
    assert mock.repair_claims([{"claim": "x", "reason": "y", "rows": '[Smith 2021] "T": Sample: not reported'}]) == [""]


def test_saying_something_is_avoided_does_not_break_the_rule():
    assert mock.check_exclusions("No surveys", "We do not use surveys. We use tax records.") == []
    assert mock.check_exclusions("No surveys", "We avoid surveys entirely.") == []
    [hit] = mock.check_exclusions("No surveys", "We run surveys of firms.")
    assert hit["rule"] == "No surveys"


def test_gaps_read_column_names_with_punctuation():
    table = ("A (Title one): Sample (N): not reported | Data/Method: not reported\n"
             "B (Title two): Sample (N): not reported | Data/Method: panel survey")
    assert mock.find_gaps("t", table) == [
        {"title": "Little on sample (n)", "detail": "2 of 2 studies don't report it."},
        {"title": "Little on data/method", "detail": "1 of 2 studies don't report it."},
    ]


def test_a_sample_size_is_not_the_year():
    text = "A study of sleep in adults\nJane Doe\nWe recruited N = 2000 people. Published 2019."
    assert mock.extract_metadata(text)["year"] == 2019
    assert mock.extract_metadata("A study of sleep in adults\nJane Doe 2015\nn=1990 children")["year"] == 2015


def test_question_review_without_the_headers_finds_nothing():
    out = mock.review_questions("Core question: Does sleep help?\n\nSomething else entirely")
    assert out["questions"] == [] and out["title"] == "" and out["core_question"] == "Does sleep help?"
