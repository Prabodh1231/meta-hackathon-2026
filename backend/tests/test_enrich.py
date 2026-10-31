"""What the scholarly indexes know about library papers: the publisher's metadata, abstracts,
reference lists merged into the citation network, citation counts and the papers citing them."""
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.openaccess import Fetched, OpenAccess, Record, Work
from app.providers import MockProvider
from app.references import format_references
from app.refparse import Reference
from app.settings import Settings
from tests.test_dupfiles import prose

TITLE = "Mobile money and household savings in rural Kenya"
DOI = "10.1/mobile"


class FakeIndex:
    """Stands in for OpenAccess: records by DOI or title, citing works, downloads."""
    def __init__(self, records: dict | None = None):
        self.records = records or {}  # DOI or title -> Record, or an exception to raise
        self.asked: list[str] = []
        self.citing_args: list[tuple] = []
        self.fetched: list[Reference] = []
        self.download: Path | None = None

    def set_contact(self, _):
        pass

    def record(self, doi, title, year):
        key = doi or title
        self.asked.append(key)
        got = self.records.get(key)
        if isinstance(got, Exception):
            raise got
        return got

    def citing(self, openalex_id, sort="cited", limit=25):
        self.citing_args.append((openalex_id, sort))
        return 2, [
            {"openalex_id": "W9", "doi": "10.1/later", "title": "Later work on savings groups and mobile money", "authors": ["Bea Moyo"],
             "year": 2022, "venue": "J Dev Econ", "cited_by_count": 40, "abstract": "We revisit."},
            {"openalex_id": "W8", "doi": "10.1/inlib", "title": "x", "authors": [], "year": 2021, "venue": "",
             "cited_by_count": 3, "abstract": ""},
        ]

    def works_by_doi(self, dois):
        return {d: {"cited_by_count": 7, "abstract": "An abstract."} for d in dois}

    def fetch(self, ref, folder):
        self.fetched.append(ref)
        if not self.download:
            return Fetched("no_free_copy", reason="Paywalled")
        return Fetched("downloaded", self.download, "https://repo.example/x.pdf", Work(ref.title, ref.year, ref.doi, "OpenAlex"))


def record(**kw) -> Record:
    base = dict(title=TITLE, authors=["Ada Okafor", "Raj Raman"], year=2019, published="2019-06-14", doi=DOI,
                venue="Journal of Development Economics", volume="140", issue="2", pages="341–355", publisher="Elsevier",
                abstract="We study mobile money.", openalex_id="W1", cited_by_count=812,
                references=[Reference(raw="Jack W. (2014). Risk sharing and transactions costs. AER", year=2014,
                                      doi="10.1/jack", title="Risk sharing and transactions costs", first_author="Jack")])
    return Record(**{**base, **kw})


@pytest.fixture
def index():
    return FakeIndex()


@pytest.fixture
def lib(tmp_path, index):
    return Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), embedder=HashEmbedder(), open_access=index)


@pytest.fixture
def client(lib):
    return TestClient(create_app(lib.settings, lib))


def add(client, lib, tmp_path, name, title=TITLE, doi="", year=2019, seed=1) -> int:
    f = tmp_path / f"{name}.md"
    f.write_text(f"{title}\nAda Okafor, Raj Raman\n\n" + prose(seed), encoding="utf-8")
    [res] = client.post("/ingest/path", json={"path": str(f)}).json()["results"]
    assert res["ok"], res
    with lib.conn:
        lib.conn.execute("UPDATE documents SET doi = ?, year = ?, authors = '[\"A. Okafor\"]', venue = 'J Dev' WHERE id = ?",
                         (doi, year, res["document"]["id"]))
    return res["document"]["id"]


def doc(client, doc_id):
    return client.get(f"/documents/{doc_id}").json()


# ---------- the index client ----------

def routed(routes: dict, seen: list | None = None) -> OpenAccess:
    def handler(req: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(req)
        r = routes.get(req.url.host + req.url.path)
        if r is None:
            return httpx.Response(404)
        return r(req) if callable(r) else r
    return OpenAccess("me@example.org", transport=httpx.MockTransport(handler), retry_wait=0)


OPENALEX_RECORD = {
    "id": "https://openalex.org/W1", "doi": f"https://doi.org/{DOI}", "title": TITLE, "publication_year": 2019,
    "publication_date": "2019-06-14", "cited_by_count": 812,
    "authorships": [{"author": {"display_name": "Ada Okafor"}}, {"author": {"display_name": "Raj Raman"}}],
    "primary_location": {"source": {"display_name": "Journal of Development Economics"}},
    "biblio": {"volume": "140", "issue": "2", "first_page": "341", "last_page": "355"},
    "abstract_inverted_index": {"We": [0], "study": [1], "mobile": [2], "money.": [3]},
    "referenced_works": ["https://openalex.org/W7", "https://openalex.org/W5"],
}
CITED = [
    {"id": "https://openalex.org/W5", "doi": "https://doi.org/10.1/suri", "title": "The long-run poverty impacts of mobile money",
     "publication_year": 2016, "authorships": [{"author": {"display_name": "Tavneet Suri"}}], "primary_location": None},
    {"id": "https://openalex.org/W7", "doi": "https://doi.org/10.1/jack", "title": "Risk sharing and transactions costs",
     "publication_year": 2014, "authorships": [{"author": {"display_name": "William Jack"}}],
     "primary_location": {"source": {"display_name": "American Economic Review"}}},
]


def test_one_lookup_brings_metadata_abstract_references_and_citations():
    seen = []
    oa = routed({
        f"api.openalex.org/works/doi:{DOI}": httpx.Response(200, json=OPENALEX_RECORD),
        "api.openalex.org/works": httpx.Response(200, json={"results": CITED}),
        f"api.crossref.org/works/{DOI}": httpx.Response(200, json={"message": {
            "publisher": "Elsevier BV", "container-title": ["Journal of Development Economics"],
            "author": [{"given": "Ada", "family": "Okafor"}, {"given": "Raj", "family": "Raman"}]}}),
    }, seen)
    rec = oa.record(DOI, TITLE, 2019)
    assert (rec.title, rec.authors, rec.year, rec.published) == (TITLE, ["Ada Okafor", "Raj Raman"], 2019, "2019-06-14")
    assert (rec.venue, rec.volume, rec.issue, rec.pages, rec.publisher) == (
        "Journal of Development Economics", "140", "2", "341–355", "Elsevier BV")
    assert (rec.abstract, rec.openalex_id, rec.cited_by_count, rec.doi_found) == ("We study mobile money.", "W1", 812, False)
    # The reference list in the paper's own order, each entry with its DOI.
    assert [(r.doi, r.first_author, r.year) for r in rec.references] == [("10.1/jack", "Jack", 2014), ("10.1/suri", "Suri", 2016)]
    [batch] = [r for r in seen if r.url.path == "/works"]
    assert batch.url.params["filter"] == "openalex:W7|W5"
    assert all(r.url.params.get("mailto") == "me@example.org" for r in seen if "openalex" in r.url.host)


def test_the_abstract_falls_back_to_crossref_then_semantic_scholar():
    no_abstract = {**OPENALEX_RECORD, "abstract_inverted_index": None, "referenced_works": []}
    oa = routed({
        f"api.openalex.org/works/doi:{DOI}": httpx.Response(200, json=no_abstract),
        f"api.crossref.org/works/{DOI}": httpx.Response(200, json={"message": {
            "abstract": "<jats:p>Abstract: We study <jats:italic>mobile</jats:italic> money.</jats:p>"}}),
    })
    assert oa.record(DOI, TITLE, 2019).abstract == "We study mobile money."
    oa = routed({
        f"api.openalex.org/works/doi:{DOI}": httpx.Response(200, json=no_abstract),
        f"api.semanticscholar.org/graph/v1/paper/DOI:{DOI}": httpx.Response(200, json={"abstract": "From S2."}),
    })
    assert oa.record(DOI, TITLE, 2019).abstract == "From S2."


def test_a_paper_without_a_doi_gets_crossrefs():
    oa = routed({
        "api.crossref.org/works": httpx.Response(200, json={"message": {"items": [
            {"DOI": DOI, "title": [TITLE], "issued": {"date-parts": [[2019, 6]]}}]}}),
        f"api.openalex.org/works/doi:{DOI}": httpx.Response(200, json={**OPENALEX_RECORD, "referenced_works": []}),
    })
    rec = oa.record("", TITLE, 2019)
    assert (rec.doi, rec.doi_found) == (DOI, True)


def test_unknown_papers_and_outages():
    assert routed({}).record(DOI, TITLE, 2019) is None
    with pytest.raises(httpx.HTTPError):
        OpenAccess().record(DOI, TITLE, 2019)  # offline in tests: the caller tries again later


def test_citing_works_and_counts_by_doi():
    seen = []
    oa = routed({"api.openalex.org/works": httpx.Response(200, json={"meta": {"count": 812}, "results": CITED})}, seen)
    total, works = oa.citing("W1", "recent")
    assert total == 812 and works[0]["title"] == CITED[0]["title"] and works[1]["venue"] == "American Economic Review"
    assert seen[0].url.params["filter"] == "cites:W1" and seen[0].url.params["sort"] == "publication_date:desc"
    info = oa.works_by_doi(["https://doi.org/10.1/SURI", "10.1/jack"])
    assert set(info) == {"10.1/suri", "10.1/jack"}
    assert seen[1].url.params["filter"] == "doi:10.1/suri|10.1/jack"


# ---------- applying it to the library ----------

def test_a_lookup_fills_in_the_publishers_metadata(client, lib, index, tmp_path):
    doc_id = add(client, lib, tmp_path, "okafor", doi=DOI)
    index.records[DOI] = record()
    assert client.post("/library/enrich", json={}).json() == {
        "checked": 1, "found": 1, "dates": 1, "dois": 0, "mismatched": 0, "failed": 0}
    d = doc(client, doc_id)
    assert d["authors"] == ["Ada Okafor", "Raj Raman"] and d["venue"] == "Journal of Development Economics"
    assert (d["volume"], d["issue"], d["page_range"], d["publisher"]) == ("140", "2", "341–355", "Elsevier")
    assert (d["abstract"], d["cited_by_count"], d["openalex_id"], d["enriched"]) == ("We study mobile money.", 812, "W1", "found")
    assert d["published"] == "2019-06-14" and d["title"] == TITLE
    [entry] = format_references([d], "apa")
    assert "Journal of Development Economics, 140(2), 341–355." in entry

    index.asked.clear()
    client.post("/library/enrich", json={})
    assert index.asked == []  # done once; refresh asks again
    index.records[DOI] = record(cited_by_count=900)
    client.post("/library/enrich", json={"refresh": True})
    assert doc(client, doc_id)["cited_by_count"] == 900


def test_the_users_corrections_win(client, lib, index, tmp_path):
    doc_id = add(client, lib, tmp_path, "okafor", doi=DOI)
    client.patch(f"/documents/{doc_id}", json={"venue": "My venue", "year": 2020})
    index.records[DOI] = record()
    client.post("/library/enrich", json={})
    d = doc(client, doc_id)
    assert (d["venue"], d["year"]) == ("My venue", 2020)
    assert d["published"] == ""  # 2019's date doesn't belong to the year the user set
    assert d["volume"] == "140"


def test_a_doi_that_belongs_to_another_paper_changes_nothing(client, lib, index, tmp_path):
    doc_id = add(client, lib, tmp_path, "okafor", doi=DOI)
    index.records[DOI] = record(title="Risk sharing and transactions costs in East Africa")  # a paper it cites
    assert client.post("/library/enrich", json={}).json()["mismatched"] == 1
    d = doc(client, doc_id)
    assert d["enriched"] == "mismatch" and d["index_title"] == "Risk sharing and transactions costs in East Africa"
    assert d["authors"] == ["A. Okafor"] and d["volume"] == "" and d["cited_by_count"] is None


def test_a_title_muse_couldnt_read_is_taken_from_the_index(client, lib, index, tmp_path):
    doc_id = add(client, lib, tmp_path, "okafor", doi=DOI)
    with lib.conn:
        lib.conn.execute("UPDATE documents SET title = 'okafor', missing = '[\"metadata\", \"title\"]' WHERE id = ?", (doc_id,))
    index.records[DOI] = record()
    client.post("/library/enrich", json={})
    d = doc(client, doc_id)
    assert d["title"] == TITLE and d["missing"] == []


def test_failed_lookups_are_tried_again_and_unknown_ones_not(client, lib, index, tmp_path):
    down = add(client, lib, tmp_path, "a", doi="10.1/down", seed=2)
    unknown = add(client, lib, tmp_path, "b", title="Notes on savings groups in Malawi villages", doi="10.1/unknown", seed=3)
    index.records["10.1/down"] = httpx.ConnectError("offline")
    assert client.post("/library/enrich", json={}).json()["failed"] == 1
    assert doc(client, down)["enriched"] == "" and doc(client, unknown)["enriched"] == "not_found"
    index.asked.clear()
    client.post("/library/enrich", json={})
    assert index.asked == ["10.1/down"]


def test_the_index_reference_list_is_merged_into_the_network(client, lib, index, tmp_path):
    jack = add(client, lib, tmp_path, "jack", title="Risk sharing and transactions costs", doi="10.1/jack", year=2014, seed=4)
    okafor = add(client, lib, tmp_path, "okafor", doi=DOI, seed=5)
    with lib.conn:  # what was read from the paper's own text: one entry without a DOI, under another title
        lib.conn.execute("UPDATE documents SET refs_parsed = 1 WHERE id = ?", (okafor,))
        lib.conn.execute("DELETE FROM doc_refs WHERE doc_id = ?", (okafor,))
        lib.conn.execute("INSERT INTO doc_refs (doc_id, idx, raw, year, doi, title, first_author) VALUES (?, 0, ?, 2016, '', ?, 'Suri')",
                         (okafor, "Suri, T. (2016). The long-run poverty impacts of mobile money. Science.",
                          "The long-run poverty impacts of mobile money"))
    index.records[DOI] = record(references=[
        Reference(raw="Tavneet Suri (2016). The long-run poverty impacts of mobile money.", year=2016, doi="10.1/suri",
                  title="The long-run poverty impacts of mobile money", first_author="Suri"),
        Reference(raw="William Jack (2014). Risk sharing and transactions costs.", year=2014, doi="10.1/jack",
                  title="Risk sharing and transactions costs", first_author="Jack"),
    ])
    index.records["10.1/jack"] = None
    client.post("/library/enrich", json={})

    refs = client.get(f"/documents/{okafor}/cited").json()["references"]
    assert [(r["title"], r["doi"], r["from_index"]) for r in refs] == [
        ("The long-run poverty impacts of mobile money", "10.1/suri", False),  # the DOI added to the entry read from the text
        ("Risk sharing and transactions costs", "10.1/jack", True),  # only OpenAlex listed it
    ]
    assert refs[1]["in_library"] == jack
    graph = client.get("/graph").json()
    assert {"source": f"doc:{okafor}", "target": f"doc:{jack}", "kind": "cites", "how": "doi"} in graph["citations"]

    # Reading the PDF again replaces its own list but keeps OpenAlex's.
    with lib.conn:
        lib.conn.execute("DELETE FROM doc_refs WHERE doc_id = ?", (okafor,))
    assert len(client.get(f"/documents/{okafor}/cited").json()["references"]) == 2


def test_papers_citing_a_library_paper(client, lib, index, tmp_path):
    doc_id = add(client, lib, tmp_path, "okafor", doi=DOI)
    later = add(client, lib, tmp_path, "later", title="Later work on savings groups and mobile money", doi="10.1/later", year=2022, seed=6)
    index.records[DOI] = record()
    index.records["10.1/later"] = None
    r = client.get(f"/documents/{doc_id}/citing", params={"sort": "recent"}).json()  # looked up on the way
    assert (r["found"], r["total"], r["cited_by_count"]) == (True, 2, 812)
    assert index.citing_args == [("W1", "recent")]
    assert r["works"][0]["in_library"] == later and r["works"][0]["first_author"] == "Moyo"
    assert r["works"][1]["in_library"] is None
    assert client.get(f"/documents/{doc_id}/citing", params={"sort": "oldest"}).status_code == 400

    unknown = add(client, lib, tmp_path, "notes", title="Field notes from Kisumu market interviews", seed=7)
    assert client.get(f"/documents/{unknown}/citing").json() == {
        "doc_id": unknown, "title": "Field notes from Kisumu market interviews", "found": False, "total": 0, "works": [],
        "cited_by_count": None}


def test_any_work_can_be_fetched_into_the_library(client, lib, index, tmp_path):
    later = add(client, lib, tmp_path, "later", title="Later work on savings groups and mobile money", doi="10.1/later", year=2022)
    r = client.post("/library/fetch-work", json={"title": "Later work on savings groups and mobile money", "doi": "10.1/LATER"})
    assert r.json() == {"status": "in_library", "doc_id": later}
    assert index.fetched == []

    pdf = tmp_path / "dl.md"
    pdf.write_text("A newer study of savings and mobile wallets\nBea Moyo\n\n" + prose(8), encoding="utf-8")
    index.download = pdf
    index.records["10.1/new"] = record(title="A newer study of savings and mobile wallets", doi="10.1/new", references=[])
    r = client.post("/library/fetch-work", json={"title": "A newer study of savings and mobile wallets", "doi": "10.1/new",
                                                 "year": 2023, "first_author": "Moyo"}).json()
    assert r["status"] == "downloaded" and index.fetched[0].first_author == "Moyo"
    assert r["document"]["enriched"] == "found" and r["document"]["cited_by_count"] == 812  # looked up once added


def test_works_info_by_doi(client):
    assert client.post("/works/info", json={"dois": ["10.1/a"]}).json() == {"10.1/a": {"cited_by_count": 7, "abstract": "An abstract."}}


def test_an_import_looks_its_papers_up_unless_turned_off(client, lib, index, tmp_path):
    def run_job(name, seed):
        f = tmp_path / f"{name}.md"
        f.write_text(f"{TITLE} part {seed}\nAda Okafor\n\n" + prose(seed), encoding="utf-8")
        job = client.post("/ingest/jobs", json={"paths": [str(f)]}).json()
        for _ in range(200):
            job = client.get(f"/ingest/jobs/{job['id']}").json()
            if job["state"] in ("done", "failed", "cancelled"):
                return job
        raise AssertionError(job)

    run_job("one", 11)
    assert len(index.asked) == 1
    client.patch("/settings", json={"index_lookup": False})
    run_job("two", 12)
    assert len(index.asked) == 1


def test_bibtex_and_ieee_carry_volume_issue_and_publisher():
    d = {"title": "T", "authors": ["Ada Okafor"], "year": 2019, "venue": "J", "volume": "74", "issue": "3",
         "page_range": "341–355", "publisher": "Wiley"}
    assert "J, vol. 74, no. 3, pp. 341–355, 2019." in format_references([d], "ieee")[0]
    bib = format_references([d], "bibtex")[0]
    assert "volume = {74}" in bib and "number = {3}" in bib and "publisher = {Wiley}" in bib
    assert "J, vol. 74, no. 3, 2019, pp. 341–355." in format_references([d], "mla")[0]
