import base64
import io
import json

import docx
import pytest
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings

# A 1x1 transparent PNG, to put an image in the test document.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    return TestClient(create_app(settings, Library(settings, provider=MockProvider(), embedder=HashEmbedder())))


def word_file() -> bytes:
    d = docx.Document()
    d.add_heading("Thermal acclimation of reef corals", level=0)  # the Title style
    d.add_heading("Introduction", level=1)
    p = d.add_paragraph("Reefs are ")
    p.add_run("bleaching").bold = True
    p.add_run(" more ")
    p.add_run("often").italic = True
    p.add_run(".\nA second line after a break.")
    d.add_paragraph("")  # empty paragraphs are skipped
    d.add_paragraph("First point", style="List Bullet")
    d.add_paragraph("Second point", style="List Bullet")
    d.add_paragraph("Step one", style="List Number")
    d.add_paragraph("Step two", style="List Number")
    d.add_heading("Results", level=2)
    t = d.add_table(rows=2, cols=2)
    t.cell(0, 0).text, t.cell(0, 1).text = "Site", "Bleached"
    t.cell(1, 0).text, t.cell(1, 1).text = "Heron Island", "42%"
    d.add_paragraph().add_run().add_picture(io.BytesIO(PNG))
    d.add_paragraph("Closing paragraph.")
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def test_open_a_word_file_as_a_new_draft(client):
    r = client.post("/drafts/import", json={"filename": "chapter.docx", "data": base64.b64encode(word_file()).decode()})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["imported"] == {"headings": 3, "paragraphs": 2, "list_items": 4, "tables": 1, "images": 1}
    draft = out["draft"]
    assert draft["title"] == "Thermal acclimation of reef corals"
    nodes = json.loads(draft["content"])["content"]
    assert [n["type"] for n in nodes] == [
        "heading", "heading", "paragraph", "bulletList", "orderedList", "heading", "paragraph", "paragraph", "paragraph",
    ]
    assert [n["attrs"]["level"] for n in nodes if n["type"] == "heading"] == [1, 1, 2]
    para = nodes[2]["content"]
    assert {"type": "text", "text": "bleaching", "marks": [{"type": "bold"}]} in para
    assert {"type": "text", "text": "often", "marks": [{"type": "italic"}]} in para
    assert {"type": "hardBreak"} in para
    assert len(nodes[3]["content"]) == 2 and len(nodes[4]["content"]) == 2
    assert nodes[6]["content"][0]["text"] == "Site | Bleached"
    assert nodes[7]["content"][0]["text"] == "Heron Island | 42%"

    # It is a draft like any other: listed, with its first version taken.
    listed = client.get("/drafts").json()
    assert listed[0]["id"] == draft["id"] and listed[0]["words"] > 20
    assert len(client.get(f"/drafts/{draft['id']}/versions").json()["versions"]) == 1


def test_not_a_word_file_is_refused_clearly(client):
    r = client.post("/drafts/import", json={"filename": "notes.docx", "data": base64.b64encode(b"plain text").decode()})
    assert r.status_code == 400 and "Word document" in r.json()["detail"]
    assert client.post("/drafts/import", json={"filename": "x.docx", "data": "%%%"}).status_code == 400
    assert client.get("/drafts").json() == []


def test_new_and_deleted_drafts(client):
    client.put("/drafts/1", json={"title": "First", "content": json.dumps(
        {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Some words here."}]}]})})
    new = client.post("/drafts", json={}).json()
    assert new["id"] != 1 and new["content"] == ""
    assert {d["id"] for d in client.get("/drafts").json()} == {1, new["id"]}

    assert client.get("/drafts/1/versions").json()["versions"]
    assert client.delete("/drafts/1").json() == {"ok": True}
    assert [d["id"] for d in client.get("/drafts").json()] == [new["id"]]
    assert client.get("/drafts/1/versions").json()["versions"] == []  # its history went with it
    assert client.delete("/drafts/1").status_code == 404


def test_word_sources_include_table_text(client, tmp_path):
    f = tmp_path / "chapter.docx"
    f.write_bytes(word_file())
    [res] = client.post("/ingest/path", json={"path": str(f)}).json()["results"]
    assert res["ok"], res
    text = client.get(f"/documents/{res['document']['id']}/pages/1").json()["text"]
    assert "Heron Island | 42%" in text and "Closing paragraph." in text


def test_old_word_files_get_a_clear_message(client, tmp_path):
    f = tmp_path / "old.doc"
    f.write_bytes(b"\xd0\xcf\x11\xe0 not really")
    [res] = client.post("/ingest/path", json={"path": str(f)}).json()["results"]
    assert not res["ok"] and "save it as .docx" in res["error"]
