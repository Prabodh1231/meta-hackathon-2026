import pytest
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings

QUOTE = "Spindle density after each cue predicted recall of the cued word pairs."
NOTES = f"""# Sleep notes
Background on sleep and memory consolidation in adults.
{QUOTE}
REM sleep cues produced no measurable benefit.
"""


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    return TestClient(create_app(settings, Library(settings, provider=MockProvider(), embedder=HashEmbedder())))


def add(client, path):
    results = client.post("/ingest/path", json={"path": str(path)}).json()["results"]
    assert all(r["ok"] for r in results), results
    return results[0]["document"]


def resolve(client, doc_id, page, quote):
    return client.post("/citations/resolve", json={"items": [{"doc_id": doc_id, "page": page, "quote": quote}]}).json()[0]


def test_reingest_keeps_id_topic_tags_and_user_edits(client, tmp_path):
    f = tmp_path / "notes.md"
    f.write_text(NOTES, encoding="utf-8")
    doc = add(client, f)
    client.post("/topics/rebuild")
    client.patch(f"/documents/{doc['id']}", json={"title": "My corrected title", "tags": ["chapter-2"]})
    topic_id = client.get(f"/documents/{doc['id']}").json()["topic_id"]
    assert topic_id is not None

    f.write_text(NOTES + "\nA new finding added later about spindles.\n", encoding="utf-8")
    again = add(client, f)

    assert again["id"] == doc["id"]
    assert again["topic_id"] == topic_id
    assert again["tags"] == ["chapter-2"]
    assert again["title"] == "My corrected title"  # user edit survives
    assert again["edited_fields"] == ["title"]
    assert "A new finding" in client.get(f"/documents/{doc['id']}/pages/1").json()["text"]  # content refreshed
    assert len(client.get("/documents").json()) == 1


def test_unedited_metadata_is_refreshed_on_reingest(client, tmp_path):
    f = tmp_path / "notes.md"
    f.write_text(NOTES, encoding="utf-8")
    doc = add(client, f)
    f.write_text(NOTES.replace("# Sleep notes", "# Renamed notes"), encoding="utf-8")
    assert add(client, f)["title"] == "Renamed notes"
    assert client.get(f"/documents/{doc['id']}").json()["edited_fields"] == []


def test_citation_follows_quote_after_file_changes(client, tmp_path):
    f = tmp_path / "notes.md"
    f.write_text(NOTES, encoding="utf-8")
    doc = add(client, f)
    old = resolve(client, doc["id"], 1, QUOTE)

    f.write_text("# Sleep notes\n" + "An inserted paragraph that shifts every offset. " * 5 + "\n\n" + NOTES, encoding="utf-8")
    add(client, f)
    new = resolve(client, doc["id"], 1, QUOTE)

    assert new["doc_id"] == doc["id"]
    assert new["start"] > old["start"]
    assert new["chunk_id"] != old["chunk_id"]  # chunks were rebuilt
    page = client.get(f"/documents/{doc['id']}/pages/1").json()["text"]
    assert page[new["start"] : new["end"]] == QUOTE
    chunk_ok = client.post("/citations/verify", json={"claim": QUOTE, "chunk_id": new["chunk_id"], "quote": QUOTE})
    assert chunk_ok.json()["status"] == "verified"


def test_citation_to_deleted_then_readded_document_is_recovered(client, tmp_path):
    f = tmp_path / "notes.md"
    f.write_text(NOTES, encoding="utf-8")
    doc = add(client, f)
    client.delete(f"/documents/{doc['id']}")
    readded = add(client, f)
    assert readded["id"] != doc["id"]

    r = resolve(client, doc["id"], 1, QUOTE)
    assert r["doc_id"] == readded["id"]


def test_ids_are_never_reused_after_delete(client, tmp_path):
    a, b = tmp_path / "a.md", tmp_path / "b.md"
    a.write_text(NOTES, encoding="utf-8")
    b.write_text("# Unrelated\nCoral reefs bleach during marine heatwaves.\n", encoding="utf-8")
    first = add(client, a)
    client.delete(f"/documents/{first['id']}")
    second = add(client, b)
    assert second["id"] != first["id"]
    # A citation to the deleted document must not resolve into the unrelated newcomer.
    assert resolve(client, first["id"], 1, QUOTE) is None


def test_citation_is_not_moved_to_another_source(client, tmp_path):
    # The quote vanished from the cited document but appears in another one. While the cited
    # document still exists, the citation must be reported missing, not silently re-pointed.
    paper, other = tmp_path / "paper.md", tmp_path / "other.md"
    paper.write_text(NOTES, encoding="utf-8")
    other.write_text(f"# Someone quoting it\n{QUOTE}\n", encoding="utf-8")
    doc = add(client, paper)
    add(client, other)
    paper.write_text("# Sleep notes\nThe file was rewritten and no longer says that.\n", encoding="utf-8")
    add(client, paper)
    assert resolve(client, doc["id"], 1, QUOTE) is None


def test_quote_moved_to_another_page_is_found(client, tmp_path):
    import fitz

    pdf = tmp_path / "paper.pdf"

    def write(pages):
        d = fitz.open()
        for text in pages:
            d.new_page().insert_textbox(fitz.Rect(72, 72, 520, 760), text, fontsize=10)
        d.save(pdf)

    write(["Introduction about sleep and memory in adults.", QUOTE])
    doc = add(client, pdf)
    write(["Introduction about sleep and memory in adults.", "A new page was inserted here.", QUOTE])
    add(client, pdf)
    r = resolve(client, doc["id"], 2, QUOTE)
    assert (r["doc_id"], r["page"]) == (doc["id"], 3)
