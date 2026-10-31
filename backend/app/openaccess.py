"""Free copies of cited works: look a reference up in open scholarly indexes (OpenAlex, then
Semantic Scholar) and download a PDF from the open-access locations they list (arXiv, institutional
repositories, open-access publishers). Paywalled works are reported, never worked around."""

import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .refparse import Reference, _similar, norm

log = logging.getLogger(__name__)

OPENALEX = "https://api.openalex.org"
SEMANTIC_SCHOLAR = "https://api.semanticscholar.org/graph/v1"
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


def _doi(value: str | None) -> str:
    return re.sub(r"^https?://(dx\.)?doi\.org/", "", value or "", flags=re.I).lower()


class OpenAccess:
    def __init__(self, contact_email: str = "", transport: httpx.BaseTransport | None = None,
                 timeout: float = 30.0, retry_wait: float = 2.0):
        self.retry_wait = retry_wait
        self.client = httpx.Client(timeout=timeout, follow_redirects=True, transport=transport)
        self.set_contact(contact_email)

    def set_contact(self, contact_email: str) -> None:
        """The email the indexes may write to about our requests (their polite pool)."""
        self.mailto = contact_email
        self.client.headers["User-Agent"] = "ResearchCompanion/1.0" + (f" (mailto:{contact_email})" if contact_email else "")

    def _get(self, url: str, params: dict | None = None) -> httpx.Response | None:
        """GET with one retry on rate limits and gateway errors; None when the work isn't there."""
        for attempt in range(2):
            res = self.client.get(url, params=params)
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

    def publication_date(self, doi: str, title: str, year: int | None) -> tuple[str, int | None] | None:
        """A library paper's full publication date and year from OpenAlex, found by DOI or by title
        and year. None when it isn't found or the index only knows the year. Raises
        httpx.HTTPError when OpenAlex can't be reached, so the caller can try again later."""
        ref = Reference(raw=title, doi=_doi(doi), title=title, year=year)
        if not searchable(ref):
            return None
        work = self._openalex(ref)
        return (work.published, work.year) if work and work.published else None

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
        found: Work | None = None
        landing, tried, errors = "", set(), []
        for lookup in (self._openalex, self._semantic_scholar):
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
        if len(errors) == 2:  # neither index answered
            return Fetched("failed", reason="Couldn't reach OpenAlex or Semantic Scholar")
        return Fetched("not_found", reason="Not found in OpenAlex or Semantic Scholar")


def _unique(path: Path) -> Path:
    n = 2
    candidate = path
    while candidate.exists():
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        n += 1
    return candidate
