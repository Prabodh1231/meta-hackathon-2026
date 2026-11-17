"""Papers stored by a path inside the data folder keep opening after that folder is renamed."""

import shutil

from app.library import Library
from app.providers import MockProvider
from app.settings import Settings
from tests.test_dupfiles import prose


def library(data_dir):
    return Library(Settings(data_dir=data_dir), provider=MockProvider())


def downloaded(lib, folder, name="okafor.md", seed=1):
    (folder / "papers").mkdir(parents=True, exist_ok=True)
    f = folder / "papers" / name
    f.write_text(prose(seed), encoding="utf-8")
    [res] = lib.ingest_path(str(f))
    assert res["ok"], res
    return res["document"]


def test_a_paper_in_the_renamed_data_folder_opens_again(tmp_path):
    old, new = tmp_path / "old-name", tmp_path / "new-name"
    lib = library(old)
    doc = downloaded(lib, old)
    lib.conn.close()
    shutil.move(old, new)  # what the desktop app does on the first start after the rename

    lib = library(new)
    assert lib._repair_moved_sources(legacy=old) == 1
    path, _ = lib.document_file(doc["id"])
    assert path == new / "papers" / "okafor.md"
    assert lib.find_duplicate_files()["missing"] == 0
    assert lib._repair_moved_sources(legacy=old) == 0  # nothing left to do on the next start


def test_paths_that_still_work_or_have_no_new_file_are_left_alone(tmp_path):
    old, new = tmp_path / "old-name", tmp_path / "new-name"
    lib = library(new)
    kept = downloaded(lib, old, "still-there.md", 1)  # its file is still in the old folder
    gone = downloaded(lib, old, "gone.md", 2)
    (old / "papers" / "gone.md").unlink()  # in neither folder

    assert lib._repair_moved_sources(legacy=old) == 0
    assert lib.get_document(kept["id"])["source"] == kept["source"]
    assert lib.get_document(gone["id"])["source"] == gone["source"]


def test_a_file_already_in_the_library_at_its_new_place_is_not_taken_twice(tmp_path):
    old, new = tmp_path / "old-name", tmp_path / "new-name"
    lib = library(new)
    stale = downloaded(lib, old)
    shutil.move(old / "papers" / "okafor.md", (new / "papers").mkdir(parents=True) or new / "papers" / "okafor.md")
    [res] = lib.ingest_path(str(new / "papers" / "okafor.md"))  # added again from where it is now

    assert lib._repair_moved_sources(legacy=old) == 0
    assert lib.get_document(stale["id"])["source"] == stale["source"]
    assert lib.get_document(res["document"]["id"])["source"] == str(new / "papers" / "okafor.md")
