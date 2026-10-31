"""Free copies of cited works: look a reference up in open scholarly indexes (OpenAlex, then
Semantic Scholar, then CORE when the user has a key) and download a PDF from the open-access
locations they list (arXiv, institutional repositories, open-access publishers). A reference without
a DOI gets one from Crossref first, so the indexes are asked by DOI. Paywalled works are reported,
never worked around."""

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
class Dated:
    """What a lookup learned about a library paper: its full publication date ("YYYY-MM-DD" or
    "YYYY-MM", '' when only the year is known) and the DOI Crossref found for it ('' if none)."""
    published: str
    doi: str = ""


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
        self.client.headers["User-Agent"] = "ResearchCompanion/1.0" + (f" (mailto:{contact_email})" if contact_email else "")

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

    def _crossref_date(self, doi: str) -> str:
        """A DOI's publication date as Crossref records it; '' when it isn't registered there."""
        res = self._get(f"{CROSSREF}/works/{quote(doi, safe='/:;()')}", {"mailto": self.mailto} if self.mailto else None)
        return _crossref_date((res.json().get("message") or {})) if res else ""

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

    def publication_date(self, doi: str, title: str, year: int | None) -> Dated | None:
        """A library paper's full publication date, and its DOI when it had none. Crossref finds the
        DOI of a paper without one; OpenAlex, then Crossref, give the date. None when nothing was
        learned. Raises httpx.HTTPError when OpenAlex can't be reached, so the caller can try again."""
        ref, crossref_date = self._with_doi(Reference(raw=title, doi=_doi(doi), title=title, year=year))
        if not searchable(ref):
            return None
        found_doi = ref.doi if ref.doi != _doi(doi) else ""
        work = self._openalex(ref)
        published = (work.published if work else "") or _date(crossref_date)
        if not published and ref.doi and not crossref_date:
            try:
                published = _date(self._crossref_date(ref.doi))
            except (httpx.HTTPError, ValueError):
                log.info("Crossref date lookup failed for %s", ref.doi, exc_info=True)
        return Dated(published, found_doi) if published or found_doi else None

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
