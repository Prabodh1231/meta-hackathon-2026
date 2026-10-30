from tests.test_citegraph import FILLER, HONG, LITERACY, NoTags, ONLY_A, TRUST, add, lib, paper  # noqa: F401 (lib is a fixture)

HONG_DOI = HONG.replace("137-163.", "137-163. https://doi.org/10.1111/j.1540-6261.2004.00629.x")
REEF = "Hughes, T., Kerry, J., 2017. Global warming and recurrent mass bleaching of corals. Nature 543, 373-377."


def household(title, refs, year=2020):
    return paper(title, refs, year).replace("Abstract.", "Abstract. This paper is about household finance and investing.")


def test_works_are_ranked_by_how_many_papers_cite_them(lib, tmp_path):
    # each paper cites a different few filler works, so only Hong's is cited by all three
    trust = add(lib, tmp_path, "t.txt", paper("Trusting the stock market and its many hidden risks", FILLER[:4], year=2008))
    a = add(lib, tmp_path, "a.txt", household("First study of household finance", [TRUST, HONG, LITERACY, *FILLER[:3]]))
    b = add(lib, tmp_path, "b.txt", household("Second study of household finance", [TRUST, HONG_DOI, *FILLER[3:6]]))
    c = add(lib, tmp_path, "c.txt", household("Third study of household finance", [HONG, ONLY_A, *FILLER[6:]]))

    res = lib.missing_works()
    works = {w["title"]: w for w in res["works"]}
    top = res["works"][0]
    assert top["title"].startswith("Social interaction") and top["cited_by"] == 3
    assert sorted(x["id"] for x in top["citers"]) == sorted([a, b, c])
    assert top["doi"] == "10.1111/j.1540-6261.2004.00629.x" and top["ref"]["doc_id"] == b  # the entry with a DOI
    assert works["Financial literacy and stock market participation in households"]["cited_by"] == 1  # cited once still counts
    assert not any(w["title"].startswith("Trusting") for w in res["works"])  # already in the library
    assert res["papers"] == 4 and res["with_refs"] == 4
    assert all(w["cited_by"] >= v["cited_by"] for w, v in zip(res["works"], res["works"][1:]))

    # the entry a work is fetched by is a real entry of the citing paper's list
    cited = lib.cited_works(top["ref"]["doc_id"])["references"][top["ref"]["idx"]]
    assert cited["title"].startswith("Social interaction") and cited["in_library"] is None
    filler = works["Filler reference number 0 on assorted unrelated subjects"]
    assert sorted(x["id"] for x in filler["citers"]) == sorted([trust, a])


def test_a_topic_narrows_it_to_the_papers_about_that_topic(lib, tmp_path):
    add(lib, tmp_path, "a.txt", household("First study of household finance", [HONG, LITERACY, *FILLER]))
    add(lib, tmp_path, "r.txt", paper("Coral reefs under thermal stress", [REEF, *FILLER]))

    finance = lib.missing_works("household finance")
    assert finance["papers"] == 1
    titles = [w["title"] for w in finance["works"]]
    assert any(t.startswith("Social interaction") for t in titles) and not any("bleaching" in t for t in titles)

    reefs = lib.missing_works("coral reefs")
    assert [w["title"] for w in reefs["works"] if "bleaching" in w["title"]] == ["Global warming and recurrent mass bleaching of corals"]
    assert lib.missing_works("quantum chromodynamics") == {"query": "quantum chromodynamics", "papers": 0, "with_refs": 0,
                                                          "total": 0, "cited_twice": 0, "works": []}
