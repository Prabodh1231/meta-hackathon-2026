"""One OpenAlex lookup per paper, shared by fetch() and record(); one batch helper for works by id and by DOI."""
import httpx

from app.openaccess import LIST_FIELDS, LOOKUP_FIELDS, OA_FIELDS, RECORD_FIELDS, OpenAccess, listed_work
from app.refparse import Reference

PAPER = {
    "id": "https://openalex.org/W42", "doi": "https://doi.org/10.1/paper", "title": "Mobile money and household savings in Kenya",
    "publication_year": 2019, "publication_date": "2019-06-01",
    "authorships": [{"author": {"display_name": "Ada Okafor"}}],
    "primary_location": {"source": {"display_name": "J. Dev. Econ."}},
    "biblio": {"volume": "12", "issue": "3", "first_page": "1", "last_page": "9"},
    "abstract_inverted_index": {"Savings": [0], "rose": [1]}, "cited_by_count": 7, "referenced_works": [],
    "open_access": {"is_oa": True, "oa_url": "https://repo.example/landing"},
    "best_oa_location": {"pdf_url": None, "landing_page_url": "https://repo.example/landing"}, "locations": [],
}


def indexes(calls: list):
    """OpenAlex answers with PAPER; Crossref, Semantic Scholar and the repository have nothing."""
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "api.openalex.org":
            calls.append(req)
            if req.url.path.startswith("/works/doi:"):
                return httpx.Response(200, json=PAPER)
            return httpx.Response(200, json={"results": [PAPER]})
        return httpx.Response(404)
    return httpx.MockTransport(handler)


def test_the_lookup_asks_for_both_field_lists():
    assert set(LOOKUP_FIELDS.split(",")) == set(RECORD_FIELDS.split(",")) | set(OA_FIELDS.split(","))


def test_a_paper_fetched_then_recorded_costs_one_request(tmp_path):
    calls: list = []
    oa = OpenAccess(transport=indexes(calls), retry_wait=0)
    got = oa.fetch(Reference(raw="x", doi="10.1/paper", title=PAPER["title"], year=2019), tmp_path)
    assert got.status == "link" and got.url == "https://repo.example/landing"
    assert got.work.title == PAPER["title"] and got.work.published == "2019-06-01" and got.work.source == "OpenAlex"
    rec = oa.record("10.1/paper", PAPER["title"], 2019)
    assert len(calls) == 1
    assert calls[0].url.params["select"] == LOOKUP_FIELDS
    assert (rec.title, rec.openalex_id, rec.cited_by_count, rec.abstract, rec.pages, rec.volume) == \
        (PAPER["title"], "W42", 7, "Savings rose", "1–9", "12")


def test_found_by_title_then_by_its_doi_is_still_one_request(tmp_path):
    calls: list = []
    oa = OpenAccess(transport=indexes(calls), retry_wait=0)
    got = oa.fetch(Reference(raw="x", title=PAPER["title"], year=2019), tmp_path)  # no DOI: title search
    assert got.status == "link" and got.work.doi == "10.1/paper"
    assert calls[0].url.path == "/works" and calls[0].url.params["filter"] == "publication_year:2018-2020"
    oa.record("10.1/paper", PAPER["title"], 2019)  # the imported paper now carries the DOI
    assert len(calls) == 1


def test_a_title_search_hit_with_another_title_is_not_the_work(tmp_path):
    calls: list = []
    oa = OpenAccess(transport=indexes(calls), retry_wait=0)
    got = oa.fetch(Reference(raw="x", title="Coral reef bleaching in the western Pacific", year=2019), tmp_path)
    assert got.status == "not_found"


def test_a_failed_lookup_is_not_remembered(tmp_path):
    state = {"down": True, "calls": 0}

    def handler(req):
        if req.url.host != "api.openalex.org":
            return httpx.Response(404)
        state["calls"] += 1
        return httpx.Response(500) if state["down"] else httpx.Response(200, json=PAPER)
    oa = OpenAccess(transport=httpx.MockTransport(handler), retry_wait=0)
    ref = Reference(raw="x", doi="10.1/paper", title=PAPER["title"], year=2019)
    assert oa.fetch(ref, tmp_path).status == "not_found"  # Semantic Scholar answered
    state["down"] = False
    assert oa.fetch(ref, tmp_path).status == "link"


def batch_server(seen: list):
    def handler(req):
        key, values = req.url.params["filter"].split(":", 1)
        seen.append((key, req.url.params["select"], values.split("|")))
        n = lambda v: v.removeprefix("W") if key == "openalex" else v.rsplit("/w", 1)[-1]
        return httpx.Response(200, json={"results": [
            {"id": f"https://openalex.org/W{n(v)}", "doi": f"https://doi.org/10.1/w{n(v)}", "title": f"T{n(v)}",
             "publication_year": 2000, "cited_by_count": 1, "abstract_inverted_index": {"A": [0]}} for v in values.split("|")]})
    return httpx.MockTransport(handler)


def test_works_by_id_and_by_doi_keep_their_shapes(tmp_path):
    seen: list = []
    oa = OpenAccess(transport=batch_server(seen), retry_wait=0, cache_path=tmp_path / "c.db")
    ids = [f"W{n}" for n in range(60)]
    by_id = oa.works_by_id(ids)
    assert list(by_id) == ids and by_id["W3"]["id"] == "https://openalex.org/W3"  # raw OpenAlex works
    assert [(k, s, len(v)) for k, s, v in seen] == [("openalex", LIST_FIELDS, 50), ("openalex", LIST_FIELDS, 10)]
    seen.clear()
    dois = [f"10.1/W{n}" for n in range(55)] + ["https://doi.org/10.1/w0"]
    by_doi = oa.works_by_doi(dois)
    assert [(k, len(v)) for k, _, v in seen] == [("doi", 50), ("doi", 5)]
    assert seen[0][1] == LIST_FIELDS + ",abstract_inverted_index"
    assert by_doi["10.1/w3"] == listed_work(by_id["W3"]) | {"abstract": "A"}  # listed works, keyed by DOI


def test_works_by_id_with_other_fields_skips_the_cache(tmp_path):
    seen: list = []
    oa = OpenAccess(transport=batch_server(seen), retry_wait=0, cache_path=tmp_path / "c.db")
    oa.works_by_id(["W1"], select="id,title")
    oa.works_by_id(["W1"], select="id,title")
    assert len(seen) == 2 and oa.cache.get(["W1"]) == {}
