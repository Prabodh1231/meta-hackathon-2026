import fitz
import pytest
from fastapi.testclient import TestClient

from app.citations import locate_quote
from app.embeddings import HashEmbedder
from app.ingest import chunk_page
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.references import format_references
from app.settings import Settings

SLEEP_TEXT = """Sleep and Memory Consolidation
Alice Chen, Bob Martinez

Abstract. We studied how slow-wave sleep affects memory consolidation in 120 adults in 2021.
Participants who received targeted memory reactivation during slow-wave sleep recalled 18% more word pairs.
Spindle density during sleep predicted the size of the recall benefit. doi: 10.1234/sleep.2021.001
"""

CORAL_TEXT = """Coral Reef Bleaching Under Ocean Warming
Dana Okafor

Marine heatwaves in 2016 caused mass coral bleaching across the Great Barrier Reef.
Reefs exposed to prior moderate heat stress showed lower bleaching mortality, suggesting thermal acclimation.
Ocean warming projections imply bleaching events will become annual by 2050 on most reefs.
"""

SLEEP_NOTES = """# Notes on sleep spindles
Sleep spindles are bursts of oscillatory activity during non-REM sleep.
Spindle density correlates with overnight memory consolidation in several studies.
"""

CORAL_NOTES = """# Reef fieldwork notes
Coral bleaching was visible on shallow reef flats after the marine heatwave.
Ocean temperature loggers recorded warming of two degrees above the seasonal mean.
"""


@pytest.fixture
def corpus(tmp_path):
    folder = tmp_path / "corpus"
    folder.mkdir()
    for name, text in [("sleep.pdf", SLEEP_TEXT), ("coral.pdf", CORAL_TEXT)]:
        doc = fitz.open()
        page = doc.new_page()
        page.insert_textbox(fitz.Rect(50, 50, 550, 800), text, fontsize=10)
        doc.new_page().insert_text((50, 72), "Appendix: additional sleep spindle analyses.", fontsize=10)
        doc.save(folder / name)
    (folder / "sleep-notes.md").write_text(SLEEP_NOTES, encoding="utf-8")
    (folder / "coral-notes.txt").write_text(CORAL_NOTES, encoding="utf-8")
    (folder / "ignore.xyz").write_text("unsupported", encoding="utf-8")
    return folder


@pytest.fixture
def lib(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    return Library(settings, provider=MockProvider(), embedder=HashEmbedder())


@pytest.fixture
def client(lib):
    return TestClient(create_app(lib.settings, lib))


def test_ingest_folder_extracts_metadata_and_pages(client, corpus):
    results = client.post("/ingest/path", json={"path": str(corpus)}).json()["results"]
    assert len(results) == 4 and all(r["ok"] for r in results)

    docs = {d["title"]: d for d in client.get("/documents").json()}
    sleep = docs["Sleep and Memory Consolidation"]
    assert sleep["authors"] == ["Alice Chen", "Bob Martinez"]
    assert sleep["year"] == 2021
    assert sleep["doi"] == "10.1234/sleep.2021.001"
    assert sleep["page_count"] == 2
    assert sleep["tags"]
    assert sleep["label"] == "Chen & Martinez 2021"

    page2 = client.get(f"/documents/{sleep['id']}/pages/2").json()
    assert "Appendix" in page2["text"]


def test_reingest_replaces_instead_of_duplicating(client, corpus):
    client.post("/ingest/path", json={"path": str(corpus)})
    client.post("/ingest/path", json={"path": str(corpus / "sleep-notes.md")})
    assert len(client.get("/documents").json()) == 4


def test_search_and_topics_separate_the_two_themes(client, corpus):
    client.post("/ingest/path", json={"path": str(corpus)})
    hits = client.get("/search", params={"q": "coral bleaching heatwave"}).json()
    assert "Coral" in hits[0]["title"] or "Reef" in hits[0]["title"]

    topics = client.post("/topics/rebuild").json()
    assert len(topics) == 2
    docs = client.get("/documents").json()
    by_topic: dict[int, set[str]] = {}
    for d in docs:
        by_topic.setdefault(d["topic_id"], set()).add(d["title"])
    groups = sorted(by_topic.values(), key=lambda g: sorted(g))
    assert any({"Sleep and Memory Consolidation", "Notes on sleep spindles"} <= g for g in groups)
    assert any({"Coral Reef Bleaching Under Ocean Warming", "Reef fieldwork notes"} <= g for g in groups)


def test_user_topic_names_survive_rebuild_and_merge(client, corpus):
    client.post("/ingest/path", json={"path": str(corpus)})
    a, b = client.post("/topics/rebuild").json()
    client.patch(f"/topics/{a['id']}", json={"label": "My chosen name"})
    labels = [t["label"] for t in client.post("/topics/rebuild").json()]
    assert "My chosen name" in labels

    topics = client.get("/topics").json()
    merged = client.post("/topics/merge", json={"source_ids": [topics[1]["id"]], "into_id": topics[0]["id"]}).json()
    assert len(merged) == 1 and merged[0]["doc_count"] == 4


def test_draft_returns_located_citations_then_verifies(client, corpus):
    client.post("/ingest/path", json={"path": str(corpus)})
    draft = client.post("/write/draft", json={"instruction": "How does sleep affect memory consolidation?"}).json()
    assert draft["sentences"]
    cite = draft["sentences"][0]["citations"][0]
    assert cite["status"] == "pending"
    page = client.get(f"/documents/{cite['doc_id']}/pages/{cite['page']}").json()["text"]
    assert page[cite["start"] : cite["end"]] == cite["quote"]

    verified = client.post(
        "/citations/verify",
        json={"claim": draft["sentences"][0]["text"], "chunk_id": cite["chunk_id"], "quote": cite["quote"]},
    ).json()
    assert verified["status"] == "verified"

    unsupported = client.post(
        "/citations/verify",
        json={"claim": "Coral reefs bleach during marine heatwaves.", "chunk_id": cite["chunk_id"], "quote": cite["quote"]},
    ).json()
    assert unsupported["status"] == "unsupported"

    fabricated = client.post(
        "/citations/verify",
        json={"claim": "x", "chunk_id": cite["chunk_id"], "quote": "Quantum computers cure insomnia overnight."},
    ).json()
    assert fabricated["status"] == "quote_not_found"


def test_draft_retrieval_follows_instruction_not_existing_text(client, corpus):
    client.post("/ingest/path", json={"path": str(corpus)})
    context = "Sleep spindles and slow-wave sleep support memory consolidation in adults. " * 8
    draft = client.post("/write/draft", json={"instruction": "coral bleaching heatwave", "context": context}).json()
    titles = {d["id"]: d["title"] for d in client.get("/documents").json()}
    cited = [titles[c["doc_id"]] for s in draft["sentences"] for c in s["citations"]]
    assert cited and ("Coral" in cited[0] or "Reef" in cited[0])


def test_draft_can_be_scoped_to_documents(client, corpus):
    client.post("/ingest/path", json={"path": str(corpus)})
    coral = next(d for d in client.get("/documents").json() if d["title"].startswith("Coral"))
    draft = client.post("/write/draft", json={"instruction": "memory and sleep", "doc_ids": [coral["id"]]}).json()
    assert {c["doc_id"] for s in draft["sentences"] for c in s["citations"]} == {coral["id"]}


def test_references_endpoint(client, corpus):
    client.post("/ingest/path", json={"path": str(corpus)})
    ids = [d["id"] for d in client.get("/documents").json()]
    apa = client.post("/references", json={"doc_ids": ids, "style": "apa"}).json()["entries"]
    assert "Chen, A., & Martinez, B. (2021). Sleep and Memory Consolidation. https://doi.org/10.1234/sleep.2021.001" in apa
    assert client.post("/references", json={"doc_ids": ids, "style": "chicago"}).status_code == 400


def test_drafts_roundtrip(client):
    assert client.get("/drafts/1").json()["content"] == ""
    client.put("/drafts/1", json={"title": "Ch. 2", "content": "{\"type\":\"doc\"}"})
    assert client.get("/drafts/1").json()["title"] == "Ch. 2"


def test_settings_defaults_persist_and_validate(client, lib):
    assert client.get("/settings").json() == {"theme": "system", "citation_style": "apa"}
    assert client.patch("/settings", json={"theme": "dark"}).json() == {"theme": "dark", "citation_style": "apa"}
    assert client.patch("/settings", json={"citation_style": "ieee"}).json()["theme"] == "dark"
    assert client.patch("/settings", json={"theme": "sepia"}).status_code == 400
    assert client.patch("/settings", json={"font": "x"}).status_code == 400
    # Survives a restart: a new Library on the same data dir reads it back.
    again = Library(lib.settings, provider=MockProvider(), embedder=HashEmbedder())
    assert again.get_settings() == {"theme": "dark", "citation_style": "ieee"}


def test_token_is_required_when_configured(tmp_path):
    settings = Settings(data_dir=tmp_path / "d", api_token="secret")
    app = create_app(settings, Library(settings, provider=MockProvider(), embedder=HashEmbedder()))
    c = TestClient(app)
    assert c.get("/health").status_code == 200
    assert c.get("/documents").status_code == 401
    assert c.get("/documents", headers={"x-rc-token": "secret"}).status_code == 200


@pytest.mark.parametrize(
    "quote, text, expected",
    [
        ("exact words", "some exact words here", "exact words"),
        ("Exact   WORDS", "some exact\nwords here", "exact\nwords"),
        ("“thermal acclimation”", "suggesting thermal acclimation.", "thermal acclimation"),
        ("spindle densty predicted recall", "Spindle density predicted recall.", "Spindle density predicted recall"),
    ],
)
def test_locate_quote_tolerates_formatting(quote, text, expected):
    s, e, _ = locate_quote(quote, text)
    assert text[s:e] == expected


def test_locate_quote_rejects_unrelated_text():
    assert locate_quote("completely different sentence about stars", "Coral bleaching on reefs.") is None


def test_chunks_cover_text_with_valid_offsets():
    text = " ".join(f"Sentence number {i} talks about topic {i}." for i in range(100))
    spans = chunk_page(text, max_chars=200)
    assert spans[0][0] == 0 and spans[-1][1] == len(text)
    assert all(e - s <= 200 for s, e in spans)
    assert all(text[s:e].strip() == text[s:e] for s, e in spans)


def test_reference_styles():
    doc = {"title": "A Study", "authors": ["Jane Q. Doe", "Smith, John", "Li Wei"], "year": 2020,
           "venue": "Nature", "doi": "10.1/x", "kind": "pdf"}
    assert format_references([doc], "apa")[0] == "Doe, J. Q., Smith, J., & Wei, L. (2020). A Study. Nature. https://doi.org/10.1/x"
    assert format_references([doc], "mla")[0].startswith("Doe, Jane Q., et al. “A Study.” Nature, 2020.")
    assert format_references([doc], "ieee")[0].startswith("[1] J. Q. Doe, J. Smith, and L. Wei, “A Study,” Nature, 2020.")
    assert format_references([doc], "bibtex")[0].startswith("@article{doe2020study,")
    undated = {**doc, "year": None, "doi": ""}
    assert format_references([undated], "ieee")[0].endswith("Nature, n.d.")


def test_metadata_venue_regex_is_linear_on_all_caps_lines():
    # An NBER cover page froze ingest: the venue pattern backtracked exponentially on
    # all-caps lines. It must stay instant, and still find real venues.
    import time

    text = ("LIMITED ASSET MARKET PARTICIPATION AND THE ELASTICITY OF\nINTERTEMPORAL SUBSTITUTION\n"
            "Annette Vissing-Jorgensen\nWorking Paper 8896\nNATIONAL BUREAU OF ECONOMIC RESEARCH\n"
            "NATIONAL BUREAU OF ECONOMIC RESEARCH ANNUAL MEETING SESSION PAPERS AND PROCEEDINGSX\n")
    start = time.perf_counter()
    assert MockProvider().extract_metadata(text)["venue"] == ""
    assert time.perf_counter() - start < 1
    paper = "Household Finance Puzzles\nThe Review of Financial Studies, 2010\n"
    assert MockProvider().extract_metadata(paper)["venue"] == "The Review of Financial Studies"
