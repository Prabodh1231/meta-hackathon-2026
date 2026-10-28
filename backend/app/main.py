import logging

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .export_docx import export_docx
from .library import Library
from .parent_watch import exit_with_parent
from .settings import Settings

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)


class IngestPathIn(BaseModel):
    path: str


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


DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class DraftDocIn(BaseModel):
    title: str = "Untitled"
    content: str = ""


def create_app(settings: Settings | None = None, library: Library | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    if settings.parent_pid:
        exit_with_parent(settings.parent_pid)
    lib = library or Library(settings)
    app = FastAPI(title="Research Companion")
    app.state.library = lib

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
        return {"ok": True, "provider": lib.provider.name, "embedder": lib.embedder.id,
                "embedder_device": getattr(lib.embedder, "device", "cpu"),
                "reranker": lib.reranker.id if lib.reranker else None}

    @app.post("/ingest/path")
    def ingest_path(body: IngestPathIn):
        return {"results": lib.ingest_path(body.path)}

    @app.post("/ingest/url")
    def ingest_url(body: IngestUrlIn):
        return lib.ingest_url(body.url)

    @app.get("/documents")
    def list_documents():
        return lib.list_documents()

    @app.get("/documents/{doc_id}")
    def get_document(doc_id: int):
        return lib.get_document(doc_id)

    @app.patch("/documents/{doc_id}")
    def update_document(doc_id: int, body: DocumentPatch):
        return lib.update_document(doc_id, body.model_dump(exclude_unset=True))

    @app.delete("/documents/{doc_id}")
    def delete_document(doc_id: int):
        lib.delete_document(doc_id)
        return {"ok": True}

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
        return [lib.resolve_citation(i.doc_id, i.page, i.quote) for i in body.items]

    @app.post("/references")
    def references(body: ReferencesIn):
        return lib.references(body.doc_ids, body.style)

    @app.get("/settings")
    def get_settings():
        return lib.get_settings()

    @app.patch("/settings")
    def update_settings(body: dict):
        return lib.update_settings(body)

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

    return app


def __getattr__(name: str):
    # `uvicorn app.main:app` builds the app lazily, so importing this module (e.g. in
    # tests) doesn't open the real library database.
    if name == "app":
        globals()["app"] = create_app()
        return globals()["app"]
    raise AttributeError(name)
