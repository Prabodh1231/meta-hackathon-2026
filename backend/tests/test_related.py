import pytest
from fastapi.testclient import TestClient

from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings

from test_citegraph import FILLER, HONG, LITERACY, ONLY_A, TRUST, add, paper


class NoTags(MockProvider):
    def tag_document(self, title, text):
        return ["misc"]


@pytest.fixture
def lib(tmp_path):
    return Library(Settings(data_dir=tmp_path / "data"), provider=NoTags())


def test_related_names_citations_shared_references_and_shared_words(lib, tmp_path):
    trust = add(lib, tmp_path, "t.txt", paper("Trusting the stock market and its many hidden risks", FILLER, year=2008))
    a = add(lib, tmp_path, "a.txt", paper("First study of household finance", [TRUST, HONG, ONLY_A, *FILLER]))
    b = add(lib, tmp_path, "b.txt", paper("Second study of household finance", [TRUST, HONG, LITERACY, *FILLER]))
    other = add(lib, tmp_path, "o.txt", paper("Glacier retreat in the southern Andes mountains", []))

    by_id = {r["doc_id"]: r for r in lib.related(a)}
    assert by_id[trust]["cited_by_this"] and not by_id[trust]["cites_this"]
    assert by_id[b]["shared_refs"] >= 2  # the trust paper, Hong & Kubik and the filler entries
    assert {"household", "finance"} <= set(by_id[b]["words"])
    assert other not in by_id  # nothing links it: no citation, no shared reference, no shared wording
    assert a not in by_id

    back = {r["doc_id"]: r for r in lib.related(trust)}
    assert back[a]["cites_this"] and back[b]["cites_this"]


def test_related_puts_the_closest_first_and_keeps_to_the_limit(lib, tmp_path):
    trust = add(lib, tmp_path, "t.txt", paper("Trusting the stock market and its many hidden risks", FILLER, year=2008))
    a = add(lib, tmp_path, "a.txt", paper("First study of household finance", [TRUST, HONG, ONLY_A, *FILLER]))
    b = add(lib, tmp_path, "b.txt", paper("Second study of household finance", [HONG, LITERACY, *FILLER]))
    ranked = lib.related(a, limit=5)
    assert [r["doc_id"] for r in ranked][:2] == [trust, b] or [r["doc_id"] for r in ranked][:2] == [b, trust]
    assert len(lib.related(a, limit=1)) == 1
    assert lib.related(a) == lib.related(a)  # the kept graph answers the same the second time


def test_a_keyword_most_of_the_library_carries_relates_nothing(lib, tmp_path):
    ids = [add(lib, tmp_path, f"p{i}.txt", paper(title, []))
           for i, title in enumerate([
               "Glacier retreat in the southern Andes mountains", "Sonnet structure across Elizabethan poets",
               "Enzyme kinetics under high pressure regimes", "Tram networks of interwar Vienna suburbs"])]
    assert lib.related(ids[0]) == []  # every paper is tagged "misc", and that is all they share


def test_related_sees_a_paper_added_later(lib, tmp_path):
    a = add(lib, tmp_path, "a.txt", paper("First study of household finance", [TRUST, HONG, ONLY_A, *FILLER]))
    assert lib.related(a) == []
    trust = add(lib, tmp_path, "t.txt", paper("Trusting the stock market and its many hidden risks", FILLER, year=2008))
    assert [r["doc_id"] for r in lib.related(a)] == [trust]


def test_related_over_the_api_and_highlight_counts(tmp_path):
    settings = Settings(data_dir=tmp_path / "data")
    with TestClient(create_app(settings, Library(settings, provider=NoTags()))) as client:
        for name, text in [("t.txt", paper("Trusting the stock market and its many hidden risks", FILLER, year=2008)),
                           ("a.txt", paper("First study of household finance", [TRUST, *FILLER]))]:
            f = tmp_path / name
            f.write_text(text, encoding="utf-8")
            assert client.post("/ingest/path", json={"path": str(f)}).json()["results"][0]["ok"]
        docs = {d["title"]: d for d in client.get("/documents").json()}
        a, trust = docs["First study of household finance"], docs["Trusting the stock market and its many hidden risks"]
        assert a["highlights"] == 0
        related = client.get(f"/documents/{a['id']}/related").json()
        assert related[0]["doc_id"] == trust["id"] and related[0]["cited_by_this"]
        assert client.get("/documents/9999/related").status_code == 404
        client.post(f"/documents/{a['id']}/highlights", json={"page": 1, "text": "Body text about the paper."})
        assert client.get(f"/documents/{a['id']}").json()["highlights"] == 1
