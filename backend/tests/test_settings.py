"""The Settings window's preferences, switching the model, and serving a library file."""
import pytest
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings, read_env_file


@pytest.fixture
def lib(tmp_path):
    return Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), embedder=HashEmbedder())


@pytest.fixture
def client(lib):
    return TestClient(create_app(lib.settings, lib))


def test_numbers_booleans_and_text_are_validated(client):
    s = client.get("/settings").json()
    assert (s["assistant_passages"], s["spellcheck"], s["snapshot_minutes"], s["contact_email"]) == (8, True, 10, "")
    ok = client.patch("/settings", json={"assistant_passages": 12, "spellcheck": False, "page_width": "wide"})
    assert ok.status_code == 200 and ok.json()["assistant_passages"] == 12 and ok.json()["spellcheck"] is False
    for bad in ({"assistant_passages": 40}, {"assistant_passages": "12"}, {"spellcheck": 1},
                {"page_width": "huge"}, {"contact_email": "not an email"}, {"snapshots_kept": True}):
        assert client.patch("/settings", json=bad).status_code == 400, bad
    assert client.patch("/settings", json={"contact_email": "me@uni.edu"}).json()["contact_email"] == "me@uni.edu"


def test_contact_email_reaches_the_open_access_lookups(client, lib):
    client.patch("/settings", json={"contact_email": "me@uni.edu"})
    assert lib.open_access.mailto == "me@uni.edu"
    assert "mailto:me@uni.edu" in lib.open_access.client.headers["User-Agent"]


def test_duplicate_sensitivity_and_snapshot_settings_are_used(lib):
    lib.update_settings({"snapshots_kept": 10, "snapshot_minutes": 2})
    for i in range(14):  # each save differs, and the newest is backdated so the next one snapshots
        lib.save_draft(1, "t", f'{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"Version {i}."}}]}}]}}')
        with lib.conn:
            lib.conn.execute("UPDATE draft_versions SET created_at = datetime('now', '-1 hour')")
    assert len([v for v in lib.list_versions(1)["versions"] if v["kind"] == "auto"]) == 10


def test_switching_the_model_writes_env_and_never_returns_the_key(client, lib):
    m = client.get("/settings/model").json()
    assert m["provider"] == "mock" and m["has_key"] is False
    assert client.put("/settings/model", json={"provider": "muse"}).status_code == 400  # no key yet
    assert client.put("/settings/model", json={"api_key": "has space"}).status_code == 400
    r = client.put("/settings/model", json={"provider": "muse", "api_key": "sk-test-1234567890abcd", "reasoning_effort": "medium"})
    assert r.status_code == 200
    body = r.json()
    assert body["provider"] == "muse" and body["has_key"] and body["key_hint"] == "abcd"
    assert "sk-test" not in r.text
    assert client.get("/health").json()["provider"] == "muse"
    env = read_env_file(lib.settings.data_dir / ".env")
    assert env == {"RC_PROVIDER": "muse", "MUSE_REASONING_EFFORT": "medium", "MUSE_API_KEY": "sk-test-1234567890abcd"}
    # Back to the mock keeps the key for later.
    assert client.put("/settings/model", json={"provider": "mock"}).json()["has_key"] is True
    assert read_env_file(lib.settings.data_dir / ".env")["RC_PROVIDER"] == "mock"


def test_env_file_keeps_other_lines(tmp_path):
    from app.settings import write_env_file

    f = tmp_path / ".env"
    f.write_text("# my notes\nRC_CONTACT_EMAIL=a@b.c\nRC_PROVIDER=mock\n", encoding="utf-8")
    write_env_file(f, {"RC_PROVIDER": "muse", "MUSE_API_KEY": "k"})
    assert f.read_text(encoding="utf-8") == "# my notes\nRC_CONTACT_EMAIL=a@b.c\nRC_PROVIDER=muse\nMUSE_API_KEY=k\n"


def test_document_file_serves_library_files_only(client, lib, tmp_path):
    note = tmp_path / "note.md"
    note.write_text("# Reef notes\n\nCorals bleach when the water warms.", encoding="utf-8")
    doc_id = lib.ingest_path(str(note))[0]["document"]["id"]
    r = client.get(f"/documents/{doc_id}/file")
    assert r.status_code == 200 and b"Corals bleach" in r.content
    assert "attachment" not in r.headers.get("content-disposition", "")
    assert client.get("/documents/9999/file").status_code == 404
    note.unlink()
    assert client.get(f"/documents/{doc_id}/file").status_code == 404
