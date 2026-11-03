"""Fetch the search models the installer ships, so the app's first start needs no download and
works offline: bge-small (embeddings) and the MiniLM cross-encoder (reranking), each into
<out>/<org>--<name> as plain files (no Hugging Face cache layout, no symlinks). The backend
loads them from there when RC_MODELS_DIR points at <out> (Electron sets it when packaged).

Usage (npm run dist runs it): python scripts/fetch_models.py dist/models"""

import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastembed import TextEmbedding  # noqa: E402
from fastembed.rerank.cross_encoder import TextCrossEncoder  # noqa: E402

from app.embeddings import EMBED_MODEL, bundled_model  # noqa: E402
from app.retrieval import DEFAULT_RERANKER  # noqa: E402


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as cache:
        for load, name in ((TextEmbedding, EMBED_MODEL), (TextCrossEncoder, DEFAULT_RERANKER)):
            if bundled_model(out, name):
                print(f"{name}: already in {out}")
                continue
            model = load(model_name=name, cache_dir=cache)  # downloads into the temporary cache
            target = out / name.replace("/", "--")
            shutil.copytree(model.model._model_dir, target)  # copies files, not the cache's links
            size = sum(f.stat().st_size for f in target.rglob("*") if f.is_file()) / 1e6
            print(f"{name}: {size:.0f} MB in {target}")
    # The copies must load as the app will load them, without the network.
    TextEmbedding(model_name=EMBED_MODEL, specific_model_path=bundled_model(out, EMBED_MODEL))
    TextCrossEncoder(model_name=DEFAULT_RERANKER, specific_model_path=bundled_model(out, DEFAULT_RERANKER))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]).resolve())
