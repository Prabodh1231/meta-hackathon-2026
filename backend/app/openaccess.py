"""The open scholarly indexes. Free copies of cited works: look a reference up (OpenAlex, then
Semantic Scholar, then CORE when the user has a key) and download a PDF from the open-access
locations they list (arXiv, institutional repositories, open-access publishers). A reference without
a DOI gets one from Crossref first, so the indexes are asked by DOI. Paywalled works are reported,
never worked around. And what the indexes know about a library paper: the publisher's metadata,
its abstract, its reference list, how often it is cited and by which works."""

import dataclasses
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

import httpx

from .refparse import Reference, _similar, norm

log = logging.getLogger(__name__)

OPENALEX = "https://api.openalex.org"
SEMANTIC_SCHOLAR = "https://api.semanticscholar.org/graph/v1"
CROSSREF = "https://api.crossref.org"
CORE = "https://api.core.ac.uk/v3"  # repositories' full texts; needs a free key from core.ac.uk
MAX_PDF_BYTES = 60 * 1024 * 1024
MIN_TITLE_WORDS = 4  # shorter parsed titles ("Introduction", a journal name) find the wrong work
TITLE_MATCH = 0.88  # how close an index's title must be to the reference's own
# What a library paper's lookup asks OpenAlex for, in one request.
RECORD_FIELDS = ("id,doi,title,publication_year,publication_date,authorships,primary_location,biblio,"
                 "abstract_inverted_index,cited_by_count,referenced_works")
LIST_FIELDS = "id,doi,title,publication_year,authorships,primary_location,cited_by_count"
IDS_PER_REQUEST = 50  # OpenAlex takes up to this many ids in one filter


@dataclass
class Work:
    """A cited work as an index knows it, with where it can be read for free."""
    title: str
    year: int | None
    doi: str
    source: str  # which index found it
    pdf_urls: list[str] = field(default_factory=list)  # open-access PDF links, best first
    landing_url: str = ""  # a free page to read it on, when there is one
    is_oa: bool = False
    published: str = ""  # "YYYY-MM-DD" (or "YYYY-MM") when the index knows more than the year


@dataclass
class Fetched:
    status: str  # downloaded | link | no_free_copy | not_found | failed
    path: Path | None = None
    url: str = ""  # the PDF downloaded, or the free page to read it on
    work: Work | None = None
    reason: str = ""


@dataclass
class Record:
    """What the indexes know about one library paper: OpenAlex's record, with the publisher's own
    (Crossref) for the publisher, volume, issue, pages and authors."""
    title: str = ""
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    published: str = ""  # "YYYY-MM-DD" or "YYYY-MM"; '' when only the year is known
    doi: str = ""
    doi_found: bool = False  # Crossref found the DOI by title: the paper didn't carry one
    venue: str = ""
    volume: str = ""
    issue: str = ""
    pages: str = ""  # "341–355"
    publisher: str = ""
    abstract: str = ""
    openalex_id: str = ""  # "W2741809807"
    cited_by_count: int | None = None  # citations worldwide, as OpenAlex counts them
    references: list[Reference] = field(default_factory=list)  # its reference list, in order


def titles_agree(a: str, b: str) -> bool:
    """Two titles name the same work: nearly the same, or one is the other without its subtitle."""
    return same_work(Reference(raw=a, title=a), b, None)


def _abstract(inverted: dict | None) -> str:
    """OpenAlex keeps abstracts as {word: [positions]}; the text back in order."""
    if not inverted:
        return ""
    return " ".join(w for _, w in sorted((i, w) for w, places in inverted.items() for i in places))


def _jats(text: str | None) -> str:
    """Crossref abstracts are JATS XML: the text without tags or a leading "Abstract"."""
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text or "")).strip()
    text = re.sub(r"\s+([.,;:)])", r"\1", text)  # where a closing tag stood before punctuation
    return re.sub(r"^abstract\b[:.]?\s*", "", text, flags=re.I)


def _short_id(url: str | None) -> str:
    return (url or "").rsplit("/", 1)[-1]


def _authors(w: dict) -> list[str]:
    return [a["author"]["display_name"] for a in w.get("authorships") or [] if (a.get("author") or {}).get("display_name")]


def _venue(w: dict) -> str:
    return ((w.get("primary_location") or {}).get("source") or {}).get("display_name") or ""


def _pages(first: str | None, last: str | None) -> str:
    first, last = (str(first or "").strip(), str(last or "").strip())
    return f"{first}–{last}" if first and last and last != first else first


def listed_work(w: dict) -> dict:
    """An OpenAlex work as the app lists it (a citing paper, a cited one)."""
    return {
        "openalex_id": _short_id(w.get("id")), "doi": _doi(w.get("doi")), "title": w.get("title") or "",
        "authors": _authors(w), "year": w.get("publication_year"), "venue": _venue(w),
        "cited_by_count": w.get("cited_by_count"), "abstract": _abstract(w.get("abstract_inverted_index")),
    }


def as_reference(w: dict) -> Reference:
    """An OpenAlex work as an entry in a reference list."""
    item = listed_work(w)
    first = item["authors"][0].split()[-1] if item["authors"] else ""
    who = item["authors"][0] + (" et al." if len(item["authors"]) > 1 else "") if item["authors"] else ""
    raw = " ".join(p for p in (who, f"({item['year']})." if item["year"] else "", f"{item['title']}.", item["venue"]) if p)
    return Reference(raw=raw, year=item["year"], doi=item["doi"], title=item["title"], first_author=first)


def searchable(ref: Reference) -> bool:
    """Whether the entry carries enough to identify the work: a DOI, or a title of a few words."""
    return bool(ref.doi) or len(norm(ref.title).split()) >= MIN_TITLE_WORDS


def same_work(ref: Reference, title: str, year: int | None) -> bool:
    """An index's search hit is the cited work: nearly the same title (or one is the other with
    its subtitle cut off), and the same year give or take one when both are known."""
    a, b = norm(ref.title), norm(title)
    if not a or not b:
        return False
    short, long_ = sorted((a, b), key=len)
    titled = _similar(a, b, TITLE_MATCH) or (len(short.split()) >= 5 and long_.startswith(short))
    return titled and not (ref.year and year and abs(ref.year - year) > 1)


def file_name(ref: Reference, work: Work | None) -> str:
    """'Okafor 2019 - Mobile money and household savings.pdf', safe on every filesystem."""
    title = (work.title if work else "") or ref.title or "paper"
    year = (work.year if work else None) or ref.year
    stem = " ".join(str(p) for p in (ref.first_author, year) if p)
    stem = f"{stem} - {title}" if stem else title
    stem = re.sub(r"[^\w\-,. ()']+", " ", stem, flags=re.UNICODE)
    return re.sub(r"\s+", " ", stem).strip(" .")[:110] + ".pdf"


def _date(value: str | None) -> str:
    """'2004-06-01' or '2004-06' as given; anything else (a bare year, junk) is ''."""
    m = re.match(r"^(\d{4}-\d{2}(?:-\d{2})?)", value or "")
    return m.group(1) if m else ""


def _crossref_date(item: dict) -> str:
    """'2004-06-01', '2004-06' or '2004' from a Crossref record's date parts; '' when it has none.
    `issued` is the earlier of the print and online dates."""
    for key in ("issued", "published-print", "published-online"):
        parts = ((item.get(key) or {}).get("date-parts") or [[None]])[0]
        if parts and parts[0]:
            return "-".join(f"{n:02d}" if i else str(n) for i, n in enumerate(parts[:3]))
    return ""


def _doi(value: str | None) -> str:
    return re.sub(r"^https?://(dx\.)?doi\.org/", "", value or "", flags=re.I).lower()


class OpenAccess:
    def __init__(self, contact_email: str = "", transport: httpx.BaseTransport | None = None,
                 timeout: float = 30.0, retry_wait: float = 2.0, core_key: str = ""):
        self.retry_wait = retry_wait
        self.client = httpx.Client(timeout=timeout, follow_redirects=True, transport=transport)
        self.set_contact(contact_email)
        self.core_key = core_key

    def set_core_key(self, key: str) -> None:
        """CORE is searched only with a key; empty turns it off."""
        self.core_key = key

    def check_core_key(self, key: str) -> None:
        """Raise ValueError when CORE refuses the key or can't be reached to check it."""
        try:
            res = self.client.get(f"{CORE}/search/works", params={"q": 'title:"coral reef"', "limit": "1"},
                                  headers={"Authorization": f"Bearer {key}"})
        except httpx.HTTPError as exc:
            raise ValueError(f"Couldn't reach CORE to check the key: {exc}") from exc
        if res.status_code in (401, 403):
            raise ValueError("CORE didn't accept that key. Copy it again from the email CORE sent you.")
        if res.status_code >= 500:
            raise ValueError(f"CORE couldn't check the key just now (HTTP {res.status_code}). Try again in a minute.")

    def set_contact(self, contact_email: str) -> None:
        """The email the indexes may write to about our requests (their polite pool)."""
        self.mailto = contact_email
        self.client.headers["User-Agent"] = "Groundwork/1.0" + (f" (mailto:{contact_email})" if contact_email else "")

    def _get(self, url: str, params: dict | None = None, headers: dict | None = None) -> httpx.Response | None:
        """GET with one retry on rate limits and gateway errors; None when the work isn't there."""
        for attempt in range(2):
            res = self.client.get(url, params=params, headers=headers)
            if res.status_code == 404:
                return None
            if res.status_code in (429, 502, 503, 504) and attempt == 0:
                time.sleep(self.retry_wait)
                continue
            res.raise_for_status()
            return res
        return None

    # ---------- finding the work ----------

    def _openalex(self, ref: Reference) -> Work | None:
        params = {"select": "doi,title,publication_year,publication_date,open_access,best_oa_location,locations"}
        if self.mailto:
            params["mailto"] = self.mailto
        if ref.doi:
            res = self._get(f"{OPENALEX}/works/doi:{ref.doi}", params)
            hits = [res.json()] if res else []
        else:
            params.update({"search": norm(ref.title), "per-page": "5"})
            if ref.year:
                params["filter"] = f"publication_year:{ref.year - 1}-{ref.year + 1}"
            res = self._get(f"{OPENALEX}/works", params)
            hits = (res.json().get("results") or []) if res else []
        for w in hits:
            title, year = w.get("title") or "", w.get("publication_year")
            if not ref.doi and not same_work(ref, title, year):
                continue
            best = w.get("best_oa_location") or {}
            oa = w.get("open_access") or {}
            pdfs = [best.get("pdf_url")]
            pdfs += [loc.get("pdf_url") for loc in w.get("locations") or [] if loc.get("is_oa")]
            pdfs.append(oa.get("oa_url"))  # often the PDF itself; checked when downloaded
            return Work(title, year, _doi(w.get("doi")) or ref.doi, "OpenAlex",
                        pdf_urls=list(dict.fromkeys(u for u in pdfs if u)),
                        landing_url=best.get("landing_page_url") or oa.get("oa_url") or "",
                        is_oa=bool(oa.get("is_oa")), published=_date(w.get("publication_date")))
        return None

    def _crossref_find(self, ref: Reference) -> tuple[str, str] | None:
        """The DOI and publication date of a reference that has no DOI, from Crossref's search over
        title, first author and year. Only a hit with the same title and year counts."""
        query = " ".join(str(p) for p in (ref.title, ref.first_author, ref.year) if p)
        params = {"query.bibliographic": query, "rows": "5", "select": "DOI,title,issued"}
        if self.mailto:
            params["mailto"] = self.mailto
        res = self._get(f"{CROSSREF}/works", params)
        for item in ((res.json().get("message") or {}).get("items") or []) if res else []:
            date = _crossref_date(item)
            if _doi(item.get("DOI")) and same_work(ref, (item.get("title") or [""])[0], int(date[:4]) if date else None):
                return _doi(item.get("DOI")), date
        return None

    def _with_doi(self, ref: Reference) -> tuple[Reference, str]:
        """The reference with the DOI Crossref has for it, when it had none, and Crossref's date.
        Best effort: Crossref being down only means asking the indexes by title."""
        if ref.doi or not searchable(ref):
            return ref, ""
        try:
            hit = self._crossref_find(ref)
        except (httpx.HTTPError, ValueError):  # ValueError: a reply that isn't JSON
            log.info("Crossref lookup failed", exc_info=True)
            return ref, ""
        return (dataclasses.replace(ref, doi=hit[0]), hit[1]) if hit else (ref, "")

    def _core(self, ref: Reference) -> Work | None:
        """Full texts CORE gathered from university and subject repositories, by DOI or title."""
        if not self.core_key:
            return None
        title = re.sub(r'["\\]', " ", ref.title).strip()
        q = f'doi:"{ref.doi}"' if ref.doi else f'title:"{title}"'
        res = self._get(f"{CORE}/search/works", {"q": q, "limit": "5"}, {"Authorization": f"Bearer {self.core_key}"})
        for w in (res.json().get("results") or []) if res else []:
            title, year = w.get("title") or "", w.get("yearPublished")
            if not (ref.doi and _doi(w.get("doi")) == ref.doi) and not same_work(ref, title, year):
                continue
            pdfs = [w.get("downloadUrl")]
            pdfs += [link.get("url") for link in w.get("links") or [] if link.get("type") == "download"]
            pdfs += w.get("sourceFulltextUrls") or []  # repository pages or their PDFs; checked when downloaded
            pdfs = list(dict.fromkeys(u for u in pdfs if u))
            return Work(title, year, _doi(w.get("doi")) or ref.doi, "CORE", pdf_urls=pdfs,
                        landing_url=f"https://core.ac.uk/works/{w['id']}" if w.get("id") else "",
                        is_oa=bool(pdfs), published=_date(w.get("publishedDate")))
        return None

    def _semantic_scholar(self, ref: Reference) -> Work | None:
        params = {"fields": "title,year,publicationDate,externalIds,openAccessPdf"}
        if ref.doi:
            res = self._get(f"{SEMANTIC_SCHOLAR}/paper/DOI:{ref.doi}", params)
            hit = res.json() if res else None
        else:
            res = self._get(f"{SEMANTIC_SCHOLAR}/paper/search/match", {**params, "query": ref.title})
            hit = ((res.json().get("data") or [None])[0]) if res else None
        if not hit or (not ref.doi and not same_work(ref, hit.get("title") or "", hit.get("year"))):
            return None
        ids = hit.get("externalIds") or {}
        pdfs = [(hit.get("openAccessPdf") or {}).get("url")]
        if ids.get("ArXiv"):
            pdfs.append(f"https://arxiv.org/pdf/{ids['ArXiv']}")
        pdfs = list(dict.fromkeys(u for u in pdfs if u))
        return Work(hit.get("title") or "", hit.get("year"), _doi(ids.get("DOI")) or ref.doi, "Semantic Scholar",
                    pdf_urls=pdfs, landing_url=f"https://arxiv.org/abs/{ids['ArXiv']}" if ids.get("ArXiv") else "",
                    is_oa=bool(pdfs), published=_date(hit.get("publicationDate")))

    # ---------- what the indexes know about a paper ----------

    def _params(self, **more) -> dict:
        return {**({"mailto": self.mailto} if self.mailto else {}), **more}

    def _openalex_work(self, ref: Reference, select: str) -> dict | None:
        """OpenAlex's record of the work: by DOI, or the search hit with the same title and year."""
        if ref.doi:
            res = self._get(f"{OPENALEX}/works/doi:{ref.doi}", self._params(select=select))
            return res.json() if res else None
        params = self._params(select=select, search=norm(ref.title), **{"per-page": "5"})
        if ref.year:
            params["filter"] = f"publication_year:{ref.year - 1}-{ref.year + 1}"
        res = self._get(f"{OPENALEX}/works", params)
        hits = (res.json().get("results") or []) if res else []
        return next((w for w in hits if same_work(ref, w.get("title") or "", w.get("publication_year"))), None)

    def _crossref_work(self, doi: str) -> dict:
        """The publisher's record of a DOI in Crossref; {} when it isn't there or Crossref is down."""
        try:
            res = self._get(f"{CROSSREF}/works/{quote(doi, safe='/:;()')}", self._params())
            return (res.json().get("message") or {}) if res else {}
        except (httpx.HTTPError, ValueError):
            log.info("Crossref lookup failed for %s", doi, exc_info=True)
            return {}

    def _s2_abstract(self, doi: str) -> str:
        """Semantic Scholar's abstract, for papers whose publisher withholds it from the others."""
        try:
            res = self._get(f"{SEMANTIC_SCHOLAR}/paper/DOI:{doi}", {"fields": "abstract"})
            return ((res.json() or {}).get("abstract") or "") if res else ""
        except (httpx.HTTPError, ValueError):
            log.info("Semantic Scholar abstract lookup failed for %s", doi, exc_info=True)
            return ""

    def works_by_id(self, ids: list[str], select: str = LIST_FIELDS) -> dict[str, dict]:
        """OpenAlex works by id ("W123"), a batch per request."""
        out: dict[str, dict] = {}
        for i in range(0, len(ids), IDS_PER_REQUEST):
            batch = ids[i:i + IDS_PER_REQUEST]
            res = self._get(f"{OPENALEX}/works", self._params(
                select=select, filter="openalex:" + "|".join(batch), **{"per-page": str(len(batch))}))
            for w in (res.json().get("results") or []) if res else []:
                out[_short_id(w.get("id"))] = w
        return out

    def works_by_doi(self, dois: list[str]) -> dict[str, dict]:
        """How often each DOI is cited worldwide, and its abstract: {doi: listed work}."""
        out: dict[str, dict] = {}
        dois = list(dict.fromkeys(_doi(d) for d in dois if d))
        for i in range(0, len(dois), IDS_PER_REQUEST):
            batch = dois[i:i + IDS_PER_REQUEST]
            res = self._get(f"{OPENALEX}/works", self._params(
                select=LIST_FIELDS + ",abstract_inverted_index", filter="doi:" + "|".join(batch),
                **{"per-page": str(len(batch))}))
            for w in (res.json().get("results") or []) if res else []:
                out[_doi(w.get("doi"))] = listed_work(w)
        return out

    def citing(self, openalex_id: str, sort: str = "cited", limit: int = 25) -> tuple[int, list[dict]]:
        """Works that cite this one, the most cited (or the newest) first, and how many there are."""
        order = "publication_date:desc" if sort == "recent" else "cited_by_count:desc"
        res = self._get(f"{OPENALEX}/works", self._params(
            select=LIST_FIELDS + ",abstract_inverted_index", filter=f"cites:{openalex_id}", sort=order,
            **{"per-page": str(limit)}))
        if not res:
            return 0, []
        body = res.json()
        return (body.get("meta") or {}).get("count") or 0, [listed_work(w) for w in body.get("results") or []]

    def search(self, query: str, limit: int = 15) -> list[dict]:
        """Works matching a free-text query (title, abstract and full text), most relevant first."""
        res = self._get(f"{OPENALEX}/works", self._params(
            select=LIST_FIELDS + ",abstract_inverted_index", search=query, **{"per-page": str(limit)}))
        return [listed_work(w) for w in (res.json().get("results") or [])] if res else []

    def record(self, doi: str, title: str, year: int | None) -> Record | None:
        """What the indexes know about a library paper, found by its DOI, or by a DOI Crossref has
        for its title and year, or by OpenAlex's title search. None when neither OpenAlex nor
        Crossref knows it. Raises httpx.HTTPError when OpenAlex can't be reached, so the caller can
        try again later; Crossref and Semantic Scholar only fill gaps, so their failures don't."""
        ref, _ = self._with_doi(Reference(raw=title, doi=_doi(doi), title=title, year=year))
        if not searchable(ref):
            return None
        w = self._openalex_work(ref, RECORD_FIELDS) or {}
        found = ref.doi or _doi(w.get("doi"))
        cr = self._crossref_work(found) if found else {}
        if not w and not cr:
            return None
        biblio = w.get("biblio") or {}
        cr_authors = [" ".join(p for p in (a.get("given"), a.get("family")) if p) for a in cr.get("author") or []]
        published = _date(w.get("publication_date")) or _date(_crossref_date(cr))
        rec = Record(
            title=w.get("title") or (cr.get("title") or [""])[0],
            # The publisher's own author list, in its order and spelling; OpenAlex's otherwise.
            authors=[a for a in cr_authors if a] or _authors(w),
            year=w.get("publication_year") or (int(_crossref_date(cr)[:4]) if _crossref_date(cr) else None),
            published=published, doi=found, doi_found=bool(ref.doi) and ref.doi != _doi(doi),
            venue=(cr.get("container-title") or [""])[0] or _venue(w),
            volume=str(biblio.get("volume") or cr.get("volume") or ""),
            issue=str(biblio.get("issue") or cr.get("issue") or ""),
            pages=_pages(biblio.get("first_page"), biblio.get("last_page")) or (cr.get("page") or "").replace("-", "–"),
            publisher=cr.get("publisher") or "",
            abstract=_abstract(w.get("abstract_inverted_index")) or _jats(cr.get("abstract")),
            openalex_id=_short_id(w.get("id")), cited_by_count=w.get("cited_by_count"),
        )
        ids = [_short_id(u) for u in w.get("referenced_works") or []]
        if ids:
            works = self.works_by_id(ids)
            rec.references = [as_reference(works[i]) for i in ids if i in works]
        if not rec.abstract and rec.doi:
            rec.abstract = self._s2_abstract(rec.doi)
        return rec

    # ---------- downloading ----------

    def _download(self, url: str, dest: Path) -> bool:
        """Save the URL to dest if it serves a PDF. Publisher links often answer with a landing
        page or a login wall instead, which is skipped."""
        if not re.match(r"https?://", url, re.I):
            return False
        partial = dest.with_name(dest.name + ".part")
        try:
            with self.client.stream("GET", url) as res:
                if res.status_code != 200:
                    return False
                size, head = 0, b""
                with partial.open("wb") as f:
                    for block in res.iter_bytes():
                        if not head:
                            head = block[:1024]
                            if b"%PDF-" not in head:
                                break
                        size += len(block)
                        if size > MAX_PDF_BYTES:
                            break
                        f.write(block)
                if b"%PDF-" not in head or size > MAX_PDF_BYTES:
                    partial.unlink(missing_ok=True)
                    return False
            partial.replace(dest)
            return True
        except (httpx.HTTPError, OSError):
            log.info("Could not download %s", url, exc_info=True)
            partial.unlink(missing_ok=True)
            return False

    def fetch(self, ref: Reference, folder: Path) -> Fetched:
        """Find the cited work and download a free PDF of it into folder."""
        if not searchable(ref):
            return Fetched("not_found", reason="The reference has no DOI and too short a title to search for")
        folder.mkdir(parents=True, exist_ok=True)
        ref, _ = self._with_doi(ref)
        found: Work | None = None
        landing, tried, errors = "", set(), []
        lookups = [self._openalex, self._semantic_scholar] + ([self._core] if self.core_key else [])
        names = " or ".join(", ".join(["OpenAlex", "Semantic Scholar", "CORE"][:len(lookups)]).rsplit(", ", 1))
        for lookup in lookups:
            try:
                work = lookup(ref)
            except (httpx.HTTPError, ValueError) as exc:  # ValueError: a reply that isn't JSON
                log.info("%s lookup failed", lookup.__name__, exc_info=True)
                errors.append(str(exc))
                continue
            if not work:
                continue
            found = found or work
            landing = landing or work.landing_url
            for url in work.pdf_urls:
                if url in tried:
                    continue
                tried.add(url)
                dest = _unique(folder / file_name(ref, found))
                if self._download(url, dest):
                    return Fetched("downloaded", dest, url, work)
        if landing:
            return Fetched("link", url=landing, work=found, reason="Free to read online, but no PDF could be downloaded")
        if found:
            return Fetched("no_free_copy", work=found, reason=f"Found in {found.source}, but no free copy is listed")
        if len(errors) == len(lookups):  # no index answered
            return Fetched("failed", reason=f"Couldn't reach {names}")
        return Fetched("not_found", reason=f"Not found in {names}")


def _unique(path: Path) -> Path:
    n = 2
    candidate = path
    while candidate.exists():
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        n += 1
    return candidate
