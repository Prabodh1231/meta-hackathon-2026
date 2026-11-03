"""The search models shipped with the installer load from its folder instead of downloading."""
from app import embeddings, retrieval
from app.embeddings import EMBED_MODEL, bundled_model, make_embedder
from app.retrieval import DEFAULT_RERANKER, make_reranker
from app.settings import Settings


def shipped(models_dir, name):
    folder = models_dir / name.replace("/", "--")
    folder.mkdir(parents=True)
    (folder / "config.json").write_text("{}")
    return str(folder)


def test_a_model_is_used_from_the_installer_only_when_its_files_are_there(tmp_path):
    assert bundled_model(None, EMBED_MODEL) is None
    assert bundled_model(tmp_path, EMBED_MODEL) is None
    (tmp_path / "BAAI--bge-small-en-v1.5").mkdir()
    assert bundled_model(tmp_path, EMBED_MODEL) is None  # an empty folder: download instead
    (tmp_path / "BAAI--bge-small-en-v1.5" / "config.json").write_text("{}")
    assert bundled_model(tmp_path, EMBED_MODEL) == str(tmp_path / "BAAI--bge-small-en-v1.5")


def test_embedder_and_reranker_load_the_shipped_copies(tmp_path, monkeypatch):
    loaded = {}
    monkeypatch.setattr(embeddings, "FastEmbedder", lambda cache_dir, path=None: loaded.update(embed=path) or "e")
    monkeypatch.setattr(retrieval, "CrossEncoderReranker",
                        lambda cache_dir, model, path=None: loaded.update(rerank=path) or "r")
    models = tmp_path / "models"
    assert make_embedder("auto", tmp_path / "cache", models) == "e" and loaded["embed"] is None  # not shipped: download
    paths = {shipped(models, EMBED_MODEL), shipped(models, DEFAULT_RERANKER)}
    make_embedder("auto", tmp_path / "cache", models)
    make_reranker("auto", tmp_path / "cache", models_dir=models)
    assert {loaded["embed"], loaded["rerank"]} == paths


def test_the_models_folder_comes_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("RC_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("RC_MODELS_DIR", raising=False)
    assert Settings.from_env().models_dir is None
    monkeypatch.setenv("RC_MODELS_DIR", str(tmp_path / "models"))
    assert Settings.from_env().models_dir == tmp_path / "models"
