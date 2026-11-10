"""The local cache of cited works: works_by_id asks OpenAlex only for what it doesn't hold."""
from datetime import datetime, timedelta, timezone

import httpx

from app import openaccess
from app.openaccess import CITED_BY_MAX_AGE_DAYS, IDS_PER_REQUEST, OpenAccess, as_reference


def work(wid: str, cited: int = 5) -> dict:
    return {"id": f"https://openalex.org/{wid}", "doi": f"https://doi.org/10.1/{wid.lower()}",
            "title": f"Paper {wid}", "publication_year": 2001,
            "authorships": [{"author": {"display_name": "Ann Smith"}}],
            "primary_location": {"source": {"display_name": "J. Tests"}}, "cited_by_count": cited}


def server(seen: list, cited: int = 5):
    def handler(req: httpx.Request) -> httpx.Response:
        ids = req.url.params["filter"].removeprefix("openalex:").split("|")
        seen.append(ids)
        return httpx.Response(200, json={"results": [work(i, cited) for i in ids]})
    return httpx.MockTransport(handler)


def client(tmp_path, seen, cited=5) -> OpenAccess:
    return OpenAccess(transport=server(seen, cited), retry_wait=0, cache_path=tmp_path / openaccess.CACHE_FILE)


IDS = [f"W{n}" for n in range(1, 121)]


def test_batches_of_50_then_nothing_once_cached(tmp_path):
    seen: list = []
    oa = client(tmp_path, seen)
    first = oa.works_by_id(IDS)
    assert [len(b) for b in seen] == [IDS_PER_REQUEST, IDS_PER_REQUEST, 20]
    seen.clear()
    again = oa.works_by_id(IDS)
    assert seen == []
    assert set(again) == set(IDS)
    assert as_reference(again["W7"]) == as_reference(first["W7"])  # same shape as a fresh reply


def test_a_partial_hit_asks_only_for_the_misses(tmp_path):
    seen: list = []
    oa = client(tmp_path, seen)
    oa.works_by_id(IDS[:30])
    seen.clear()
    got = oa.works_by_id(IDS[:40])
    assert seen == [IDS[30:40]]
    assert set(got) == set(IDS[:40])


def test_a_stale_citation_count_is_fetched_again(tmp_path):
    seen: list = []
    oa = client(tmp_path, seen)
    old = datetime.now(timezone.utc) - timedelta(days=CITED_BY_MAX_AGE_DAYS + 1)
    oa.cache.put([work("W1", cited=1)], now=old)
    oa.cache.put([work("W2", cited=1)])
    got = oa.works_by_id(["W1", "W2"])
    assert seen == [["W1"]]
    assert got["W1"]["cited_by_count"] == 5 and got["W2"]["cited_by_count"] == 1


def test_the_cache_survives_a_restart(tmp_path):
    seen: list = []
    client(tmp_path, seen).works_by_id(IDS[:10])
    seen.clear()
    got = client(tmp_path, seen).works_by_id(IDS[:10])
    assert seen == [] and len(got) == 10


def test_works_by_doi_fills_the_cache_with_abstracts(tmp_path):
    def handler(req):
        w = work("W9") | {"abstract_inverted_index": {"Hello": [0], "world": [1]}}
        return httpx.Response(200, json={"results": [w]})
    oa = OpenAccess(transport=httpx.MockTransport(handler), retry_wait=0, cache_path=tmp_path / "c.db")
    assert "10.1/w9" in oa.works_by_doi(["10.1/w9"])
    assert oa.cache.abstract("W9") == "Hello world"
    assert "W9" in oa.cache.get(["W9"])


def test_no_cache_without_a_path(tmp_path):
    seen: list = []
    oa = OpenAccess(transport=server(seen), retry_wait=0)
    oa.works_by_id(IDS[:3]); oa.works_by_id(IDS[:3])
    assert len(seen) == 2
