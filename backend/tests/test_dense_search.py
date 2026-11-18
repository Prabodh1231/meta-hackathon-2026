import numpy as np

from app.embeddings import DIM, HashEmbedder, device_of, pick_providers, to_blob
from app.library import Library
from app.providers import MockProvider
from app.settings import Settings

CORAL = "Reefs bleach when warm water stresses the coral and its algae."
SLEEP = "Replaying sounds in slow-wave sleep improved recall of word pairs."

# Which axis a word belongs to: the query shares no word with its passage, only a meaning.
MEANING = {"coral": 0, "reefs": 0, "ocean": 0, "heat": 0, "sleep": 1, "recall": 1, "memory": 1}


class MeaningEmbedder:
    """A stand-in for bge-small: words that mean the same thing share an axis."""

    id = "fake:meaning"
    device = "cpu"
    state = "ready"

    def __init__(self):
        self.calls = 0

    def embed(self, texts):
        self.calls += len(texts)
        out = np.zeros((len(texts), DIM), dtype=np.float32)
        for i, text in enumerate(texts):
            for word in text.lower().replace(".", "").split():
                if word in MEANING:
                    out[i, MEANING[word]] += 1
            out[i, 2] = 0.01  # never a zero vector
        return out / np.linalg.norm(out, axis=1, keepdims=True)

    def embed_query(self, text):
        return self.embed([text])[0]


def make_lib(tmp_path, embedder, files=(("coral.md", CORAL), ("sleep.md", SLEEP))):
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), embedder=embedder)
    for name, text in files:
        (tmp_path / name).write_text(text + "\n", encoding="utf-8")
        lib.ingest_path(str(tmp_path / name))
    return lib


def test_provider_choice_prefers_the_gpu_and_always_ends_on_the_cpu():
    assert pick_providers(["CPUExecutionProvider"]) == ["CPUExecutionProvider"]
    assert pick_providers(["CUDAExecutionProvider", "CPUExecutionProvider"]) == ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert pick_providers(["DmlExecutionProvider", "CPUExecutionProvider"])[0] == "DmlExecutionProvider"
    both = pick_providers(["DmlExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"])
    assert both == ["CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"]
    assert [device_of([p]) for p in ("CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider")] == ["cuda", "directml", "cpu"]


def test_chunks_are_embedded_at_ingest_and_dense_search_finds_a_meaning(tmp_path):
    lib = make_lib(tmp_path, MeaningEmbedder())
    assert lib.vector_status()["embedded"] == lib.vector_status()["chunks"] == 2
    query = "ocean heat"  # shares no word with the coral passage, so keyword search finds nothing
    assert lib.search(query, k=1, mode="keyword") == []
    top = lib.search(query, k=1, rerank=False)[0]
    assert "coral" in top["text"]


def test_dense_search_respects_a_document_scope(tmp_path):
    lib = make_lib(tmp_path, MeaningEmbedder())
    sleep_doc = next(d["id"] for d in lib.list_documents() if "sleep" in d["title"].lower() or d["source"].endswith("sleep.md"))
    hits = lib.search("ocean heat", k=5, doc_ids=[sleep_doc], rerank=False)
    assert hits and all(h["doc_id"] == sleep_doc for h in hits)


def test_a_library_without_vectors_is_backfilled_and_stale_ones_are_replaced(tmp_path):
    lib = make_lib(tmp_path, None)
    assert lib.vector_status()["state"] == "off" and lib.search("ocean heat", rerank=False) == []
    with lib.lock, lib.conn:  # a vector of another model's size, as left by an older version
        lib.conn.execute("UPDATE chunks SET embedding = ? WHERE id = (SELECT min(id) FROM chunks)", (to_blob(np.ones(10)),))
    lib.embedder = MeaningEmbedder()
    lib._backfill_vectors()
    status = lib.vector_status()
    assert status["embedded"] == status["chunks"] == 2
    assert "coral" in lib.search("ocean heat", k=1, rerank=False)[0]["text"]


def test_a_failing_model_never_loses_the_file_or_breaks_search(tmp_path):
    class Broken(MeaningEmbedder):
        def embed(self, texts):
            raise RuntimeError("no GPU, no model")

        def embed_query(self, text):
            raise RuntimeError("no GPU, no model")

    lib = make_lib(tmp_path, Broken())
    assert len(lib.list_documents()) == 2
    assert lib.vector_status()["embedded"] == 0
    assert "coral" in lib.search("coral reefs", k=1, rerank=False)[0]["text"]  # keyword search still answers


def test_search_waits_for_nothing_while_the_model_is_loading(tmp_path):
    class Loading(MeaningEmbedder):
        state = "loading"

    lib = make_lib(tmp_path, MeaningEmbedder())
    lib.embedder = Loading()
    assert lib.search("ocean heat", rerank=False) == []  # keywords only, and no call to the model
    assert lib.embedder.calls == 0


def test_hash_embedder_keeps_the_interface():
    e = HashEmbedder()
    assert e.embed(["a b c"]).shape == (1, 512) and e.embed_query("a b").shape == (512,)


class ReverseReranker:
    """Scores a passage higher the more it mentions the word 'second', so a test can see the order change."""

    state = "ready"
    device = "cpu"
    id = "fake:rerank"

    def rerank(self, query, texts):
        return [float(t.count("second")) for t in texts]


def test_the_local_reranker_orders_the_fused_candidates_and_failure_keeps_their_order(tmp_path):
    files = (("a.md", "Coral reefs bleach in warm water first."), ("b.md", "Coral reefs bleach in warm water second second."))
    lib = make_lib(tmp_path, None, files)
    plain = [h["text"] for h in lib.search("coral reefs warm water", k=2, rerank=True)]
    lib.reranker = ReverseReranker()
    reranked = [h["text"] for h in lib.search("coral reefs warm water", k=2, rerank=True)]
    assert "second second" in reranked[0]
    class Broken(ReverseReranker):
        def rerank(self, query, texts):
            raise RuntimeError("boom")
    lib.reranker = Broken()
    assert [h["text"] for h in lib.search("coral reefs warm water", k=2, rerank=True)] == plain
    class Loading(ReverseReranker):
        state = "loading"
    lib.reranker = Loading()
    assert [h["text"] for h in lib.search("coral reefs warm water", k=2, rerank=True)] == plain
