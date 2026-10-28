import re

import numpy as np
import pytest

from app.library import MIN_DOCS_FOR_RELATIVE, UNCHECKED_CAP, Library
from app.providers import MockProvider
from app.settings import Settings

AXES = {"blockchain": 0, "financial_inclusion": 1, "digital_finance": 2}


class AxisEmbedder:
    """A folder name embeds to its own axis; a document written as `cos_blockchain=0.9` embeds
    with exactly that cosine to the folder's vector. Lets tests set how the first pass ranks papers."""

    id = "axis-test"

    def embed(self, texts):
        out = np.zeros((len(texts), 8), dtype=np.float32)
        for row, text in enumerate(texts):
            key = text.lower().replace(" ", "_")
            if key in AXES:  # a folder name
                out[row, AXES[key]] = 1.0
            for name, value in re.findall(r"cos_(\w+)=([\d.]+)", text):
                out[row, AXES[name]] = float(value)
        return out


class FakeMuse(MockProvider):
    """Reads the model's verdicts from the document as `fit_blockchain=80` (a percent), so tests
    decide exactly how Muse rates each paper. Records which folders it was asked about."""

    def __init__(self):
        self.asked = []  # one list of folder names per call
        self.fail = False

    def score_folders(self, title, summary, text, folders):
        if self.fail:
            raise RuntimeError("Muse is down")
        self.asked.append(list(folders))
        found = {k: int(v) for k, v in re.findall(r"fit_(\w+)=(\d+)", text)}
        return {f: found.get(f.lower().replace(" ", "_"), 0) for f in folders}


@pytest.fixture
def lib(tmp_path):
    return Library(Settings(data_dir=tmp_path / "data"), provider=FakeMuse(), embedder=AxisEmbedder())


def add(lib, tmp_path, name, text):
    f = tmp_path / name
    f.write_text(text, encoding="utf-8")
    [res] = lib.ingest_path(str(f))
    assert res["ok"], res
    return res["document"]


PAPER = "Stablecoins for the unbanked. fit_blockchain=80 fit_financial_inclusion=55 fit_digital_finance=30"


def names(doc):
    return [f["name"] for f in doc["folders"]]


def make(lib, name, similarity=50):
    lib.create_folder(name, similarity)
    return next(f["id"] for f in lib.list_folders() if f["name"] == name)


def many_papers(lib, tmp_path, close=4, far=6):
    """A library big enough for the first pass: `close` papers the embeddings put near the
    Blockchain folder and `far` they put away from it. Muse would rate every one of them 90."""
    docs = []
    for i in range(close):
        docs.append(add(lib, tmp_path, f"close{i}.txt", f"Paper {i} on ledgers. cos_blockchain=0.9 fit_blockchain=90"))
    for i in range(far):
        docs.append(add(lib, tmp_path, f"far{i}.txt", f"Paper {i} on sleep. cos_blockchain=0.1 fit_blockchain=90"))
    return docs


def test_default_similarity_is_fifty_percent(lib):
    lib.create_folder("Blockchain")
    assert lib.list_folders()[0]["similarity"] == 50


def test_a_paper_is_filed_in_every_folder_it_clears(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", PAPER)
    make(lib, "Blockchain")
    make(lib, "Financial Inclusion")
    make(lib, "Digital Finance")  # scores 30, under the 50% default
    assert names(lib.get_document(doc["id"])) == ["Blockchain", "Financial Inclusion"]


def test_threshold_is_inclusive(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", PAPER)
    make(lib, "Financial Inclusion", 55)
    assert names(lib.get_document(doc["id"])) == ["Financial Inclusion"]


def test_folders_reference_the_document_not_copy_it(lib, tmp_path):
    add(lib, tmp_path, "a.txt", PAPER)
    make(lib, "Blockchain")
    make(lib, "Financial Inclusion")
    assert lib.conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
    assert lib.conn.execute("SELECT COUNT(*) FROM doc_folders").fetchone()[0] == 2


def test_new_folder_scores_papers_already_in_the_library(lib, tmp_path):
    add(lib, tmp_path, "a.txt", PAPER)
    add(lib, tmp_path, "b.txt", "A paper on sleep. fit_blockchain=10")
    make(lib, "Blockchain")
    assert [f["doc_count"] for f in lib.list_folders()] == [1]


def test_papers_added_later_are_filed_into_existing_folders(lib, tmp_path):
    make(lib, "Blockchain")
    doc = add(lib, tmp_path, "a.txt", PAPER)
    assert names(doc) == ["Blockchain"]


def test_moving_the_threshold_refiles_without_asking_anything_again(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", PAPER)
    fid = make(lib, "Financial Inclusion")
    calls = len(lib.provider.asked)
    lib.update_folder(fid, similarity=60)
    assert names(lib.get_document(doc["id"])) == []
    lib.update_folder(fid, similarity=40)
    assert names(lib.get_document(doc["id"])) == ["Financial Inclusion"]
    assert len(lib.provider.asked) == calls


def test_a_small_library_is_read_by_the_model_in_full(lib, tmp_path):
    for i in range(MIN_DOCS_FOR_RELATIVE - 1):
        add(lib, tmp_path, f"{i}.txt", f"Paper {i}. fit_blockchain=70")
    make(lib, "Blockchain")
    assert len(lib.provider.asked) == MIN_DOCS_FOR_RELATIVE - 1


def test_only_papers_the_embeddings_rank_above_average_go_to_the_model(lib, tmp_path):
    many_papers(lib, tmp_path)
    make(lib, "Blockchain")
    assert len(lib.provider.asked) == 4  # the 4 close papers; the 6 far ones were never sent
    assert lib.list_folders()[0]["doc_count"] == 4


def test_papers_the_model_never_saw_stay_below_the_cap(lib, tmp_path):
    docs = many_papers(lib, tmp_path)
    make(lib, "Blockchain")
    far = [d for d in docs if d["title"] != "" and "far" in d["source"]]
    scores = [lib.conn.execute("SELECT score FROM folder_scores WHERE doc_id = ?", (d["id"],)).fetchone()[0] for d in far]
    assert len(scores) == 6 and all(s <= UNCHECKED_CAP for s in scores)


def test_when_the_model_fails_the_embedding_ranking_files_the_papers(lib, tmp_path):
    many_papers(lib, tmp_path)
    lib.provider.fail = True
    make(lib, "Blockchain")
    assert lib.list_folders()[0]["doc_count"] == 4


def test_scores_blend_the_closest_chunks_with_the_whole_paper():
    # One chunk at 0.9 among four: the three closest average 0.3, the whole paper 0.225.
    sims = np.array([[0.9], [0.0], [0.0], [0.0]])
    assert Library._blend(sims)[0] == pytest.approx(0.2625)
    # A paper that is on the subject throughout scores as high as its chunks do.
    assert Library._blend(np.full((6, 1), 0.7))[0] == pytest.approx(0.7)


def test_a_match_the_user_removed_stays_out(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", PAPER)
    fid = make(lib, "Blockchain")
    lib.set_folder_membership(doc["id"], fid, False)
    assert names(lib.get_document(doc["id"])) == []
    lib.update_folder(fid, similarity=10)
    assert names(lib.classify_document(doc["id"])) == []
    assert lib.list_folders()[0]["doc_count"] == 0


def test_a_paper_the_user_added_stays_when_the_threshold_rises(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", PAPER)
    fid = make(lib, "Digital Finance")  # scores 30: not filed
    doc = lib.set_folder_membership(doc["id"], fid, True)
    assert doc["folders"][0]["state"] == "user"
    lib.update_folder(fid, similarity=90)
    assert names(lib.classify_document(doc["id"])) == ["Digital Finance"]


def test_filed_papers_carry_their_score(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", PAPER)
    make(lib, "Blockchain")
    assert lib.get_document(doc["id"])["folders"][0]["score"] == 80


def test_add_by_name_is_case_insensitive_and_needs_an_existing_folder(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", PAPER)
    make(lib, "Digital Finance")
    assert names(lib.add_to_folder_named(doc["id"], "digital finance")) == ["Digital Finance"]
    with pytest.raises(LookupError):
        lib.add_to_folder_named(doc["id"], "Nope")


def test_renaming_a_folder_scores_it_again_as_a_new_subject(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", PAPER)
    fid = make(lib, "Digital Finance")
    assert names(lib.get_document(doc["id"])) == []
    lib.update_folder(fid, name="Blockchain")
    assert names(lib.get_document(doc["id"])) == ["Blockchain"]


def test_rename_to_an_existing_name_is_refused(lib):
    make(lib, "Blockchain")
    fid = make(lib, "Digital Finance")
    with pytest.raises(ValueError):
        lib.update_folder(fid, name="blockchain")
    with pytest.raises(ValueError):
        lib.create_folder("BLOCKCHAIN")


def test_delete_folder_keeps_documents(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", PAPER)
    fid = make(lib, "Blockchain")
    lib.delete_folder(fid)
    assert lib.list_folders() == []
    assert lib.get_document(doc["id"])["folders"] == []
    assert lib.conn.execute("SELECT COUNT(*) FROM folder_scores").fetchone()[0] == 0


def test_similarity_must_be_a_percentage(lib):
    for bad in (-1, 101):
        with pytest.raises(ValueError):
            lib.create_folder("X", bad)


def test_placements_from_before_scores_were_kept_survive_until_rescored(lib, tmp_path):
    doc = add(lib, tmp_path, "a.txt", PAPER)
    other = make(lib, "Digital Finance")
    legacy = make(lib, "Blockchain")
    lib.conn.execute("DELETE FROM folder_scores")  # as if both folders predate stored scores
    lib.conn.execute("INSERT OR REPLACE INTO doc_folders (doc_id, folder_id, state) VALUES (?, ?, 'auto')", (doc["id"], other))
    lib.update_folder(legacy, similarity=50)  # scores the gap and re-files
    assert names(lib.get_document(doc["id"])) == ["Blockchain", "Digital Finance"]
    lib.classify_all()  # a full re-sort scores everything, so the 30% placement now goes
    assert names(lib.get_document(doc["id"])) == ["Blockchain"]
