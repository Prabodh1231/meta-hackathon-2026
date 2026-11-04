import pytest

from app.library import Library
from app.providers import MockProvider
from app.settings import Settings


def paper(title: str, refs: list[str], year: int = 2020) -> str:
    return f"{title}\nSome Author {year}\n\nAbstract. " + "Body text about the paper. " * 30 + "\n\nReferences\n" + "\n".join(refs) + "\n"


TRUST = "Smith, J., Lee, K., 2008. Trusting the stock market and its many hidden risks. Journal of Finance 63, 2557-2600."
LITERACY = "Doe, B., 2011. Financial literacy and stock market participation in households. Journal of Economics 5, 1-30."
HONG = "Hong, H., Kubik, J., 2004. Social interaction and stock-market participation across towns. Journal of Finance 59, 137-163."
ONLY_A = "Roe, R., 2015. A reference only the first paper cites about bond markets. Journal of Bonds 1, 1-9."
NAMES = ["Adler", "Brandt", "Cohen", "Dumont", "Eriksen", "Fischer", "Garcia", "Hoffman"]
FILLER = [f"{n}, A., 20{10 + i}. Filler reference number {i} on assorted unrelated subjects. Journal {i}, 1-{i + 5}." for i, n in enumerate(NAMES)]


class NoTags(MockProvider):
    """The mock tags a paper with its own most frequent words, which would make a stray mention look like a topic."""

    def tag_document(self, title, text):
        return ["misc"]


@pytest.fixture
def lib(tmp_path):
    return Library(Settings(data_dir=tmp_path / "data"), provider=NoTags())


def add(lib, tmp_path, name, text):
    f = tmp_path / name
    f.write_text(text, encoding="utf-8")
    [res] = lib.ingest_path(str(f))
    assert res["ok"], res
    return res["document"]["id"]


def test_the_graph_links_citations_coupling_and_missing_works(lib, tmp_path):
    trust = add(lib, tmp_path, "t.txt", paper("Trusting the stock market and its many hidden risks", FILLER, year=2008))
    a = add(lib, tmp_path, "a.txt", paper("First study of household finance", [TRUST, HONG, ONLY_A, *FILLER]))
    b = add(lib, tmp_path, "b.txt", paper("Second study of household finance", [TRUST, HONG, LITERACY, *FILLER]))
    graph = lib.citation_graph()

    cites = {(e["source"], e["target"]) for e in graph["citations"] if e["target"].startswith("doc:")}
    assert cites == {(f"doc:{a}", f"doc:{trust}"), (f"doc:{b}", f"doc:{trust}")}
    (pair,) = [c for c in graph["coupling"] if {c["source"], c["target"]} == {f"doc:{a}", f"doc:{b}"}]
    assert pair["weight"] >= 2  # the shared library paper and the shared missing one, plus the filler
    (hong,) = [m for m in graph["missing"] if m["title"].startswith("Social interaction")]
    assert (hong["cited_by"], hong["year"]) == (2, 2004)
    assert not any("only the first paper" in m["title"].lower() for m in graph["missing"])  # cited once: not a node


def test_a_work_only_one_paper_cites_is_not_a_node_and_new_papers_change_the_edges(lib, tmp_path):
    a = add(lib, tmp_path, "a.txt", paper("First study of household finance", [HONG, *FILLER]))
    assert lib.citation_graph()["missing"] == []
    b = add(lib, tmp_path, "b.txt", paper("Second study of household finance", [HONG, *FILLER]))
    graph = lib.citation_graph()
    assert [m["cited_by"] for m in graph["missing"]][:1] == [2]
    assert {n["doc_id"] for n in graph["nodes"] if n["kind"] == "paper"} == {a, b}


def test_a_paper_without_a_reference_list_is_isolated(lib, tmp_path):
    lone = add(lib, tmp_path, "c.txt", "Field notes\nNo list here, only prose about coral. " * 20)
    add(lib, tmp_path, "a.txt", paper("First study of household finance", [HONG, *FILLER]))
    graph = lib.citation_graph()
    assert lone in graph["isolated"]
    assert next(n for n in graph["nodes"] if n["id"] == f"doc:{lone}")["parsed"] is False


def test_references_are_stored_once_and_reread_when_the_file_is_added_again(lib, tmp_path):
    a = add(lib, tmp_path, "a.txt", paper("First study of household finance", [HONG, *FILLER]))
    lib.citation_graph()
    count = lib.conn.execute("SELECT COUNT(*) FROM doc_refs WHERE doc_id = ?", (a,)).fetchone()[0]
    assert count >= 8
    lib.citation_graph()
    assert lib.conn.execute("SELECT COUNT(*) FROM doc_refs WHERE doc_id = ?", (a,)).fetchone()[0] == count
    add(lib, tmp_path, "a.txt", paper("First study of household finance", FILLER[:5]))
    assert lib.conn.execute("SELECT refs_parsed FROM documents WHERE id = ?", (a,)).fetchone()[0] == 0
    lib.citation_graph()
    assert lib.conn.execute("SELECT COUNT(*) FROM doc_refs WHERE doc_id = ?", (a,)).fetchone()[0] < count


def topical(title: str, keywords: str, refs: list[str], body: str = "") -> str:
    return f"{title}\nSome Author 2020\n\nAbstract. {body}\nKeywords: {keywords}\n\n" + "Plain body text. " * 20 + "\n\nReferences\n" + "\n".join(refs) + "\n"


def test_searching_a_topic_shows_its_papers_their_links_and_shared_keywords(lib, tmp_path):
    a = add(lib, tmp_path, "a.txt", topical("Blockchain adoption in banks", "blockchain; banking; adoption", [HONG, *FILLER]))
    b = add(lib, tmp_path, "b.txt", topical("Smart contracts for lending", "blockchain; banking; lending", [HONG, *FILLER]))
    other = add(lib, tmp_path, "c.txt", topical("Coral reef bleaching", "coral; heatwave; reefs", [HONG, *FILLER]))
    graph = lib.citation_graph("blockchain")

    papers = {n["doc_id"]: n for n in graph["nodes"] if n["kind"] == "paper"}
    assert set(papers) == {a, b}  # the coral paper is not about it
    assert "keywords" in papers[a]["match"]["why"]
    (link,) = graph["keyword"]
    assert link["shared"] == ["banking", "blockchain"] and link["weight"] == 2
    assert any(c["weight"] >= 2 for c in graph["coupling"])  # they share references among themselves
    assert [m["cited_by"] for m in graph["missing"]][:1] == [2]  # counted among the matches only, not all three
    assert other not in papers


def test_a_topic_mentioned_in_the_body_counts_but_one_stray_mention_does_not(lib, tmp_path):
    deep = add(lib, tmp_path, "d.txt", topical("Payment systems", "payments; settlement; banks", FILLER, body=("Blockchain is discussed here. " + "Filler sentence about settlement. " * 40) * 5))
    once = add(lib, tmp_path, "e.txt", "Notes\nA single mention of blockchain. " + "Other words. " * 40)
    graph = lib.citation_graph("blockchain")
    ids = {n["doc_id"] for n in graph["nodes"] if n["kind"] == "paper"}
    assert deep in ids and once not in ids
    assert next(n for n in graph["nodes"] if n["doc_id"] == deep)["match"]["hits"] >= 1  # found through its text, whatever else named it


def test_an_unmatched_or_blank_search_is_harmless(lib, tmp_path):
    add(lib, tmp_path, "a.txt", topical("Blockchain adoption", "blockchain; banking; adoption", FILLER))
    assert lib.citation_graph("zzzqqq")["nodes"] == []
    assert lib.citation_graph('"')["nodes"] == []
    assert len(lib.citation_graph("")["nodes"]) >= 1


def test_the_graph_can_be_drawn_for_chosen_papers(lib, tmp_path):
    from fastapi.testclient import TestClient

    from app.main import create_app

    trust = add(lib, tmp_path, "t.txt", paper("Trusting the stock market and its many hidden risks", FILLER, year=2008))
    a = add(lib, tmp_path, "a.txt", paper("First study of household finance", [TRUST, HONG, *FILLER]))
    b = add(lib, tmp_path, "b.txt", paper("Second study of household finance", [TRUST, HONG, *FILLER]))
    client = TestClient(create_app(lib.settings, lib))

    graph = client.get("/graph", params={"ids": f"{a},{b},999"}).json()  # 999: no such paper, left out
    assert graph["doc_ids"] == sorted([a, b])
    assert {n["doc_id"] for n in graph["nodes"] if n["kind"] == "paper"} == {a, b}  # the paper they cite isn't chosen
    assert any(m["title"].startswith("Social interaction") for m in graph["missing"])  # what both cite still shows
    assert any({c["source"], c["target"]} == {f"doc:{a}", f"doc:{b}"} for c in graph["coupling"])

    whole = client.get("/graph").json()
    assert {n["doc_id"] for n in whole["nodes"] if n["kind"] == "paper"} == {trust, a, b}
    assert client.get("/graph", params={"ids": "a,b"}).status_code == 400
