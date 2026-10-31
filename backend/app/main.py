import base64
import logging

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .export_docx import export_docx
from .jobs import IngestJobs
from .library import INGEST_WORKERS, Library
from .matrix import DEFAULT_COLUMNS, Matrices
from .parent_watch import exit_with_parent
from .settings import Settings

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)


class IngestPathIn(BaseModel):
    path: str


class IngestPathsIn(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=2000)


class FillMissingIn(BaseModel):
    doc_ids: list[int] | None = None  # every document with missing parts when left out


class ModelIn(BaseModel):
    provider: str | None = None  # muse | mock
    api_key: str | None = None  # write-only; left out keeps the stored key
    reasoning_effort: str | None = None
    route: str | None = None  # baseten-first | meta | baseten


class SearchIn(BaseModel):
    where: str | None = None  # auto | local | baseten
    api_key: str | None = None  # write-only; left out keeps the stored key
    embed_model: str | None = None  # a Baseten model ID or URL; "" clears it
    rerank_model: str | None = None


class MatrixColumn(BaseModel):
    key: str = ""
    label: str
    instruction: str = ""
    query: str = ""


class MatrixIn(BaseModel):
    name: str
    doc_ids: list[int] = Field(min_length=1)
    columns: list[MatrixColumn] | None = None  # the five standard columns when left out


class MatrixPatch(BaseModel):
    name: str | None = None
    columns: list[MatrixColumn] | None = None
    add_doc_ids: list[int] | None = None
    remove_doc_ids: list[int] | None = None


class MatrixPapersIn(BaseModel):
    folder_id: int | None = None
    topic: str = ""


class CellIn(BaseModel):
    answer: str


class RerunIn(BaseModel):
    doc_id: int | None = None
    column: str | None = None


class SynthesisIn(BaseModel):
    instruction: str = ""
    columns: list[str] | None = None


class IngestUrlIn(BaseModel):
    url: str


class DocumentPatch(BaseModel):
    title: str | None = None
    authors: list[str] | None = None
    year: int | None = None
    venue: str | None = None
    doi: str | None = None
    url: str | None = None
    topic_id: int | None = None
    tags: list[str] | None = None


class TopicPatch(BaseModel):
    label: str = Field(min_length=1)
    description: str | None = None


class FolderIn(BaseModel):
    name: str = Field(min_length=1)
    similarity: int = Field(50, ge=0, le=100)  # percent a document must match to be filed here


class FolderPatch(BaseModel):
    name: str | None = Field(None, min_length=1)
    similarity: int | None = Field(None, ge=0, le=100)


class DocFolderIn(BaseModel):
    name: str = Field(min_length=1)


class MembershipIn(BaseModel):
    member: bool


class MergeIn(BaseModel):
    source_ids: list[int]
    into_id: int


class DraftIn(BaseModel):
    instruction: str = Field(min_length=1)
    context: str = ""
    doc_ids: list[int] | None = None
    k: int = Field(8, ge=1, le=30)
    verify: bool = False  # the UI verifies each citation separately so drafts appear fast


class VerifyIn(BaseModel):
    claim: str
    chunk_id: int
    quote: str


class SuggestIn(BaseModel):
    claim: str
    doc_ids: list[int] | None = None
    limit: int = Field(4, ge=1, le=10)


class ResolveItem(BaseModel):
    doc_id: int
    page: int
    quote: str


class ResolveIn(BaseModel):
    items: list[ResolveItem] = Field(max_length=500)


class ReferencesIn(BaseModel):
    doc_ids: list[int]
    style: str = "apa"


class ExportIn(BaseModel):
    content: dict  # the editor's document JSON
    style: str = "apa"
    title: str = ""


# Bump when the UI starts relying on a new or changed endpoint. The app compares it with its own
# number and asks for a restart when the backend that's running is older than the UI.
API_VERSION = 13

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class DraftDocIn(BaseModel):
    title: str = "Untitled"
    content: str = ""


class VersionIn(BaseModel):
    label: str = ""
    title: str = "Untitled"
    content: str


class VersionPatch(BaseModel):
    label: str = Field(min_length=1)


class CompareIn(BaseModel):
    content: dict | None = None  # the editor's document; the saved draft when missing
    against: int | None = None  # another version instead


class NewDraftIn(BaseModel):
    title: str = "Untitled"


class ImportDocxIn(BaseModel):
    filename: str = ""
    data: str = Field(max_length=70_000_000)  # base64 of the .docx (about 50 MB at most)


class SourcesIn(BaseModel):
    core_api_key: str = Field(max_length=400)  # write-only; "" removes it


class DuplicateFilesIn(BaseModel):
    cited: list[int] = []  # documents the draft cites: preferred as the copy to keep


class DuplicatesIn(BaseModel):
    content: dict  # the editor's document JSON


def create_app(settings: Settings | None = None, library: Library | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    if settings.parent_pid:
        exit_with_parent(settings.parent_pid)
    lib = library or Library(settings)
    app = FastAPI(title="Research Companion")
    app.state.library = lib
    jobs = IngestJobs(lib, INGEST_WORKERS)
    app.state.jobs = jobs
    matrices = Matrices(lib)
    app.state.matrices = matrices

    @app.middleware("http")
    async def require_token(request: Request, call_next):
        # The backend can read any local file, so only the Electron app (which knows the
        # per-launch token) may call it.
        if settings.api_token and request.method != "OPTIONS" and request.url.path != "/health":
            if request.headers.get("x-rc-token") != settings.api_token:
                return JSONResponse({"detail": "Missing or invalid token"}, status_code=401)
        return await call_next(request)

    app.add_middleware(  # added last so it wraps the token check and 401s still carry CORS headers
        CORSMiddleware,
        allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|null)$",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(LookupError)
    async def not_found(_, exc):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(ValueError)
    async def bad_request(_, exc):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.get("/health")
    def health():
        return {"ok": True, "api": API_VERSION, "provider": lib.provider.name,
                "muse_route": getattr(lib.provider, "route", []), "embedder": lib.embedder.id,
                "embedder_device": getattr(lib.embedder, "device", "cpu"),
                "reranker": lib.reranker.id if lib.reranker else None}

    @app.post("/ingest/path")
    def ingest_path(body: IngestPathIn):
        return {"results": lib.ingest_path(body.path)}

    @app.post("/ingest/paths")
    def ingest_paths(body: IngestPathsIn):
        """Several files and folders at once: they're read in parallel, not one request per file."""
        return {"results": lib.ingest_paths(body.paths)}

    @app.post("/ingest/jobs")
    def start_ingest_job(body: IngestPathsIn):
        """Add files and folders in the background; poll the job for each file's progress."""
        return jobs.start(body.paths)

    @app.get("/ingest/jobs")
    def list_ingest_jobs():
        return jobs.list()

    @app.get("/ingest/jobs/{job_id}")
    def get_ingest_job(job_id: int):
        return jobs.get(job_id)

    @app.post("/ingest/jobs/{job_id}/cancel")
    def cancel_ingest_job(job_id: int):
        return jobs.cancel(job_id)

    @app.post("/library/fill-missing")
    def fill_missing(body: FillMissingIn):
        """Try again the summaries, tags and metadata that failed when documents were added."""
        return lib.fill_missing(body.doc_ids)

    @app.post("/ingest/url")
    def ingest_url(body: IngestUrlIn):
        return lib.ingest_url(body.url)

    @app.get("/documents")
    def list_documents():
        return lib.list_documents()

    @app.post("/library/duplicates")
    def duplicate_files(body: DuplicateFilesIn):
        """Duplicate files in the library, labelled by strength of evidence. Recommends only."""
        return lib.find_duplicate_files(body.cited)

    @app.get("/documents/{doc_id}")
    def get_document(doc_id: int):
        return lib.get_document(doc_id)

    @app.patch("/documents/{doc_id}")
    def update_document(doc_id: int, body: DocumentPatch):
        return lib.update_document(doc_id, body.model_dump(exclude_unset=True))

    @app.delete("/documents/{doc_id}")
    def delete_document(doc_id: int, reason: str = "removed", duplicate_of: int | None = None, trashed: bool = False):
        """Removes it, keeping what it was in the removal log (`reason`: removed | duplicate)."""
        lib.delete_document(doc_id, reason, duplicate_of, trashed)
        return {"ok": True}

    @app.get("/library/removed")
    def list_removed():
        return lib.list_removed()

    @app.post("/library/removed/{removed_id}/restore")
    def restore_removed(removed_id: int):
        return lib.restore_removed(removed_id)

    @app.delete("/library/removed/{removed_id}")
    def forget_removed(removed_id: int):
        lib.forget_removed(removed_id)
        return {"ok": True}

    @app.post("/library/publication-dates")
    def fill_publication_dates():
        """Full publication dates from OpenAlex for the papers not yet looked up."""
        return lib.fill_publication_dates()

    @app.get("/documents/{doc_id}/pages/{page}")
    def get_page(doc_id: int, page: int):
        return lib.get_page(doc_id, page)

    @app.get("/search")
    def search(q: str, k: int = 8):
        return lib.search(q, k=k)

    @app.get("/topics")
    def list_topics():
        return lib.list_topics()

    @app.post("/topics/rebuild")
    def rebuild_topics():
        return lib.rebuild_topics()

    @app.patch("/topics/{topic_id}")
    def rename_topic(topic_id: int, body: TopicPatch):
        return lib.rename_topic(topic_id, body.label, body.description)

    @app.post("/topics/merge")
    def merge_topics(body: MergeIn):
        return lib.merge_topics(body.source_ids, body.into_id)

    @app.get("/folders")
    def list_folders():
        return lib.list_folders()

    @app.post("/folders")
    def create_folder(body: FolderIn):
        return lib.create_folder(body.name, body.similarity)

    @app.post("/folders/classify")
    def classify_all():
        return lib.classify_all()

    @app.patch("/folders/{folder_id}")
    def update_folder(folder_id: int, body: FolderPatch):
        return lib.update_folder(folder_id, body.name, body.similarity)

    @app.delete("/folders/{folder_id}")
    def delete_folder(folder_id: int):
        return lib.delete_folder(folder_id)

    @app.post("/documents/{doc_id}/classify")
    def classify_document(doc_id: int):
        return lib.classify_document(doc_id)

    @app.post("/documents/{doc_id}/folders")
    def add_to_folder(doc_id: int, body: DocFolderIn):
        return lib.add_to_folder_named(doc_id, body.name)

    @app.put("/documents/{doc_id}/folders/{folder_id}")
    def set_membership(doc_id: int, folder_id: int, body: MembershipIn):
        return lib.set_folder_membership(doc_id, folder_id, body.member)

    @app.get("/graph")
    def citation_graph(q: str = ""):
        return lib.citation_graph(q)

    @app.get("/missing")
    def missing_works(q: str = "", limit: int = 100):
        """Works the papers about a topic cite that the library lacks, most cited first."""
        return lib.missing_works(q, max(1, min(limit, 500)))

    @app.get("/documents/{doc_id}/cited")
    def cited_works(doc_id: int):
        """The paper's reference list, marking the entries already in the library."""
        return lib.cited_works(doc_id)

    @app.post("/documents/{doc_id}/cited/{idx}/fetch")
    def fetch_cited_work(doc_id: int, idx: int):
        """Download a free, open-access copy of one cited work and add it to the library."""
        return lib.fetch_cited_work(doc_id, idx)

    @app.post("/write/draft")
    def draft(body: DraftIn):
        return lib.draft(body.instruction, body.context, body.doc_ids, body.k, body.verify)

    @app.post("/citations/verify")
    def verify(body: VerifyIn):
        return lib.verify_citation(body.claim, body.chunk_id, body.quote)

    @app.post("/citations/suggest")
    def suggest(body: SuggestIn):
        """Candidate sources for a sentence the user wrote, already checked, best first."""
        return lib.suggest_citations(body.claim, body.doc_ids, body.limit)

    @app.post("/citations/resolve")
    def resolve(body: ResolveIn):
        """Current location of saved citations (null where the quote is gone), in input order."""
        return lib.resolve_citations([(i.doc_id, i.page, i.quote) for i in body.items])

    @app.post("/references")
    def references(body: ReferencesIn):
        return lib.references(body.doc_ids, body.style)

    @app.get("/settings")
    def get_settings():
        return lib.get_settings()

    @app.patch("/settings")
    def update_settings(body: dict):
        return lib.update_settings(body)

    @app.get("/settings/model")
    def get_model():
        return lib.model_settings()

    @app.put("/settings/model")
    def set_model(body: ModelIn):
        return lib.update_model(body.provider, body.api_key, body.reasoning_effort, body.route)

    @app.get("/settings/search")
    def get_search():
        return lib.search_settings()

    @app.put("/settings/search")
    def set_search(body: SearchIn):
        return lib.update_search(body.where, body.api_key, body.embed_model, body.rerank_model)

    @app.get("/settings/sources")
    def source_settings():
        return lib.source_settings()

    @app.put("/settings/sources")
    def set_sources(body: SourcesIn):
        """Set the CORE API key, checked with CORE first."""
        return lib.update_sources(body.core_api_key)

    @app.get("/documents/{doc_id}/file")
    def document_file(doc_id: int):
        path, media_type = lib.document_file(doc_id)
        return FileResponse(path, media_type=media_type)  # no filename: shown inline, not downloaded

    # ---------- literature review matrices ----------

    @app.get("/matrices")
    def list_matrices():
        return matrices.summaries()

    @app.get("/matrices/columns")
    def default_columns():
        return DEFAULT_COLUMNS

    @app.post("/matrices/papers")
    def matrix_papers(body: MatrixPapersIn):
        return matrices.papers_for(body.folder_id, body.topic)

    @app.post("/matrices")
    def create_matrix(body: MatrixIn):
        cols = [c.model_dump() for c in body.columns] if body.columns is not None else None
        return matrices.create(body.name, body.doc_ids, cols)

    @app.get("/matrices/{mid}")
    def get_matrix(mid: int):
        return matrices.get(mid)

    @app.patch("/matrices/{mid}")
    def update_matrix(mid: int, body: MatrixPatch):
        cols = [c.model_dump() for c in body.columns] if body.columns is not None else None
        return matrices.update(mid, body.name, cols, body.add_doc_ids, body.remove_doc_ids)

    @app.delete("/matrices/{mid}")
    def delete_matrix(mid: int):
        matrices.delete(mid)
        return {"ok": True}

    @app.put("/matrices/{mid}/cells/{doc_id}/{col}")
    def set_cell(mid: int, doc_id: int, col: str, body: CellIn):
        return matrices.set_cell(mid, doc_id, col, body.answer)

    @app.post("/matrices/{mid}/rerun")
    def rerun_matrix(mid: int, body: RerunIn):
        return matrices.rerun(mid, body.doc_id, body.column)

    @app.post("/matrices/{mid}/gaps")
    def matrix_gaps(mid: int):
        return matrices.gaps(mid)

    @app.post("/matrices/{mid}/synthesis")
    def matrix_synthesis(mid: int, body: SynthesisIn):
        return matrices.synthesis(mid, body.instruction, body.columns)

    @app.get("/matrices/{mid}/table")
    def matrix_table(mid: int, columns: str = ""):
        return matrices.table_doc(mid, [c for c in columns.split(",") if c] or None)

    @app.get("/matrices/{mid}/export")
    def export_matrix(mid: int, format: str = "xlsx", style: str = "apa"):
        data, media, ext = matrices.export(mid, format, style)
        return Response(data, media_type=media, headers={"Content-Disposition": f'attachment; filename="matrix.{ext}"'})

    @app.post("/export/docx")
    def export(body: ExportIn):
        data = export_docx(lib, body.content, body.style, body.title)
        return Response(data, media_type=DOCX_MIME, headers={"Content-Disposition": 'attachment; filename="draft.docx"'})

    @app.get("/drafts/{draft_id}")
    def get_draft(draft_id: int):
        return lib.get_draft(draft_id)

    @app.put("/drafts/{draft_id}")
    def save_draft(draft_id: int, body: DraftDocIn):
        return lib.save_draft(draft_id, body.title, body.content)

    @app.get("/drafts")
    def list_drafts():
        return lib.list_drafts()

    @app.post("/drafts")
    def create_draft(body: NewDraftIn):
        return lib.create_draft(body.title)

    def docx_bytes(body: ImportDocxIn) -> bytes:
        try:
            return base64.b64decode(body.data, validate=True)
        except ValueError as exc:
            raise ValueError("The file data wasn't valid base64") from exc

    @app.post("/drafts/import")
    def import_docx(body: ImportDocxIn):
        """Open a Word document as a new draft."""
        return lib.import_docx(body.filename, docx_bytes(body))

    @app.post("/drafts/convert-docx")
    def convert_docx(body: ImportDocxIn):
        """A Word document as editor content, saving nothing: for inserting it into the open draft."""
        return lib.convert_docx(body.filename, docx_bytes(body))

    @app.delete("/drafts/{draft_id}")
    def delete_draft(draft_id: int):
        lib.delete_draft(draft_id)
        return {"ok": True}

    @app.post("/drafts/check-duplicates")
    def check_duplicates(body: DuplicatesIn):
        """Repeated passages in the draft and passages matching library text closely."""
        return lib.check_duplicates(body.content)

    @app.get("/drafts/{draft_id}/versions")
    def list_versions(draft_id: int):
        return lib.list_versions(draft_id)

    @app.post("/drafts/{draft_id}/versions")
    def create_version(draft_id: int, body: VersionIn):
        return lib.create_version(draft_id, body.label, body.title, body.content)

    @app.get("/drafts/{draft_id}/versions/{version_id}")
    def get_version(draft_id: int, version_id: int):
        return lib.get_version(draft_id, version_id)

    @app.patch("/drafts/{draft_id}/versions/{version_id}")
    def rename_version(draft_id: int, version_id: int, body: VersionPatch):
        return lib.rename_version(draft_id, version_id, body.label)

    @app.delete("/drafts/{draft_id}/versions/{version_id}")
    def delete_version(draft_id: int, version_id: int):
        lib.delete_version(draft_id, version_id)
        return {"ok": True}

    @app.post("/drafts/{draft_id}/versions/{version_id}/compare")
    def compare_version(draft_id: int, version_id: int, body: CompareIn):
        """Changes from the version to the current draft (or another version), per document, section and paragraph."""
        return lib.compare_version(draft_id, version_id, body.content, body.against)

    @app.post("/drafts/{draft_id}/versions/{version_id}/restore")
    def restore_version(draft_id: int, version_id: int):
        return lib.restore_version(draft_id, version_id)

    return app


def __getattr__(name: str):
    # `uvicorn app.main:app` builds the app lazily, so importing this module (e.g. in
    # tests) doesn't open the real library database.
    if name == "app":
        globals()["app"] = create_app()
        return globals()["app"]
    raise AttributeError(name)
