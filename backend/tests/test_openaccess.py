import fitz
import httpx
import pytest

from app.library import Library
from app.openaccess import OpenAccess, file_name, same_work, searchable
from app.refparse import Reference
from app.settings import Settings
from tests.test_citegraph import FILLER, HONG, NoTags, TRUST, add, paper

PDF = b"%PDF-1.4\n" + b"0" * 2000
HONG_TITLE = "Social interaction and stock-market participation across towns"
HONG_DOI = "10.1111/j.1540-6261.2004.00629.x"


def hong(**kw) -> Reference:
    return Reference(raw=HONG, year=2004, title=HONG_TITLE, first_author="Hong", **kw)


def openalex_work(title=HONG_TITLE, year=2004, pdf="https://repo.example/hong.pdf", is_oa=True):
    best = {"pdf_url": pdf, "landing_page_url": "https://repo.example/hong"} if is_oa else None
    return {"doi": f"https://doi.org/{HONG_DOI}", "title": title, "publication_year": year,
            "open_access": {"is_oa": is_oa, "oa_url": pdf if is_oa else None}, "best_oa_location": best,
            "locations": [{"is_oa": is_oa, "pdf_url": pdf}]}


def client(routes: dict, seen: list | None = None) -> OpenAccess:
    """routes: 'host/path' -> a Response, or a callable taking the request."""
    def handler(req: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(req)
        key = req.url.host + req.url.path
        if key not in routes:
            return httpx.Response(404)
        r = routes[key]
        return r(req) if callable(r) else r
    return OpenAccess("me@example.org", transport=httpx.MockTransport(handler), retry_wait=0)


def test_a_reference_needs_a_doi_or_a_real_title_to_search_for():
    assert searchable(Reference(raw="x", doi="10.1/abc"))
    assert searchable(hong())
    assert not searchable(Reference(raw="x", title="Introduction"))


def test_a_search_hit_must_have_the_same_title_and_year():
    assert same_work(hong(), "Social Interaction and Stock-Market Participation Across Towns", 2004)
    assert same_work(hong(), HONG_TITLE + ": evidence from mutual funds", 2005)  # a subtitle the entry left out
    assert not same_work(hong(), HONG_TITLE, 2015)  # same title, another year: a different work
    assert not same_work(hong(), "Social interaction and bond-market participation in villages", 2004)


def test_file_names_are_safe_and_readable():
    assert file_name(hong(), None) == "Hong 2004 - Social interaction and stock-market participation across towns.pdf"
    assert "/" not in file_name(Reference(raw="", title="A/B: tests? <yes>", year=2020), None)


def test_a_doi_is_looked_up_directly_and_the_pdf_downloaded(tmp_path):
    seen = []
    oa = client({
        f"api.openalex.org/works/doi:{HONG_DOI}": httpx.Response(200, json=openalex_work()),
        "repo.example/hong.pdf": httpx.Response(200, content=PDF),
    }, seen)
    got = oa.fetch(hong(doi=HONG_DOI), tmp_path)
    assert got.status == "downloaded" and got.url == "https://repo.example/hong.pdf"
    assert got.path.read_bytes() == PDF and got.path.parent == tmp_path
    assert seen[0].url.params["mailto"] == "me@example.org"
    assert not list(tmp_path.glob("*.part"))


def test_a_landing_page_is_skipped_for_another_index_s_pdf(tmp_path):
    oa = client({
        "api.openalex.org/works": httpx.Response(200, json={"results": [openalex_work()]}),
        "repo.example/hong.pdf": httpx.Response(200, html="<html>Sign in to download</html>"),
        "api.semanticscholar.org/graph/v1/paper/search/match": httpx.Response(200, json={"data": [
            {"title": HONG_TITLE, "year": 2004, "externalIds": {"ArXiv": "0401.0001"}, "openAccessPdf": None}]}),
        "arxiv.org/pdf/0401.0001": httpx.Response(200, content=PDF),
    })
    got = oa.fetch(hong(), tmp_path)
    assert (got.status, got.url, got.work.source) == ("downloaded", "https://arxiv.org/pdf/0401.0001", "Semantic Scholar")
    assert [p.name for p in tmp_path.iterdir()] == [got.path.name]  # the HTML left nothing behind


def test_a_free_page_without_a_pdf_is_offered_as_a_link(tmp_path):
    oa = client({
        "api.openalex.org/works": httpx.Response(200, json={"results": [openalex_work()]}),
        "repo.example/hong.pdf": httpx.Response(403),
    })
    got = oa.fetch(hong(), tmp_path)
    assert (got.status, got.url) == ("link", "https://repo.example/hong")


def test_a_paywalled_work_is_reported_not_downloaded(tmp_path):
    oa = client({"api.openalex.org/works": httpx.Response(200, json={"results": [openalex_work(is_oa=False)]})})
    got = oa.fetch(hong(), tmp_path)
    assert got.status == "no_free_copy" and got.path is None
    assert list(tmp_path.iterdir()) == []


def test_a_look_alike_search_hit_is_not_downloaded(tmp_path):
    other = openalex_work(title="Social interaction and stock-market participation in rural China", year=2019)
    oa = client({
        "api.openalex.org/works": httpx.Response(200, json={"results": [other]}),
        "repo.example/hong.pdf": httpx.Response(200, content=PDF),
    })
    assert oa.fetch(hong(), tmp_path).status == "not_found"
    assert list(tmp_path.iterdir()) == []


def test_rate_limits_are_retried_and_outages_reported(tmp_path):
    calls = iter([httpx.Response(429), httpx.Response(200, json=openalex_work())])
    oa = client({
        f"api.openalex.org/works/doi:{HONG_DOI}": lambda req: next(calls),
        "repo.example/hong.pdf": httpx.Response(200, content=PDF),
    })
    assert oa.fetch(hong(doi=HONG_DOI), tmp_path).status == "downloaded"

    def down(req):
        raise httpx.ConnectError("no network", request=req)
    oa = OpenAccess(transport=httpx.MockTransport(down))
    got = oa.fetch(hong(), tmp_path)
    assert got.status == "failed" and "Couldn't reach" in got.reason


def make_pdf(title: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), title, fontsize=14)
    page.insert_textbox(fitz.Rect(72, 130, 520, 700), "We study how neighbours shape investing. " * 40, fontsize=10)
    doc.set_metadata({"title": "Microsoft Word - hong_final_v3.docx"})  # as many PDFs ship
    return doc.tobytes()


@pytest.fixture
def lib(tmp_path):
    oa = client({
        "api.openalex.org/works": httpx.Response(200, json={"results": [openalex_work()]}),
        "repo.example/hong.pdf": httpx.Response(200, content=make_pdf(HONG_TITLE)),
    })
    return Library(Settings(data_dir=tmp_path / "data"), provider=NoTags(), open_access=oa)


def test_cited_papers_are_listed_downloaded_into_the_library_and_then_found_there(lib, tmp_path):
    trust = add(lib, tmp_path, "t.txt", paper("Trusting the stock market and its many hidden risks", FILLER, year=2008))
    citing = add(lib, tmp_path, "a.txt", paper("A study of household finance", [TRUST, HONG, *FILLER]))

    refs = lib.cited_works(citing)["references"]
    by_title = {r["title"]: r for r in refs}
    assert by_title["Trusting the stock market and its many hidden risks"]["in_library"] == trust
    hong_ref = by_title[HONG_TITLE]
    assert hong_ref["in_library"] is None and hong_ref["searchable"]

    assert lib.fetch_cited_work(citing, by_title["Trusting the stock market and its many hidden risks"]["idx"]) == {
        "status": "in_library", "doc_id": trust}

    got = lib.fetch_cited_work(citing, hong_ref["idx"])
    assert got["status"] == "downloaded" and got["found_in"] == "OpenAlex"
    doc = got["document"]
    assert doc["title"] == HONG_TITLE and doc["doi"] == HONG_DOI and doc["url"] == "https://repo.example/hong.pdf"
    assert doc["source"].startswith(str(tmp_path / "data" / "papers"))

    assert {r["idx"]: r["in_library"] for r in lib.cited_works(citing)["references"]}[hong_ref["idx"]] == doc["id"]
    assert lib.fetch_cited_work(citing, hong_ref["idx"]) == {"status": "in_library", "doc_id": doc["id"]}
    assert len(list((tmp_path / "data" / "papers").iterdir())) == 1  # fetched once


def test_an_unknown_reference_is_a_404(lib, tmp_path):
    citing = add(lib, tmp_path, "a.txt", paper("A study of household finance", [HONG, *FILLER]))
    with pytest.raises(LookupError):
        lib.fetch_cited_work(citing, 999)
