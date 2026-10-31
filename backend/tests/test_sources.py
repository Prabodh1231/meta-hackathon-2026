"""Crossref (DOIs and dates for references without one) and CORE (repository full texts, with the
user's key) alongside OpenAlex and Semantic Scholar."""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.openaccess import Dated, OpenAccess
from app.providers import MockProvider
from app.settings import Settings
from tests.test_dupfiles import prose
from tests.test_openaccess import HONG_DOI, HONG_TITLE, PDF, hong, openalex_work

KEY = "core-key-0123456789abcd"


def crossref_hit(title=HONG_TITLE, year=2004, month=6, doi=HONG_DOI):
    return {"DOI": doi, "title": [title], "issued": {"date-parts": [[year, month]]}}


def routed(routes: dict, seen: list | None = None, core_key: str = "") -> OpenAccess:
    """routes: 'host/path' -> a Response, or a callable taking the request."""
    def handler(req: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(req)
        r = routes.get(req.url.host + req.url.path)
        if r is None:
            return httpx.Response(404)
        return r(req) if callable(r) else r
    return OpenAccess("me@example.org", transport=httpx.MockTransport(handler), retry_wait=0, core_key=core_key)


def hosts(seen):
    return [r.url.host for r in seen]


def test_crossref_finds_the_doi_so_openalex_is_asked_by_doi(tmp_path):
    seen = []
    oa = routed({
        "api.crossref.org/works": httpx.Response(200, json={"message": {"items": [crossref_hit()]}}),
        f"api.openalex.org/works/doi:{HONG_DOI}": httpx.Response(200, json=openalex_work()),
        "repo.example/hong.pdf": httpx.Response(200, content=PDF),
    }, seen)
    got = oa.fetch(hong(), tmp_path)
    assert got.status == "downloaded"
    assert hosts(seen)[:2] == ["api.crossref.org", "api.openalex.org"]
    assert seen[0].url.params["mailto"] == "me@example.org"
    assert "Hong" in seen[0].url.params["query.bibliographic"]


def test_a_crossref_look_alike_is_not_taken_as_the_doi(tmp_path):
    seen = []
    other = crossref_hit(title="Social interaction and stock-market participation in rural China", year=2019, doi="10.9/other")
    oa = routed({
        "api.crossref.org/works": httpx.Response(200, json={"message": {"items": [other]}}),
        "api.openalex.org/works": httpx.Response(200, json={"results": [openalex_work()]}),
        "repo.example/hong.pdf": httpx.Response(200, content=PDF),
    }, seen)
    assert oa.fetch(hong(), tmp_path).status == "downloaded"
    assert not any("10.9/other" in str(r.url) for r in seen)  # searched by title instead


def test_core_is_only_asked_with_a_key(tmp_path):
    seen = []
    assert routed({}, seen).fetch(hong(doi=HONG_DOI), tmp_path).reason == "Not found in OpenAlex or Semantic Scholar"
    assert "api.core.ac.uk" not in hosts(seen)


def test_core_finds_a_repository_copy_the_indexes_lack(tmp_path):
    seen = []
    work = {"id": 42, "title": HONG_TITLE, "yearPublished": 2004, "doi": HONG_DOI,
            "downloadUrl": "https://core.ac.uk/download/42.pdf", "publishedDate": "2004-06-01T00:00:00"}
    oa = routed({
        "api.core.ac.uk/v3/search/works": httpx.Response(200, json={"results": [work]}),
        "core.ac.uk/download/42.pdf": httpx.Response(200, content=PDF),
    }, seen, core_key=KEY)
    got = oa.fetch(hong(doi=HONG_DOI), tmp_path)
    assert (got.status, got.url, got.work.source) == ("downloaded", "https://core.ac.uk/download/42.pdf", "CORE")
    [ask] = [r for r in seen if r.url.host == "api.core.ac.uk"]
    assert ask.headers["Authorization"] == f"Bearer {KEY}"
    assert ask.url.params["q"] == f'doi:"{HONG_DOI}"'


def test_a_core_look_alike_is_skipped_and_the_reason_names_core(tmp_path):
    other = {"title": "Social interaction and stock-market participation in rural China", "yearPublished": 2019,
             "downloadUrl": "https://core.ac.uk/download/7.pdf"}
    oa = routed({"api.core.ac.uk/v3/search/works": httpx.Response(200, json={"results": [other]}),
                 "core.ac.uk/download/7.pdf": httpx.Response(200, content=PDF)}, core_key=KEY)
    got = oa.fetch(hong(), tmp_path)
    assert got.status == "not_found" and got.reason == "Not found in OpenAlex, Semantic Scholar or CORE"
    assert list(tmp_path.iterdir()) == []


def test_publication_date_brings_the_doi_crossref_found():
    oa = routed({
        "api.crossref.org/works": httpx.Response(200, json={"message": {"items": [crossref_hit()]}}),
        f"api.openalex.org/works/doi:{HONG_DOI}": httpx.Response(200, json={**openalex_work(), "publication_date": "2004-06-14"}),
    })
    assert oa.publication_date("", HONG_TITLE, 2004) == Dated("2004-06-14", HONG_DOI)


def test_crossref_gives_the_date_when_openalex_has_none():
    oa = routed({f"api.crossref.org/works/{HONG_DOI}": httpx.Response(200, json={"message": crossref_hit(month=9)})})
    assert oa.publication_date(HONG_DOI, HONG_TITLE, 2004) == Dated("2004-09")


def test_dates_lookup_fills_in_a_missing_doi(tmp_path):
    class Finder:
        def set_contact(self, _):
            pass

        def publication_date(self, doi, title, year):
            return Dated("2004-06-14", HONG_DOI) if not doi else None

    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), embedder=HashEmbedder(), open_access=Finder())
    client = TestClient(create_app(lib.settings, lib))
    f = tmp_path / "hong.md"
    f.write_text(prose(30), encoding="utf-8")
    [res] = client.post("/ingest/path", json={"path": str(f)}).json()["results"]
    doc_id = res["document"]["id"]
    with lib.conn:
        lib.conn.execute("UPDATE documents SET doi = '', year = 2004 WHERE id = ?", (doc_id,))
    assert client.post("/library/publication-dates").json() == {"checked": 1, "found": 1, "dois": 1, "failed": 0}
    doc = client.get(f"/documents/{doc_id}").json()
    assert (doc["doi"], doc["published"]) == (HONG_DOI, "2004-06-14")


@pytest.fixture
def lib(tmp_path):
    def core(req: httpx.Request) -> httpx.Response:
        ok = req.headers.get("Authorization") == f"Bearer {KEY}"
        return httpx.Response(200, json={"results": []}) if ok else httpx.Response(401)
    oa = OpenAccess(transport=httpx.MockTransport(core), retry_wait=0)
    return Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), embedder=HashEmbedder(), open_access=oa)


def test_the_core_key_is_checked_saved_and_never_sent_back(lib):
    client = TestClient(create_app(lib.settings, lib))
    assert client.get("/settings/sources").json() == {"has_core_key": False, "core_key_hint": ""}

    r = client.put("/settings/sources", json={"core_api_key": "wrong-key-0000000000"})
    assert r.status_code == 400 and "didn't accept" in r.json()["detail"]
    assert not lib.open_access.core_key

    r = client.put("/settings/sources", json={"core_api_key": f"  {KEY} "})
    assert r.json() == {"has_core_key": True, "core_key_hint": KEY[-4:]}
    assert lib.open_access.core_key == KEY
    assert f"CORE_API_KEY={KEY}" in (lib.settings.data_dir / ".env").read_text()
    assert KEY not in client.get("/settings/sources").text

    assert client.put("/settings/sources", json={"core_api_key": ""}).json()["has_core_key"] is False
    assert lib.open_access.core_key == ""
