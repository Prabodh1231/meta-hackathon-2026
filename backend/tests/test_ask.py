import json

from app.providers.base import LLMProvider

from test_pipeline import client, corpus, lib  # noqa: F401  (fixtures)


class Recorder(LLMProvider):
    """Replies "Reply N." and records the messages it was sent."""

    def __init__(self):
        self.sent: list[list[dict]] = []

    def chat(self, messages, *, schema=None, max_tokens=1024, temperature=0.2) -> str:
        assert schema is None  # a plain chat, not JSON
        self.sent.append(messages)
        return f"  Reply {len(self.sent)}.  "

    def transcribe_image(self, data, mime):
        return ""


def test_chat_carries_the_conversation_paragraph_and_selection(lib):
    lib.provider = rec = Recorder()
    first = lib.ask(1, "What is a sleep spindle?")
    assert first["reply"] == "Reply 1."
    turn = lib.ask(1, "Reword it", context="My paragraph.", selection="targeted memory reactivation")
    roles = [m["role"] for m in rec.sent[-1]]
    assert roles == ["system", "user", "assistant", "user"]
    assert rec.sent[-1][1]["content"] == "What is a sleep spindle?"
    assert rec.sent[-1][2]["content"] == "Reply 1."
    last = rec.sent[-1][-1]["content"]
    assert "My paragraph." in last and "targeted memory reactivation" in last and last.endswith("Reword it")
    assert turn["reply"] == "Reply 2." and turn["selection"] == "targeted memory reactivation"


def test_chat_does_not_search_the_library(lib, corpus, monkeypatch):
    lib.ingest_path(str(corpus))
    lib.provider = Recorder()
    monkeypatch.setattr(lib, "search", lambda *a, **k: (_ for _ in ()).throw(AssertionError("searched")))
    assert lib.ask(1, "sleep and memory")["reply"] == "Reply 1."


def test_chat_is_kept_per_draft_and_can_be_cleared(client):
    reply = client.post("/drafts/1/ask", json={"question": "Hello"}).json()
    assert reply["question"] == "Hello" and reply["reply"]
    client.post("/drafts/2/ask", json={"question": "Other draft"})
    assert [t["question"] for t in client.get("/drafts/1/ask").json()] == ["Hello"]

    client.delete("/drafts/1/ask")
    assert client.get("/drafts/1/ask").json() == []
    assert len(client.get("/drafts/2/ask").json()) == 1


def test_deleting_a_draft_deletes_its_chat(client):
    draft = client.post("/drafts", json={"title": "Chapter"}).json()
    client.post(f"/drafts/{draft['id']}/ask", json={"question": "Hi"})
    client.delete(f"/drafts/{draft['id']}")
    assert client.get(f"/drafts/{draft['id']}/ask").json() == []


def test_answers_kept_before_the_chat_still_read(lib):
    old = {"sentences": [{"text": "Sourced one.", "citations": []}, {"text": "Sourced two.", "citations": []}],
           "general": "Beyond the sources.", "followups": []}
    with lib.conn:
        lib.conn.execute("INSERT INTO ask_turns (draft_id, question, answer) VALUES (1, 'Old?', ?)", (json.dumps(old),))
    assert lib.ask_turns(1)[0]["reply"] == "Sourced one. Sourced two.\n\nBeyond the sources."
