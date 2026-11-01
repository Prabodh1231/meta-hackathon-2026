import json

from app.providers.base import LLMProvider

from test_pipeline import client, corpus, lib  # noqa: F401  (fixtures)


def test_answer_cites_located_quotes_and_follows_up(client, corpus):
    client.post("/ingest/path", json={"path": str(corpus)})
    turn = client.post("/drafts/1/ask", json={"question": "How does sleep affect memory consolidation?"}).json()
    assert turn["question"].startswith("How does sleep")
    assert turn["sentences"] and turn["general"] == ""
    cite = turn["sentences"][0]["citations"][0]
    assert cite["status"] == "pending"
    page = client.get(f"/documents/{cite['doc_id']}/pages/{cite['page']}").json()["text"]
    assert page[cite["start"] : cite["end"]] == cite["quote"]
    assert turn["followups"]


def test_question_the_library_cannot_answer_is_marked_general(client, corpus):
    client.post("/ingest/path", json={"path": str(corpus)})
    turn = client.post("/drafts/1/ask", json={"question": "Who won the 1998 football world cup?"}).json()
    assert turn["sentences"] == []
    assert turn["general"]


def test_conversation_is_kept_per_draft_with_checked_citations(client, corpus):
    client.post("/ingest/path", json={"path": str(corpus)})
    first = client.post("/drafts/1/ask", json={"question": "coral bleaching heatwave"}).json()
    client.post("/drafts/2/ask", json={"question": "sleep spindles"})
    assert [t["question"] for t in client.get("/drafts/1/ask").json()] == ["coral bleaching heatwave"]

    checked = [{**s, "citations": [{**c, "status": "verified"} for c in s["citations"]]} for s in first["sentences"]]
    client.put(f"/ask/{first['id']}", json={"sentences": checked})
    kept = client.get("/drafts/1/ask").json()[0]
    assert all(c["status"] == "verified" for s in kept["sentences"] for c in s["citations"])
    assert kept["followups"] == first["followups"]

    client.delete("/drafts/1/ask")
    assert client.get("/drafts/1/ask").json() == []
    assert len(client.get("/drafts/2/ask").json()) == 1


def test_deleting_a_draft_deletes_its_conversation(client, corpus):
    client.post("/ingest/path", json={"path": str(corpus)})
    draft = client.post("/drafts", json={"title": "Chapter"}).json()
    client.post(f"/drafts/{draft['id']}/ask", json={"question": "sleep"})
    client.delete(f"/drafts/{draft['id']}")
    assert client.get(f"/drafts/{draft['id']}/ask").json() == []


class Recorder(LLMProvider):
    """Answers every question with one sentence citing P1 and a sentence citing an invented id,
    and records what it was sent."""

    def __init__(self):
        self.sent: list[str] = []

    def chat(self, messages, *, schema=None, max_tokens=1024, temperature=0.2) -> str:
        self.sent.append(messages[-1]["content"])
        p1 = messages[-1]["content"].split("[P1]", 1)[1].split("\n", 2)[1]
        return json.dumps({
            "sentences": [{"text": "Backed.", "citations": [{"passage": "P1", "quote": p1[:60]}]},
                          {"text": "Invented.", "citations": [{"passage": "P9", "quote": "nothing"}]}],
            "general": "Beyond the sources.",
            "followups": ["One?", " ", "Two?", "Three?", "Four?"],
        })

    def transcribe_image(self, data, mime):
        return ""


def test_follow_ups_see_the_conversation_and_selection(lib, corpus):
    lib.ingest_path(str(corpus))
    lib.provider = rec = Recorder()
    lib.ask(1, "What did the sleep study find?")
    turn = lib.ask(1, "How large was it?", context="My paragraph.", selection="targeted memory reactivation")
    sent = rec.sent[-1]
    assert "Q: What did the sleep study find?\nA: Backed. Beyond the sources." in sent
    assert "My paragraph." in sent and "targeted memory reactivation" in sent
    # A sentence citing a passage that wasn't given is dropped rather than shown as sourced.
    assert [s["text"] for s in turn["sentences"]] == ["Backed."]
    assert turn["general"] == "Beyond the sources."
    assert turn["followups"] == ["One?", "Two?", "Three?"]
    assert turn["selection"] == "targeted memory reactivation"
