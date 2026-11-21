import os
import sqlite3
import time

from app.backup import FOLDER, backup_library
from app.library import Library
from app.providers.mock import MockProvider
from app.settings import Settings


def _library(tmp_path):
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider())
    lib.create_draft("Chapter 2")
    return lib


def test_no_library_means_no_backup(tmp_path):
    assert backup_library(tmp_path / "library.db") is None
    assert not (tmp_path / FOLDER).exists()


def test_backup_holds_what_the_library_held(tmp_path):
    lib = _library(tmp_path)  # still open, its changes in the write-ahead log
    made = backup_library(lib.settings.db_path)
    assert made and made.parent == lib.settings.data_dir / FOLDER
    copy = sqlite3.connect(made)
    assert [r[0] for r in copy.execute("SELECT title FROM drafts")] == ["Chapter 2"]
    assert copy.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    copy.close()


def test_one_backup_a_day(tmp_path):
    lib = _library(tmp_path)
    assert backup_library(lib.settings.db_path)
    assert backup_library(lib.settings.db_path) is None  # started again the same day
    assert len(list((lib.settings.data_dir / FOLDER).glob("library-*.db"))) == 1


def test_only_the_newest_are_kept(tmp_path):
    lib = _library(tmp_path)
    folder = lib.settings.data_dir / FOLDER
    folder.mkdir()
    old = time.time() - 5 * 86400
    for day in range(1, 5):
        f = folder / f"library-2026010{day}-090000.db"
        f.write_bytes(b"")
        os.utime(f, (old, old))
    (folder / "library-20260105-090000.partial").write_bytes(b"")  # a copy that never finished
    made = backup_library(lib.settings.db_path, keep=3)
    names = sorted(p.name for p in folder.iterdir())
    assert names == ["library-20260103-090000.db", "library-20260104-090000.db", made.name]


def test_backup_from_a_folder_whose_name_has_a_hash(tmp_path):
    folder = tmp_path / "lib#1 %20"  # Windows allows "#" and "%" in folder names, not "?"
    folder.mkdir()
    db = folder / "library.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE notes (a)")
    conn.commit()
    conn.close()
    made = backup_library(db)
    copy = sqlite3.connect(made)
    try:
        assert copy.execute("SELECT name FROM sqlite_master").fetchall() == [("notes",)]
    finally:
        copy.close()
    assert sorted(p.name for p in tmp_path.iterdir()) == [folder.name]  # no stray empty database beside it
